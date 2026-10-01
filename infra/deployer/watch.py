"""Build and promote an exact checked main SHA from the trusted infrastructure."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess


def run(args, *, cwd=None, capture=False, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None, text=True)
    return result.stdout if capture else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--retry', action='store_true')
    args = parser.parse_args()
    config_path = Path(args.config)
    if config_path.stat().st_mode & 0o077:
        raise RuntimeError('Operator configuration must be private')
    config = json.loads(config_path.read_text())
    root = Path(config['workspace'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root/'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_path = root/'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        sha = run(['git', 'ls-remote', config['repository'], 'refs/heads/main'], capture=True).split()[0]
        if not re.fullmatch('[0-9a-f]{40}', sha):
            raise RuntimeError('Main did not resolve to a full commit SHA')
        if sha == state.get('deployed_sha') or (sha in (state.get('failed_sha'), state.get('commissioning_pending_sha')) and not args.retry):
            return
        runs = json.loads(run([config['github_cli'], 'run', 'list', '-R', config['github_repository'],
            '--workflow', 'gather.yml', '--branch', 'main', '--commit', sha, '--limit', '5',
            '--json', 'databaseId,headSha,status,conclusion,event'], capture=True))
        matching = [r for r in runs if r['headSha'] == sha and r['event'] == 'push']
        if not matching:
            print('Waiting for main CI to start', sha, flush=True)
            return
        ci = matching[0]
        if ci['status'] != 'completed':
            run([config['github_cli'], 'run', 'watch', str(ci['databaseId']), '-R', config['github_repository'], '--exit-status', '--interval', '60'])
        elif ci['conclusion'] != 'success':
            print('Main CI failed; keeping the current deployment', sha, flush=True)
            state['failed_sha'] = sha
            state_path.write_text(json.dumps(state))
            return
        try:
            if promote(config, root, sha, state):
                state['deployed_sha'] = sha
                state.pop('commissioning_pending_sha', None)
            else:
                state['commissioning_pending_sha'] = sha
            state.pop('failed_sha', None)
        except Exception:
            state['failed_sha'] = sha
            raise
        finally:
            state_path.write_text(json.dumps(state))
            state_path.chmod(0o600)


def promote(config, root, sha, state):
    checkout = root/'source'
    if not checkout.exists():
        run(['git', 'clone', config['repository'], str(checkout)])
    run(['git', 'fetch', 'origin', 'main'], cwd=checkout)
    run(['git', 'checkout', '--detach', sha], cwd=checkout)
    run(['git', 'submodule', 'update', '--init', '--recursive'], cwd=checkout)
    env = os.environ.copy()
    env.update({'PATH': config['node_bin']+':'+env['PATH'], 'COREPACK_HOME': str(root/'cache/corepack'),
        'XDG_CACHE_HOME': str(root/'cache'), 'npm_config_store_dir': str(root/'cache/pnpm-store'), 'TMPDIR': str(root/'tmp'),
        'GNUPGHOME': str(root/'gpg'), 'NX_DAEMON': 'false', 'NX_NATIVE_COMMAND_RUNNER': 'false', 'NX_PARALLEL': '2'})
    (root/'tmp').mkdir(exist_ok=True)
    (root/'gpg').mkdir(mode=0o700, exist_ok=True)
    run(['pnpm', 'bootstrap'], cwd=checkout, env=env)
    run(['pnpm', '--filter-prod', 'ghost^...', '-r', 'run', 'build'], cwd=checkout, env=env)
    core = checkout/'ghost/core'
    run(['pnpm', 'exec', 'vitest', 'run', 'test/unit/shared/config/utils.test.js', 'test/unit/server/models/post.test.js', '--maxWorkers=2'], cwd=core, env=env)
    run(['node', '--test', 'scripts/gather-assets.test.mjs'], cwd=core, env=env)
    run(['pnpm', 'build:production'], cwd=checkout, env=env)
    acceptance_config = json.loads(Path(config['acceptance_config']).read_text())
    pg_env = {**env, 'NODE_ENV': 'production', 'GATHER_REQUIRE_POSTGRES': 'true',
        'database': json.dumps(acceptance_config['postgresCheckDatabase'])}
    run(['node', 'scripts/verify-postgres.mjs'], cwd=core, env=pg_env)
    metadata = root/'image-metadata.json'
    env['DOCKER_CONFIG'] = config['registry_config']
    image_tag = config['image_repository']+':'+sha
    run(['sudo', '-n', 'env', 'DOCKER_CONFIG='+env['DOCKER_CONFIG'], 'buildctl', '--addr', config['buildkit_address'],
        'build', '--frontend', 'dockerfile.v0', '--local', 'context='+str(checkout), '--local', 'dockerfile='+str(checkout),
        '--opt', 'filename=Dockerfile.production', '--opt', 'target=full', '--opt', 'build-arg:GHOST_BUILD_VERSION='+sha,
        '--output', 'type=image,name='+image_tag+',push=true', '--metadata-file', str(metadata)], env=env)
    digest = json.loads(metadata.read_text())['containerimage.digest']
    if not re.fullmatch('sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('BuildKit returned an invalid image digest')
    image = config['image_repository']+'@'+digest
    kube = [config['kubectl'], '--kubeconfig', config['kubeconfig']]
    def deploy(lane, target):
        ns = config[lane]['namespace']
        run([*kube, '-n', ns, 'set', 'image', 'deployment/gather', 'gather='+target, 'bundled-content='+target])
        run([*kube, '-n', ns, 'set', 'image', 'deployment/gather-assets', 'gather-assets='+target])
        for name in ['gather', 'gather-assets']:
            run([*kube, '-n', ns, 'rollout', 'status', 'deployment/'+name, '--timeout=300s'])
    previous = state.get('image') or run([*kube, '-n', config['production']['namespace'], 'get', 'deployment/gather', '-o', 'jsonpath={.spec.template.spec.containers[0].image}'], capture=True)
    deploy('staging', image)
    run([config['node_bin']+'/node', str(checkout/'infra/deployer/acceptance.mjs'), '--config', str(Path(config['acceptance_config'])), '--lane', 'staging'], cwd=core, env=env)
    state['staging_sha'] = sha
    state['staging_image'] = image
    if not config.get('production_enabled', False):
        print('Staging qualified; production commissioning is pending', sha, flush=True)
        return False
    run([config['node_bin']+'/node', str(checkout/'infra/deployer/backup.mjs'), config['acceptance_config']], cwd=core, env=env)
    try:
        deploy('production', image)
        run([config['node_bin']+'/node', str(checkout/'infra/deployer/acceptance.mjs'), '--config', str(Path(config['acceptance_config'])), '--lane', 'production'], cwd=core, env=env)
    except Exception:
        if previous:
            deploy('production', previous)
            print('Production rolled back to the previous image; database restore was not attempted.', flush=True)
        raise
    state['image'] = image
    print('Gather release promoted', sha, digest, flush=True)
    return True


if __name__ == '__main__':
    main()
