import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('resources', Path(__file__).parents[1]/'kubernetes/render.py')
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)

class TenancyResources(unittest.TestCase):
    def test_eight_sites_reuse_the_same_deployments_but_reserve_sufficient_memory(self):
        manifest = resources.render('gather-staging', 'gather-stage.frontro.com', 'registry/gather@sha256:'+'a'*64,
                                    '192.0.2.1', '192.0.2.2', '192.0.2.3', ['worker'], True, 'gather-stage.frontro.com', 8)
        deployments = [item for item in manifest['items'] if item['kind'] == 'Deployment']
        self.assertEqual(len(deployments), 2)
        core = next(item for item in deployments if item['metadata']['name'] == 'gather')
        container = core['spec']['template']['spec']['containers'][0]
        self.assertEqual(container['command'], ['node', 'index.js', 'shared-tenancy'])
        self.assertGreaterEqual(int(container['resources']['limits']['memory'][:-2]), 6400)
        self.assertFalse(any(item['kind'] in ['StatefulSet', 'PersistentVolumeClaim'] for item in manifest['items']))

    def test_unbounded_capacity_is_rejected_before_rendering(self):
        with self.assertRaises(ValueError):
            resources.render('gather', 'gather.frontro.com', 'registry/gather@sha256:'+'a'*64,
                             '192.0.2.1', '192.0.2.2', '192.0.2.3', ['worker'], True, 'frontro.com', 100)
