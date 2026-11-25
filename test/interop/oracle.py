"""Independent Python reference and stdlib ZIP reader for interoperability tests."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch
import zipfile

reference = Path(__file__).resolve().parents[1] / "vendor/bagit-python/reference.py"
spec = importlib.util.spec_from_file_location("bagit_reference", reference)
bagit = importlib.util.module_from_spec(spec)
with patch("importlib.metadata.version", return_value="1.5.4"):
    spec.loader.exec_module(bagit)

request = json.load(sys.stdin)
action = request["action"]
if action == "make":
    bag = bagit.make_bag(request["path"], bag_info=request.get("info"), checksums=request.get("checksums"))
elif action == "zip":
    with zipfile.ZipFile(request["path"]) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"CRC failure for {bad}")
        archive.extractall(request["destination"])
        names = archive.namelist()
    bag = bagit.Bag(os.path.join(request["destination"], request.get("bagName", "")))
else:
    bag = bagit.Bag(request["path"])
try:
    valid = bag.validate(**request.get("options", {}))
    result = {"valid": valid, "info": bag.info, "entries": bag.entries, "algorithms": sorted(bag.algorithms)}
except bagit.BagError as error:
    result = {"valid": False, "error": str(error), "details": [str(e) for e in getattr(error, "details", [])]}
if action == "zip":
    result["names"] = names
print(json.dumps(result))
