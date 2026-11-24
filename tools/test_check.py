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


USAGE_FILE = Path("usage", "2026-09-02", "r-4f2a9c1e.jsonl")


class UsageTests(RegistryCopy):
    """File spec section 14: a usage location inside the root."""

    def first_run(self):
        line = (self.registry / USAGE_FILE).read_text(encoding="utf-8").splitlines()[0]
        return json.loads(line)

    def write_run(self, edit):
        """Replace the usage file with its first line, edited."""
        document = self.first_run()
        edit(document["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0])
        (self.registry / USAGE_FILE).write_text(json.dumps(document) + "\n", encoding="utf-8")
        (self.registry / "usage" / "index.json").unlink()

    def assert_error(self, text):
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(text, result.stdout)

    def test_example_usage_passes(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_run_of_an_unlisted_version_is_refused(self):
        def edit(record):
            record["attributes"][0]["value"]["stringValue"] = "engineering/skill/pr-review@9.9.9"
        self.write_run(edit)
        self.assert_error("is not a version this root lists")

    def test_run_with_wrong_digest_is_refused(self):
        def edit(record):
            record["attributes"][1]["value"]["stringValue"] = "sha256:" + "0" * 64
        self.write_run(edit)
        self.assert_error("is not engineering/skill/pr-review@1.2.0's content digest")

    def test_run_carrying_content_is_refused(self):
        def edit(record):
            record["attributes"].append({"key": "gen_ai.input.messages", "value": {"stringValue": "a prompt"}})
        self.write_run(edit)
        self.assert_error("may not carry gen_ai.input.messages")

    def test_run_more_precise_than_the_location_allows_is_refused(self):
        def edit(record):
            record["timeUnixNano"] = str(int(record["timeUnixNano"]) + 61 * 10**9)
        self.write_run(edit)
        self.assert_error("more precise than the location's time_precision")

    def test_run_outside_the_files_day_is_refused(self):
        def edit(record):
            record["timeUnixNano"] = str(int(record["timeUnixNano"]) + 86400 * 10**9)
        self.write_run(edit)
        self.assert_error("outside the file's day")

    def test_reporter_must_match_the_file_name(self):
        path = self.registry / USAGE_FILE
        path.rename(path.with_name("r-00000000.jsonl"))
        (self.registry / "usage" / "index.json").unlink()
        self.assert_error("must be 'r-00000000', the file's reporter")

    def test_stale_usage_index_is_refused_and_fix_rewrites_it(self):
        path = self.registry / USAGE_FILE
        path.write_bytes(path.read_bytes() + b"\n")
        self.assert_error("usage/index.json: does not list every usage file")
        result = self.check("--fix")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
