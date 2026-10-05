"""Add reviewed Gather browser origins after the existing OpenBao launcher."""
import argparse
import json
import re
import shlex
import subprocess
from urllib.parse import urlsplit

EXPECTED = ['/bin/sh', '/openbao/launcher/launch.sh',
            '/app/bin/moments-runtime-configuration', '--launch-api']

def command(origins):
    for origin in origins:
        u = urlsplit(origin)
        if not re.fullmatch(r'https://[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?', origin) or u.scheme != 'https' or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
            raise ValueError('Expected an exact HTTPS origin')
    lines = ['set -eu']
    for origin in origins:
        quoted = shlex.quote(',' + origin + ',')
        lines.append('case ",$MOMENTS_ALLOWED_ORIGINS," in *' + quoted + '*) ;; *) MOMENTS_ALLOWED_ORIGINS="${MOMENTS_ALLOWED_ORIGINS},' + origin + '" ;; esac')
    lines += ['export MOMENTS_ALLOWED_ORIGINS', 'exec /app/bin/moments-runtime-configuration --launch-api']
    return EXPECTED[:2] + ['/bin/sh', '-c', '\n'.join(lines)]

def patch(deployment, origins):
    spec = deployment['spec']
    status = deployment['status']
    if (status.get('observedGeneration') != deployment['metadata']['generation']
            or status.get('updatedReplicas') != spec['replicas']
            or status.get('availableReplicas', 0) < spec['replicas']):
        raise RuntimeError('An API rollout is already in progress; wait before changing configuration')
    containers = spec['template']['spec']['containers']
    index = next(i for i, c in enumerate(containers) if c['name'] == 'api')
    desired = command(origins)
    current = containers[index].get('command')
    if current == desired:
        return []
    if current != EXPECTED:
        raise RuntimeError('Unexpected API launcher; review its ownership before changing it')
    path = f'/spec/template/spec/containers/{index}/command'
    return [{'op': 'test', 'path': '/metadata/resourceVersion', 'value': deployment['metadata']['resourceVersion']},
            {'op': 'test', 'path': path, 'value': current},
            {'op': 'replace', 'path': path, 'value': desired}]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kubectl', default='kubectl')
    parser.add_argument('--namespace', default='moments-direct')
    parser.add_argument('--origin', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    kube = [args.kubectl, '-n', args.namespace]
    deployment = json.loads(subprocess.check_output(kube + ['get', 'deployment', 'moments-api', '-o', 'json']))
    operations = patch(deployment, args.origin)
    if not operations:
        print('Gather origins already configured')
    elif args.apply:
        subprocess.run(kube + ['patch', 'deployment', 'moments-api', '--type=json', '-p', json.dumps(operations)], check=True)
    else:
        print(json.dumps(operations, indent=2))

if __name__ == '__main__':
    main()
