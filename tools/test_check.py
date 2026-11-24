#!/usr/bin/env python3
"""Exercise check.py --fix on a copy of the acme example registry."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
CHECK = ROOT / "tools" / "check.py"
SKILL = Path("artifacts", "engineering", "skill", "pr-review")


class RegistryCopy(unittest.TestCase):
    """A fresh copy of the acme example for each test."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.temp = Path(temporary.name).resolve()
        self.registry = self.temp / "registry"
        shutil.copytree(ROOT / "examples" / "acme-registry", self.registry)
        self.outside = self.temp / "outside"
        self.outside.mkdir()

    def check(self, *args):
        return subprocess.run(
            [sys.executable, "-I", str(CHECK), str(self.registry), *args],
            text=True, capture_output=True,
        )


class CheckFixTests(RegistryCopy):
    def link(self, relative):
        """Move a registry file or folder outside and leave a symlink in its place."""
        source = self.registry / relative
        target = self.outside / source.name
        shutil.move(str(source), str(target))
        try:
            source.symlink_to(target, target_is_directory=target.is_dir())
        except OSError as error:
            self.skipTest(f"cannot create symlinks here: {error}")
        return target

    def snapshot(self):
        return {
            path.relative_to(self.outside): path.read_bytes()
            for path in sorted(self.outside.rglob("*")) if path.is_file()
        }

    def stale(self, path):
        """Compact a JSON file and break its first file digest, if it has one,
        so --fix rewrites it."""
        document = json.loads(path.read_text(encoding="utf-8"))
        if "files" in document:
            document["files"][0]["digest"] = "sha256:" + "0" * 64
        path.write_text(json.dumps(document), encoding="utf-8")

    def assert_refused(self, *stale):
        for path in stale:
            self.stale(path)
        before = self.snapshot()
        result = self.check("--fix")
        self.assertEqual(self.snapshot(), before, "a file outside the registry was rewritten")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("symlink", result.stdout)

    def test_fix_restores_a_stale_artifact_to_the_example(self):
        example = ROOT / "examples" / "acme-registry"
        self.stale(self.registry / SKILL / "1.2.0" / "artifact.json")
        result = self.check("--fix")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in sorted(example.rglob("*")):
            if path.is_file():
                copy = self.registry / path.relative_to(example)
                self.assertEqual(copy.read_bytes(), path.read_bytes(), path)

    def test_linked_index_is_not_rewritten(self):
        self.assert_refused(self.link("index.json"))

    def test_linked_artifact_is_not_rewritten(self):
        self.assert_refused(self.link(SKILL / "1.2.0" / "artifact.json"))

    def test_linked_namespace_is_not_read_or_rewritten(self):
        namespace = self.link(Path("artifacts", "engineering"))
        self.assert_refused(
            namespace / "skill" / "pr-review" / "versions.json",
            namespace / "skill" / "pr-review" / "1.2.0" / "artifact.json",
        )

    def test_linked_artifacts_folder_is_not_read_or_rewritten(self):
        artifacts = self.link("artifacts")
        self.assert_refused(artifacts / "engineering" / "skill" / "pr-review" / "versions.json")


class UsageTests(RegistryCopy):
    """File spec section 14.1: the usage block in registry.json."""

    def set_usage(self, usage):
        path = self.registry / "registry.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["usage"] = usage
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    def assert_error(self, text):
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(text, result.stdout)

    def test_https_and_loopback_endpoints_pass(self):
        for otlp in ("https://otel.example.com", "http://localhost:4318", "http://127.0.0.1:6006", "http://[::1]:4318/"):
            self.set_usage({"otlp": otlp, "reporter": "name", "time_precision": "second"})
            result = self.check()
            self.assertEqual(result.returncode, 0, otlp + result.stdout + result.stderr)

    def test_plain_http_to_another_host_is_refused(self):
        self.set_usage({"otlp": "http://otel.example.com"})
        self.assert_error("must be https, or http to a loopback host")

    def test_a_host_that_only_starts_like_localhost_is_refused(self):
        self.set_usage({"otlp": "http://localhost.example.com"})
        self.assert_error("must be https, or http to a loopback host")

    def test_endpoint_is_required(self):
        self.set_usage({"reporter": "pseudonym"})
        self.assert_error("usage.otlp is required")

    def test_traces_path_is_refused(self):
        self.set_usage({"otlp": "https://otel.example.com/v1/traces"})
        self.assert_error("a client adds /v1/traces")

    def test_unknown_reporter_and_precision_are_refused(self):
        self.set_usage({"otlp": "https://otel.example.com", "reporter": "email", "time_precision": "minute"})
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not pseudonym or name", result.stdout)
        self.assertIn("is not second, hour or day", result.stdout)


if __name__ == "__main__":
    unittest.main()
