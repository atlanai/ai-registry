#!/usr/bin/env python3
"""Exercise check_schemas.py's native-file tier on a copy of the acme example registry."""

import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
MODEL = Path("artifacts", "engineering", "semantic_model", "review-metrics", "1.0.0", "semantic_model.yaml")


def load():
    spec = importlib.util.spec_from_file_location("check_schemas", ROOT / "tools" / "check_schemas.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_schemas"] = module
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(
    importlib.util.find_spec("jsonschema") and importlib.util.find_spec("yaml"),
    "needs tools/requirements.txt",
)
class NativeFileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.registry = Path(temporary.name).resolve() / "acme-registry"
        shutil.copytree(ROOT / "examples" / "acme-registry", self.registry)
        self.module = load()
        self.module.EXAMPLES = [self.registry]

    def errors(self):
        from referencing import Registry, Resource
        from referencing.jsonschema import DRAFT202012

        rep = self.module.Report()
        with contextlib.redirect_stdout(io.StringIO()):
            loaded = self.module.check_structure(rep)
        registry = Registry().with_resources(
            (key, Resource.from_contents(doc, default_specification=DRAFT202012))
            for key, doc in loaded.items()
        )
        with contextlib.redirect_stdout(io.StringIO()):
            self.module.check_native_files(loaded, registry, rep, required=True)
        return rep.errors

    def test_passes_the_released_model(self):
        self.assertEqual(self.errors(), [])

    def test_refuses_a_model_that_fails_its_ossie_version(self):
        path = self.registry / MODEL
        path.write_text(path.read_text().replace('version: "0.1.1"', 'version: "9.9"'))
        [error] = self.errors()
        self.assertIn("semantic_model.yaml", error)
        self.assertIn("'9.9' is not one of", error)

    def test_refuses_a_0_1_1_file_that_lists_two_models(self):
        path = self.registry / MODEL
        text = path.read_text()
        listed = text[text.index("semantic_model:\n") + len("semantic_model:\n"):]
        path.write_text(text + listed)
        [error] = self.errors()
        self.assertIn("at semantic_model: fails maxItems: 1", error)

    def test_keeps_a_date_as_text_as_yaml_1_2_does(self):
        loaded = self.module.yaml_loader()("released: 2026-11-25\n")
        self.assertEqual(loaded, {"released": "2026-11-25"})


if __name__ == "__main__":
    unittest.main()
