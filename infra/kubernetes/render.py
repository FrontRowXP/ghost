"""Render credential-free Gather resources; project secrets separately from OpenBao."""
import argparse
import ipaddress
import json
import re


def render(namespace, hostname, image, database_host, redis_host, storage_host, nodes):
    if not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', image):
        raise ValueError('An immutable image digest is required')
    objects = []
    def resource(api, kind, name, **fields):
        item = {'apiVersion': api, 'kind': kind, 'metadata': {'name': name, 'namespace': namespace}, **fields}
        objects.append(item)
        return item
    resource('v1', 'Namespace', namespace)['metadata'] = {'name': namespace, 'labels': {'app.kubernetes.io/part-of': 'gather'}}
    security = {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000, 'fsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'}}
    csecurity = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
    affinity = {'nodeAffinity': {'requiredDuringSchedulingIgnoredDuringExecution': {'nodeSelectorTerms': [{'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': nodes}]}]}}}
    for name, replicas, port in [('gather', 1, 2368), ('gather-assets', 2, 8080)]:
        labels = {'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'gather'}
        core = name == 'gather'
        filename = 'config.production.json' if core else 'assets.json'
        config_path = '/home/ghost/'+filename if core else '/config/'+filename
        container = {'name': name, 'image': image, 'securityContext': csecurity, 'ports': [{'name': 'http', 'containerPort': port}],
            'resources': {'requests': {'cpu': '100m', 'memory': '256Mi'}, 'limits': {'cpu': '2', 'memory': '2Gi'}},
            'env': [{'name': 'NODE_ENV', 'value': 'production'}, {'name': 'GATHER_REQUIRE_POSTGRES', 'value': 'true'}],
            'volumeMounts': [{'name': 'tmp', 'mountPath': '/tmp'}, {'name': 'config', 'mountPath': config_path, 'subPath': filename, 'readOnly': True}],
            'livenessProbe': {'tcpSocket': {'port': 'http'}, 'initialDelaySeconds': 60, 'periodSeconds': 20}}
        if core:
            container['env'].append({'name': 'GATHER_REQUIRE_ORIGIN', 'value': 'true'})
            container['volumeMounts'] += [{'name': 'content', 'mountPath': '/home/ghost/content'}, {'name': 'content', 'mountPath': '/home/ghost/content/themes', 'subPath': 'themes', 'readOnly': True}]
            container['readinessProbe'] = {'exec': {'command': ['node', 'scripts/gather-ready.mjs']}, 'periodSeconds': 10, 'timeoutSeconds': 5}
            container['startupProbe'] = {'tcpSocket': {'port': 'http'}, 'failureThreshold': 60, 'periodSeconds': 5}
        else:
            container['command'] = ['node', 'scripts/gather-assets.mjs']
            container['env'].append({'name': 'GATHER_RUNTIME_CONFIG', 'value': config_path})
            container['readinessProbe'] = {'httpGet': {'path': '/healthz', 'port': 'http'}, 'periodSeconds': 15, 'timeoutSeconds': 5}
        pod = {'automountServiceAccountToken': False, 'securityContext': security, 'affinity': affinity,
            'terminationGracePeriodSeconds': 75, 'imagePullSecrets': [{'name': 'gather-registry'}], 'containers': [container],
            'volumes': [{'name': 'tmp', 'emptyDir': {'sizeLimit': '1Gi'}}, {'name': 'config', 'secret': {'secretName': 'gather-runtime' if core else 'gather-assets', 'defaultMode': 288}}]}
        if core:
            pod['volumes'].append({'name': 'content', 'emptyDir': {'sizeLimit': '1Gi'}})
            pod['initContainers'] = [{'name': 'bundled-content', 'image': image, 'securityContext': csecurity, 'command': ['sh', '-ec', 'cp -R /home/ghost/base_content/. /content/'], 'volumeMounts': [{'name': 'content', 'mountPath': '/content'}], 'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '1', 'memory': '256Mi'}}}]
        resource('apps/v1', 'Deployment', name, spec={'replicas': replicas, 'strategy': {'type': 'Recreate'} if core else {'type': 'RollingUpdate'}, 'selector': {'matchLabels': labels}, 'template': {'metadata': {'labels': labels}, 'spec': pod}})
        resource('v1', 'Service', name, spec={'selector': labels, 'ports': [{'name': 'http', 'port': port, 'targetPort': 'http'}]})
    ingress = resource('networking.k8s.io/v1', 'Ingress', 'gather', spec={'ingressClassName': 'public', 'tls': [{'hosts': [hostname], 'secretName': 'gather-origin-tls'}], 'rules': [{'host': hostname, 'http': {'paths': [{'path': '/_assets/', 'pathType': 'Prefix', 'backend': {'service': {'name': 'gather-assets', 'port': {'number': 8080}}}}, {'path': '/', 'pathType': 'Prefix', 'backend': {'service': {'name': 'gather', 'port': {'number': 2368}}}}]}}]})
    ingress['metadata']['annotations'] = {'traefik.ingress.kubernetes.io/router.entrypoints': 'websecure', 'traefik.ingress.kubernetes.io/router.tls': 'true'}
    external = []
    for host, ports in [(database_host, [5432]), (redis_host, [6379]), (storage_host, [9000])]:
        external.append({'to': [{'ipBlock': {'cidr': str(ipaddress.ip_address(host))+'/32'}}], 'ports': [{'protocol': 'TCP', 'port': port} for port in ports]})
    resource('networking.k8s.io/v1', 'NetworkPolicy', 'gather', spec={'podSelector': {}, 'policyTypes': ['Ingress', 'Egress'], 'ingress': [{'from': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'ingress'}}}, {'podSelector': {}}]}], 'egress': [{'to': [{'podSelector': {}}]}, {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}}}], 'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}, *external, {'to': [{'ipBlock': {'cidr': '0.0.0.0/0'}}], 'ports': [{'protocol': 'TCP', 'port': 443}, {'protocol': 'TCP', 'port': 465}]}]})
    return {'apiVersion': 'v1', 'kind': 'List', 'items': objects}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for argument in ['namespace', 'hostname', 'image', 'database-host', 'redis-host', 'storage-host']:
        parser.add_argument('--'+argument, required=True)
    parser.add_argument('--nodes', nargs='+', required=True)
    print(json.dumps(render(**vars(parser.parse_args()))))
