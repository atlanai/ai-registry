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
KIT = Path("artifacts", "engineering", "plugin", "review-kit", "1.0.0")
METRICS = Path("artifacts", "engineering", "plugin", "review-metrics", "0.2.0")


class CheckFixTests(unittest.TestCase):
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


class PluginRuleTests(unittest.TestCase):
    """Section 3.4's plugin and range rules, which no schema states."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.registry = Path(temporary.name) / "registry"
        shutil.copytree(ROOT / "examples" / "acme-registry", self.registry)

    def edit(self, relative, change):
        path = self.registry / relative
        document = json.loads(path.read_text(encoding="utf-8"))
        change(document)
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    def errors(self):
        """Fill the digests the edit moved, so only the rule under test is left."""
        subprocess.run([sys.executable, "-I", str(CHECK), str(self.registry), "--fix"], capture_output=True)
        result = subprocess.run(
            [sys.executable, "-I", str(CHECK), str(self.registry)], text=True, capture_output=True,
        )
        return [line for line in result.stdout.splitlines() if line.startswith("error:")]

    def test_the_example_plugins_pass(self):
        self.assertEqual(self.errors(), [])

    def test_a_host_manifest_must_state_the_published_version(self):
        self.edit(METRICS / ".claude-plugin" / "plugin.json", lambda m: m.update(version="0.2.1"))
        self.assertEqual(len(self.errors()), 2, self.errors())
        self.assertIn("version is '0.2.1', metadata.version is '0.2.0'", "\n".join(self.errors()))

    def test_spec_manifest_is_the_agent_plugins_manifest(self):
        claude = json.loads((self.registry / KIT / ".claude-plugin" / "plugin.json").read_text())
        self.edit(KIT / "artifact.json", lambda e: e["spec"].update(manifest=claude))
        self.assertIn("spec.manifest differs from the entry manifest plugin.json", "\n".join(self.errors()))

    def test_a_plugin_carries_a_manifest(self):
        def drop(envelope):
            envelope["files"] = [f for f in envelope["files"] if not f["path"].endswith("plugin.json")]
        self.edit(METRICS / "artifact.json", drop)
        self.assertIn("carries no plugin manifest", "\n".join(self.errors()))

    def test_the_tested_version_satisfies_its_range(self):
        self.edit(METRICS / "artifact.json", lambda e: e["relationships"][0].update(range=">=1.1.0 <2.0.0"))
        self.assertIn("does not satisfy its own range", "\n".join(self.errors()))

    def test_a_range_is_only_for_depends_on(self):
        self.edit(METRICS / "artifact.json", lambda e: e["relationships"][0].update(rel_type="supersedes"))
        self.assertIn("range is only for depends_on", "\n".join(self.errors()))

    def test_a_range_names_semver_versions(self):
        self.edit(METRICS / "artifact.json", lambda e: e["relationships"][0].update(range="^1.0.0"))
        self.assertIn("needs semver comparators", "\n".join(self.errors()))


if __name__ == "__main__":
    unittest.main()
