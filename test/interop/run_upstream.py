"""Run upstream library assertions unchanged against the TypeScript implementation."""
import importlib.util
import os
from pathlib import Path
import sys
import unittest

import python_adapter

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "test/vendor/bagit-python"
sys.modules["bagit"] = python_adapter
spec = importlib.util.spec_from_file_location("upstream_tests", VENDOR / "test.py")
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)

# These check Python multiprocessing.Pool lifecycle, which does not exist in Node.
EXCLUDED = {
    "test_make_bag_multiprocessing_terminates_and_joins_pool_on_failure",
    "test_validate_multiprocessing_terminates_and_joins_pool_on_failure",
    "test_validate_pool_error",
}

suite = unittest.TestSuite()
for cls in (upstream.TestSingleProcessValidation, upstream.TestMultiprocessValidation, upstream.TestBag, upstream.TestFetch):
    for name in unittest.defaultTestLoader.getTestCaseNames(cls):
        if name not in EXCLUDED:
            suite.addTest(cls(name))

# Upstream resolves its fixtures relative to the working directory.
os.chdir(VENDOR)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
