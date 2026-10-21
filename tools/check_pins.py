#!/usr/bin/env python3
"""Check that documentation install pins match the version in cli/package.json.

Standard library only. A pin is `AIREG_VERSION=<version>` in a fenced code
block, as in `curl -fsSL https://aireg.sh/install | AIREG_VERSION=0.1.4 sh` or
`$env:AIREG_VERSION = "0.1.4"`. Code blocks are what readers copy into CI;
prose that shows the syntax with an example version is not a pin.

    python3 tools/check_pins.py

It reads every page under docs/. Published skills are immutable and retain
the install pins they were released with.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGE = REPO / "cli" / "package.json"
DOCS = REPO / "docs"
PIN_RE = re.compile(r"""AIREG_VERSION\s*=\s*["']?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)""")
# Any indent, since a code block inside a list item is indented with it.
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


def pinned_lines(text: str):
    """Yield (line number, line) for each line inside a fenced code block."""
    fence = ""
    for number, line in enumerate(text.splitlines(), start=1):
        match = FENCE_RE.match(line)
        if fence == "":
            if match:
                fence = match.group(1)
            continue
        if match and line.strip() == match.group(1) and match.group(1).startswith(fence):
            fence = ""
            continue
        yield number, line


def main() -> int:
    want = json.loads(PACKAGE.read_text(encoding="utf-8"))["version"]
    errors = 0
    pins = 0
    for path in sorted(DOCS.rglob("*.md")):
        for number, line in pinned_lines(path.read_text(encoding="utf-8")):
            for match in PIN_RE.finditer(line):
                pins += 1
                if match.group(1) != want:
                    errors += 1
                    print(f"error: {path.relative_to(REPO)}:{number}: pins aireg {match.group(1)},"
                          f" but cli/package.json is {want}")
    if errors:
        print(f"{errors} error(s): set each pin to {want}")
        return 1
    print(f"ok: {pins} install pin(s) match aireg {want}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
