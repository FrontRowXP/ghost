import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watch', Path(__file__).with_name('watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
SHA = 'a' * 40
OLD = 'b' * 40


class QualificationGate(unittest.TestCase):
    def test_failed_staging_rollout_restores_its_image_without_changing_production(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            acceptance = root/'acceptance.json'
            acceptance.write_text(json.dumps({'postgresCheckDatabase': {}}))
            (root/'image-metadata.json').write_text(json.dumps({'containerimage.digest': 'sha256:'+SHA[:32]*2}))
            config = {'repository': 'fixture', 'node_bin': '/fixture/node', 'registry_config': '/fixture/registry',
                'acceptance_config': str(acceptance), 'image_repository': 'fixture', 'buildkit_address': 'fixture',
                'kubectl': 'fixture-kube', 'kubeconfig': '/fixture/kube', 'staging': {'namespace': 'fixture-stage'},
                'production': {'namespace': 'fixture-production'}, 'production_enabled': True}
            previous = 'fixture@sha256:'+OLD[:32]*2
            calls = []
            build_environments = []
            failed = False
            def operation(args, **kwargs):
                nonlocal failed
                calls.append(args)
                if args[0] == 'pnpm': build_environments.append(kwargs['env'])
                if 'get' in args and 'deployment/gather' in args:
                    return previous
                if 'rollout' in args and 'fixture-stage' in args and not failed:
                    failed = True
                    raise RuntimeError('staging image unreadable')
                return None
            with patch.object(watch, 'run', side_effect=operation):
                with self.assertRaisesRegex(RuntimeError, 'staging image unreadable'):
                    watch.promote(config, root, SHA, {})
            self.assertTrue(build_environments)
            for env in build_environments:
                self.assertEqual(env['XDG_CONFIG_HOME'], str(root/'cache/config'))
            updates = [args for args in calls if 'set' in args and 'image' in args]
            self.assertTrue(any('gather='+previous in args for args in updates))
            self.assertTrue(any('gather-assets='+previous in args for args in updates))
            self.assertFalse(any('fixture-production' in args for args in updates))

    def test_failed_ci_never_reaches_build_or_deployment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root/'config.json'
            config.write_text(json.dumps({'workspace': str(root/'work'), 'repository': 'fixture',
                'github_cli': 'fixture-gh', 'github_repository': 'fixture/repo'}))
            config.chmod(0o600)
            ci = json.dumps([{'headSha': SHA, 'event': 'push', 'status': 'completed', 'conclusion': 'failure'}])
            with patch.object(sys, 'argv', ['watch', '--config', str(config)]), patch.object(watch, 'run', side_effect=[SHA+'\trefs/heads/main', ci]), patch.object(watch, 'promote') as promote:
                watch.main()
                promote.assert_not_called()
            state = json.loads((root/'work/state.json').read_text())
            self.assertEqual(state['failed_sha'], SHA)

    def test_failed_qualification_preserves_previous_production_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); work = root/'work'; work.mkdir()
            previous = {'deployed_sha': OLD, 'image': 'fixture@sha256:'+OLD*2}
            (work/'state.json').write_text(json.dumps(previous))
            config = root/'config.json'
            config.write_text(json.dumps({'workspace': str(work), 'repository': 'fixture',
                'github_cli': 'fixture-gh', 'github_repository': 'fixture/repo'})); config.chmod(0o600)
            ci = json.dumps([{'headSha': SHA, 'event': 'push', 'status': 'completed', 'conclusion': 'success'}])
            with patch.object(sys, 'argv', ['watch', '--config', str(config)]), patch.object(watch, 'run', side_effect=[SHA+'\trefs/heads/main', ci]), patch.object(watch, 'promote', side_effect=RuntimeError('qualification failure')):
                with self.assertRaisesRegex(RuntimeError, 'qualification failure'): watch.main()
            state = json.loads((work/'state.json').read_text())
            self.assertEqual(state['deployed_sha'], OLD)
            self.assertEqual(state['image'], previous['image'])
            self.assertEqual(state['failed_sha'], SHA)


if __name__ == '__main__':
    unittest.main()
