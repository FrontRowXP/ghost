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
