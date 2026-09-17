import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('providers', Path(__file__).parents[1] / 'scripts/visibility-providers.py')
providers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(providers)


class ProviderTest(unittest.TestCase):
    def test_missing_credentials_do_not_become_zero(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            records = providers.run(Path(tmp))
            self.assertTrue(all(r['status'] == 'BLOCKED' for r in records))
            self.assertTrue(all('metrics' not in r for r in records))

    def test_failure_redaction_and_no_field_data(self):
        with (tempfile.TemporaryDirectory() as tmp, patch.object(providers, 'gsc', side_effect=RuntimeError('SECRET')),
             patch.object(providers, 'bing', return_value={'rows': []}),
             patch.object(providers, 'crux', side_effect=ValueError('HTTP_404'))):
            records = providers.run(Path(tmp))
            self.assertEqual([r['status'] for r in records], ['ERROR', 'OBSERVED', 'NO_DATA'])
            self.assertNotIn('SECRET', (Path(tmp) / 'providers.json').read_text())


if __name__ == '__main__':
    unittest.main()
