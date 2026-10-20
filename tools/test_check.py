"""Tests for the spec checks: python3 -m unittest discover -s tools. Standard library only."""

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check  # noqa: E402

SCHEMAS = Path(__file__).resolve().parent.parent / "spec" / "schemas"


class TrailingNewline(unittest.TestCase):
    """A value with a trailing newline is outside every grammar, though `$` matches before one."""

    def test_check_refuses_it(self) -> None:
        self.assertIsNotNone(check._semver_key("1.2.0"))
        self.assertIsNone(check._semver_key("1.2.0\n"))
        self.assertIsNotNone(check.parse_range("^1.2"))
        for text in ("^1.2.0\n", "1.x\n", "1\n", ">=1.0.0 <2.0.0\n"):
            self.assertIsNone(check.parse_range(text), repr(text))
        for pattern, text in (
            (check.NAMESPACE_RE, "eng\n"),
            (check.KIND_RE, "skill\n"),
            (check.VERSION_RE, "1.0.0\n"),
            (check.REF_RE, "eng/skill/lint@1.0.0\n"),
            (check.DIGEST_RE, f"sha256:{'0' * 64}\n"),
        ):
            self.assertIsNotNone(pattern.match(text[:-1]), repr(text))
            self.assertIsNone(pattern.match(text), repr(text))

    def test_the_range_schema_stays_re2_compatible(self) -> None:
        # The schema patterns use no lookahead, so every JSON Schema validator compiles them;
        # check.py, not the schema, refuses the trailing newline Python's `$` lets through.
        schema = json.loads((SCHEMAS / "relationship.schema.json").read_text())
        pattern = schema["properties"]["range"]["pattern"]
        self.assertNotIn("(?", pattern.replace("(?:", ""))
        for text in ("^1.2.0", ">=1.0.0 <2.0.0", "^0.3.2 || ^1.2.0", "*"):
            self.assertIsNotNone(re.search(pattern, text), repr(text))


if __name__ == "__main__":
    unittest.main()
