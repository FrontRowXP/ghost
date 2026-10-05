import copy
import unittest
from frontro_origins import EXPECTED, command, patch

class OriginTests(unittest.TestCase):
    def fixture(self):
        return {'metadata': {'resourceVersion': '17', 'generation': 2},
                'spec': {'replicas': 2, 'template': {'spec': {'containers': [{'name': 'api', 'command': EXPECTED[:] }]}}},
                'status': {'observedGeneration': 2, 'replicas': 2, 'updatedReplicas': 2, 'availableReplicas': 2}}
    def test_preserves_credential_launcher_and_only_patches_command(self):
        d = self.fixture(); original = copy.deepcopy(d)
        operations = patch(d, ['https://gather.frontro.com'])
        self.assertEqual(d, original)
        self.assertEqual(operations[-1]['value'][:2], EXPECTED[:2])
        self.assertEqual(operations[-1]['path'], '/spec/template/spec/containers/0/command')
        self.assertEqual(operations[0]['op'], 'test')
    def test_refuses_overlapping_rollout_or_unrecognized_launcher(self):
        d = self.fixture(); d['status']['updatedReplicas'] = 1
        with self.assertRaises(RuntimeError): patch(d, ['https://gather.frontro.com'])
        d = self.fixture(); d['status']['replicas'] = 3
        with self.assertRaises(RuntimeError): patch(d, ['https://gather.frontro.com'])
        d = self.fixture(); d['spec']['template']['spec']['containers'][0]['command'] = ['other']
        with self.assertRaises(RuntimeError): patch(d, ['https://gather.frontro.com'])
    def test_rejects_paths_fragments_and_shell_like_origins(self):
        for origin in ['http://gather.frontro.com', 'https://gather.frontro.com/ghost/', 'https://gather.frontro.com/#signin', 'https://gather.frontro.com/$(false)', 'https://x";false;"']:
            with self.assertRaises(ValueError): command([origin])
