#!/usr/bin/env python3
"""Check spec/schemas/ and validate every example registry against it.

    python3 tools/check_schemas.py [--require-jsonschema]

Two tiers. The structural tier needs only the standard library: every schema
parses, declares 2020-12, has a unique $id, and every $ref resolves to a file
and a JSON Pointer that exist. That catches the likely failure, a typo'd $ref.

The instance tier validates each example registry's documents (every
examples/*/registry.json root) against their schemas, asserting `format` where
the validator has a checker for it, and needs `jsonschema`. Without it the tier reports itself skipped and the run still
succeeds, so this script is usable wherever tools/check.py is. CI passes
--require-jsonschema, which makes a missing `jsonschema` an error instead.

$ids here are relative paths, not URLs, so schemas are preloaded into a resolver
keyed by path rather than fetched. See spec/schemas/README.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCHEMA_DIR = REPO / "spec" / "schemas"
EXAMPLES = sorted(path.parent for path in (REPO / "examples").glob("*/registry.json"))
DIALECT = "https://json-schema.org/draft/2020-12/schema"


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.notes: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)
        print(f"error: {msg}")

    def note(self, msg: str) -> None:
        self.notes.append(msg)
        print(f"note: {msg}")


def schema_paths() -> list[Path]:
    return sorted(p for p in SCHEMA_DIR.rglob("*.json"))


def rel(path: Path) -> str:
    return path.relative_to(SCHEMA_DIR).as_posix()


def resolve_pointer(doc, pointer: str):
    """Resolve an RFC 6901 JSON Pointer, or raise KeyError."""
    node = doc
    for raw in pointer.lstrip("/").split("/"):
        if raw == "":
            continue
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(token)]
        else:
            node = node[token]
    return node


def iter_refs(node, trail: str = "$"):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                yield trail, value
            else:
                yield from iter_refs(value, f"{trail}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from iter_refs(value, f"{trail}[{i}]")


def check_structure(rep: Report) -> dict[str, dict]:
    """Parse every schema, check the dialect and $id, resolve every $ref."""
    loaded: dict[str, dict] = {}
    for path in schema_paths():
        try:
            loaded[rel(path)] = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            rep.error(f"{rel(path)}: invalid JSON: {exc}")

    seen: dict[str, str] = {}
    for key, doc in loaded.items():
        if doc.get("$schema") != DIALECT:
            rep.error(f"{key}: $schema is {doc.get('$schema')!r}, expected {DIALECT}")
        ident = doc.get("$id")
        if ident is None:
            rep.error(f"{key}: no $id")
        elif ident != key:
            rep.error(f"{key}: $id is {ident!r}; it must be the path under spec/schemas/")
        elif ident in seen:
            rep.error(f"{key}: $id {ident!r} already used by {seen[ident]}")
        else:
            seen[ident] = key

    for key, doc in loaded.items():
        base = Path(key).parent
        for trail, ref in iter_refs(doc):
            file_part, _, fragment = ref.partition("#")
            if file_part:
                target_key = (base / file_part).as_posix().replace("./", "")
                if target_key not in loaded:
                    rep.error(f"{key}: $ref at {trail} points at {file_part!r}, which is not a schema here")
                    continue
                target = loaded[target_key]
            else:
                target = doc
            if fragment and fragment != "/":
                try:
                    resolve_pointer(target, fragment)
                except (KeyError, IndexError, ValueError):
                    rep.error(f"{key}: $ref at {trail} points at {ref!r}; the pointer does not resolve")
    return loaded


def instances() -> list[tuple[Path, list[str]]]:
    """Every example document and the schemas it must satisfy.

    No example exercises host.schema.json's roots_page, the response of a roots_url.
    """
    pairs: list[tuple[Path, list[str]]] = [
        (REPO / "examples" / "host-document.json", ["host.schema.json"]),
    ]
    for manifest in sorted((SCHEMA_DIR / "kinds").glob("*.json")):
        pairs.append((manifest, ["kind-manifest.schema.json"]))
    for example in EXAMPLES:
        pairs.append((example / "registry.json", ["registry.schema.json"]))
        pairs.append((example / "index.json", ["index.schema.json"]))
        for versions in sorted((example / "artifacts").rglob("versions.json")):
            pairs.append((versions, ["versions.schema.json"]))
        for envelope in sorted((example / "artifacts").rglob("artifact.json")):
            pairs.append((envelope, ["artifact.schema.json", "artifact-known-kinds.schema.json"]))
        for manifest in sorted((example / "kinds").glob("*.json")):
            pairs.append((manifest, ["kind-manifest.schema.json"]))
    return pairs


def check_instances(loaded: dict[str, dict], rep: Report, required: bool) -> bool:
    """Validate the example against the schemas. Returns False when skipped."""
    try:
        from jsonschema import Draft202012Validator
        from referencing import Registry, Resource
        from referencing.jsonschema import DRAFT202012
    except ImportError:
        if required:
            rep.error("jsonschema is not installed, and --require-jsonschema needs the instance tier "
                      "(pip install -r tools/requirements.txt)")
        else:
            rep.note("jsonschema is not installed; instance validation skipped "
                     "(pip install -r tools/requirements.txt). Structural checks above still ran.")
        return False

    registry = Registry().with_resources(
        (key, Resource.from_contents(doc, default_specification=DRAFT202012))
        for key, doc in loaded.items()
    )

    checked = 0
    for path, schema_keys in instances():
        try:
            instance = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            rep.error(f"{path}: cannot read: {exc}")
            continue
        for key in schema_keys:
            validator = Draft202012Validator(
                loaded[key], registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER
            )
            for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.path)):
                where = "/".join(str(p) for p in err.path) or "(root)"
                rep.error(f"{path.relative_to(REPO)} against {key}: at {where}: {err.message}")
            checked += 1

    # Each kind manifest must also be a valid 2020-12 schema in its own right.
    for manifest in sorted((SCHEMA_DIR / "kinds").glob("*.json")):
        try:
            Draft202012Validator.check_schema(json.loads(manifest.read_text()))
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim
            rep.error(f"{rel(manifest)}: not a valid 2020-12 schema: {exc}")
        checked += 1

    print(f"ran {checked} validations")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--require-jsonschema", action="store_true",
                    help="fail instead of skipping the instance tier when jsonschema is not installed")
    args = ap.parse_args()

    rep = Report()
    loaded = check_structure(rep)
    print(f"structural: {len(loaded)} schema(s) in spec/schemas/")
    validated = check_instances(loaded, rep, args.require_jsonschema)

    if rep.errors:
        print(f"{len(rep.errors)} error(s)")
        return 1
    tier = "structure and instances" if validated else "structure only"
    print(f"ok: spec/schemas/ checks pass ({tier})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
