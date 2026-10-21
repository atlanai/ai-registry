#!/usr/bin/env python3
"""Exercise the pre-push hook in temporary local Git repositories."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
ZERO = "0" * 40


class PrePushTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.log = self.root / "pnpm.log"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith("GIT_") and key != "LINT_BASE"
        }
        self.env.update({
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "PNPM_LOG": str(self.log),
        })
        binaries = self.root / "bin"
        binaries.mkdir()
        pnpm = binaries / "pnpm"
        pnpm.write_text(
            '#!/usr/bin/env bash\nset -euo pipefail\n'
            'printf "%s|%s|%s\\n" "$PWD" "$*" "${LINT_BASE-}" >> "$PNPM_LOG"\n'
            'if [[ "$*" == *"${FAIL_COMMAND:-__none__}"* ]]; then exit 19; fi\n',
            encoding="utf-8",
        )
        pnpm.chmod(0o755)
        self.env["PATH"] = str(binaries) + os.pathsep + self.env["PATH"]
        self.git("init", "-b", "main")
        for key, value in {
            "user.name": "Test author",
            "user.email": "test@example.invalid",
            "commit.gpgsign": "false",
            "core.hooksPath": ".git/disabled-hooks",
            "core.autocrlf": "false",
        }.items():
            self.git("config", key, value)
        (self.repo / "cli").mkdir()
        (self.repo / "cli" / "source.ts").write_text("export {};\n")
        (self.repo / ".gitignore").write_text("cli/ignored/\n")
        (self.repo / ".githooks").mkdir()
        self.hook = self.repo / ".githooks" / "pre-push"
        shutil.copy2(ROOT / ".githooks" / "pre-push", self.hook)
        shutil.copy2(ROOT / ".gitattributes", self.repo / ".gitattributes")
        self.git("add", ".")
        self.git("commit", "-m", "test: create fixture")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("update-ref", "refs/remotes/origin/main", self.head)

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=self.env,
            text=True, capture_output=True, check=True,
        )

    def push(self, *shas, **env):
        lines = "".join(
            f"refs/heads/push-{index} {sha} refs/heads/push-{index} {ZERO}\n"
            for index, sha in enumerate(shas)
        )
        return subprocess.run(
            [str(self.hook), "origin", "unused"], input=lines,
            cwd=self.repo, env={**self.env, **env}, text=True, capture_output=True,
        )

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_current_commit_runs_both_checks_with_default_base(self):
        result = self.push(self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [
            f"{self.repo / 'cli'}|run --silent typecheck|",
            f"{self.repo / 'cli'}|run --silent lint:changed --since=origin/main|",
        ])

    def test_deletion_only_skips_checks_and_base_lookup(self):
        result = self.push(ZERO, LINT_BASE="missing-base")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_each_pushed_commit_must_match_head(self):
        self.git("commit", "--allow-empty", "-m", "test: advance head")
        current = self.git("rev-parse", "HEAD").stdout.strip()
        for shas in [(self.head,), (current, self.head), (ZERO, self.head)]:
            with self.subTest(shas=shas):
                result = self.push(*shas)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_annotated_tag_at_head_is_checked(self):
        self.git("-c", "tag.gpgsign=false", "tag", "-a", "current", "-m", "Current commit")
        tag = self.git("rev-parse", "refs/tags/current").stdout.strip()
        result = self.push(tag)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 2)

    def test_annotated_tags_to_other_objects_are_rejected(self):
        blob = self.git("rev-parse", "HEAD:cli/source.ts").stdout.strip()
        self.git("commit", "--allow-empty", "-m", "test: advance head")
        for name, target in [("previous", self.head), ("blob", blob)]:
            with self.subTest(target=target):
                self.git("-c", "tag.gpgsign=false", "tag", "-a", name, target, "-m", "Test object")
                tag = self.git("rev-parse", f"refs/tags/{name}").stdout.strip()
                result = self.push(tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_dirty_cli_is_rejected_before_checks(self):
        source = self.repo / "cli" / "source.ts"
        for state in ["unstaged", "staged", "untracked"]:
            with self.subTest(state=state):
                self.git("reset", "--hard", "HEAD")
                if state == "untracked":
                    (self.repo / "cli" / "new.ts").write_text("export {};\n")
                else:
                    source.write_text("export const changed = true;\n")
                    if state == "staged":
                        self.git("add", "cli/source.ts")
                result = self.push(self.head)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_ignored_cli_files_and_unrelated_changes_are_allowed(self):
        ignored = self.repo / "cli" / "ignored"
        ignored.mkdir()
        (ignored / "cache").write_text("cache\n")
        (self.repo / "notes.md").write_text("notes\n")
        result = self.push(self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 2)

    def test_missing_base_stops_before_checks(self):
        result = self.push(self.head, LINT_BASE="missing-base")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_explicit_base_reaches_lint(self):
        result = self.push(self.head, LINT_BASE="HEAD")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.calls()[-1].endswith("|run --silent lint:changed --since=HEAD|HEAD"))

    def test_check_failures_propagate(self):
        for command, count in [("typecheck", 1), ("lint", 2)]:
            with self.subTest(command=command):
                self.log.unlink(missing_ok=True)
                result = self.push(self.head, FAIL_COMMAND=command)
                self.assertEqual(result.returncode, 19, result.stderr)
                self.assertEqual(len(self.calls()), count)

    def test_autocrlf_checkout_keeps_hook_executable(self):
        self.hook.unlink()
        self.git("-c", "core.autocrlf=true", "checkout", "HEAD", "--", ".githooks/pre-push")
        self.assertNotIn(b"\r\n", self.hook.read_bytes())
        result = self.push(self.head)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
