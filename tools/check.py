#!/usr/bin/env python3
"""Self-check for a file-spec root.

Standard library only. Verifies path grammar and file paths, every file digest
and size, the content digest and catalog digest of every version, that latest
is the newest active release, that versions.json and index.json agree, and
that every relationship resolves.

    python3 tools/check.py examples/acme-registry
    python3 tools/check.py examples/acme-registry --print-digests
    python3 tools/check.py examples/acme-registry --fix   # authoring aid: write digests in place

--fix is an authoring aid for the worked example. In a repository root an
indexer (`aireg registry index`) writes versions.json and index.json.
--partial accepts a folder that holds only some of the versions its
versions.json lists, which is what a client's on-demand copy of an HTTPS root
looks like.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

NAMESPACE_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
NAME_RE = NAMESPACE_RE
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
# Section 2.1: a folder Windows cannot create, in any case and with any extension.
DEVICE_RE = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", re.IGNORECASE)
REF_RE = re.compile(
    r"^(?P<ns>[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)/(?P<kind>[a-z][a-z0-9_]{0,31})/"
    r"(?P<name>[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)@(?P<version>[A-Za-z0-9][A-Za-z0-9._+-]{0,127})$"
)
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
# SemVer 2.0.0: no leading "v", and no leading zeros in a numeric identifier.
_NUM = r"0|[1-9]\d*"
_PRE = rf"(?:{_NUM}|\d*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER_RE = re.compile(
    rf"^({_NUM})\.({_NUM})\.({_NUM})(?:-({_PRE}(?:\.{_PRE})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f]")
# Code points HFS+ ignores in a name, so ".g\u200cit" is ".git" there.
HFS_IGNORED_RE = re.compile("[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]")
STATUSES = {"draft", "pending_review", "active", "blocked", "deprecated", "archived"}
SUPPORTED_FORMAT = 1


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def _utf16_order(key: str) -> tuple[int, ...]:
    """JCS sorts object keys by UTF-16 code unit, not by code point.

    The two orders differ only when a key holds a supplementary-plane character,
    because surrogates sort below U+E000. Every key this repository produces is
    ASCII, where the orders agree; this keeps independent canonicalisers in
    agreement for the keys it does not produce.
    """
    b = key.encode("utf-16-be")
    return tuple(int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2))


def _jcs(obj) -> str:
    """Serialize in JCS order. Python already emits the JCS short escapes."""
    if isinstance(obj, dict):
        items = sorted(obj.items(), key=lambda kv: _utf16_order(kv[0]))
        return "{" + ",".join(f"{_jcs(k)}:{_jcs(v)}" for k, v in items) + "}"
    if isinstance(obj, list):
        return "[" + ",".join(_jcs(v) for v in obj) + "]"
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def canonical(obj) -> bytes:
    """RFC 8785 serialization for the JSON subset the spec allows (no floats)."""
    _assert_no_floats(obj, "$")
    return _jcs(obj).encode("utf-8")


def _assert_no_floats(obj, path: str) -> None:
    if isinstance(obj, float):
        raise ValueError(f"non-integer number at {path}; the spec forbids them in envelopes")
    if isinstance(obj, int) and not isinstance(obj, bool) and abs(obj) >= 2**53:
        raise ValueError(f"integer outside +/-(2^53-1) at {path}")
    if isinstance(obj, dict):
        for k, v in obj.items():
            _assert_no_floats(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _assert_no_floats(v, f"{path}[{i}]")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_of(data: bytes) -> str:
    return "sha256:" + sha256_hex(data)


def content_digest(envelope: dict) -> str:
    body = json.loads(json.dumps(envelope))  # deep copy
    meta = body.get("metadata", {})
    meta.pop("digest", None)
    meta.pop("status", None)
    return digest_of(canonical(body))


def catalog_digest(content: str, status: str, yanked: bool, envelope: dict) -> str:
    meta = envelope.get("metadata", {})
    state = {
        "digest": content,
        "status": status,
        "yanked": yanked,
        "labels": meta.get("labels", {}),
        "annotations": meta.get("annotations", {}),
        "relationships": envelope.get("relationships", []),
    }
    return digest_of(canonical(state))


def load_json(path: Path, rep: Report):
    try:
        with path.open("rb") as f:
            return json.load(f)
    except FileNotFoundError:
        rep.error(f"{path}: missing")
    except json.JSONDecodeError as e:
        rep.error(f"{path}: invalid JSON: {e}")
    except RecursionError:
        rep.error(f"{path}: nested too deeply to read")
    return None


def inside(root: Path, target: Path) -> bool:
    """True when target sits under root with no symlink on the way, so a
    registry cannot make the checker read or rewrite a file outside it."""
    base = root.resolve()
    if not target.resolve().is_relative_to(base):
        return False
    at = target
    while at != root and at != at.parent:
        if at.is_symlink():
            return False
        at = at.parent
    return True


def write_json(root: Path, path: Path, obj, rep: Report) -> None:
    """Every --fix write goes through here, so a link cannot redirect a repair."""
    if not inside(root, path):
        rep.error(f"{path.relative_to(root)}: not rewritten; it is a symlink, sits under one, or lies outside the root")
        return
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def resolve_blob(root: Path, template: str, digest: str) -> Path | None:
    if "://" in template:
        return None  # remote blob host; cannot verify offline
    return root / template.replace("{digest}", digest.split(":", 1)[1])


def _semver_key(version: str):
    """Semver precedence as a sortable key, or None for a version that does not parse."""
    m = SEMVER_RE.match(version)
    if not m:
        return None
    pre = m.group(4).split(".") if m.group(4) else []
    idents = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if pre else 1, idents)


def newest(rows: list) -> str | None:
    """Section 3.3: the newest active, non-yanked version, a release ahead of every
    prerelease and a version that does not parse below every one that does. Equals,
    and versions that do not parse, keep the first row, since the list is newest first."""
    best = None

    def rank(key) -> tuple:
        # A release outranks every prerelease, and a prerelease every unparsed version.
        return (0,) if key is None else (1 + key[3], key)

    for row in rows:
        v = row.get("version") if isinstance(row, dict) else None
        if not isinstance(v, str) or row.get("status") != "active" or row.get("yanked") is True:
            continue
        key = _semver_key(v)
        if best is None or rank(key) > rank(best[1]):
            best = (v, key)
    return best[0] if best else None


def _is_git_dir(segment: str) -> bool:
    """A segment some file system stores as .git: any case, HFS+'s ignored code
    points, the trailing dots and spaces Windows drops, and the short name git~1."""
    folded = HFS_IGNORED_RE.sub("", segment).lower().rstrip(". ")
    return folded in (".git", "git~1")


def safe_path(path) -> bool:
    """Section 2.3: a relative path every platform writes inside the version directory."""
    if not isinstance(path, str) or path == "" or path.startswith("/") or CONTROL_RE.search(path):
        return False
    if "\\" in path or ":" in path:
        return False
    return all(seg not in ("", ".", "..") and not _is_git_dir(seg) for seg in path.split("/"))


def colliding_paths(paths: list[str]) -> tuple[str, str] | None:
    """Two paths a case-insensitive disk stores as one file, or as a file and the
    folder another sits in: the later one and the one it lands on."""
    def fold(path: str) -> str:
        return unicodedata.normalize("NFC", path).lower()
    files: dict[str, str] = {}
    for path in paths:
        if fold(path) in files:
            return path, files[fold(path)]
        files[fold(path)] = path
    for path in paths:
        parts = fold(path).split("/")
        for end in range(1, len(parts)):
            prefix = "/".join(parts[:end])
            if prefix in files:
                return path, files[prefix]
    return None


def check_kind_manifests(root: Path, registry: dict, rep: Report) -> None:
    """A root may serve its own kind manifests through a relative manifest_url.

    When it does, the bytes must match this repository's copy under
    spec/schemas/kinds/. Without this check a root keeps validating against a
    stale manifest after the canonical one is tightened, and the worked example
    quietly stops demonstrating the spec.
    """
    reference_dir = Path(__file__).resolve().parent.parent / "spec" / "schemas" / "kinds"
    for entry in registry.get("kinds", []):
        url = entry.get("manifest_url", "")
        if not url or "://" in url:
            continue
        local = root / url
        if not inside(root, local) or not local.is_file():
            rep.error(f"registry.json: kinds[{entry.get('name')!r}] manifest_url {url!r} does not resolve inside the root")
            continue
        reference = reference_dir / local.name
        if reference.is_file() and local.read_bytes() != reference.read_bytes():
            rep.error(f"{url}: differs from spec/schemas/kinds/{local.name}; the root's copy has drifted")


def check_registry(root: Path, rep: Report, fix: bool, print_digests: bool, partial: bool = False) -> None:
    registry = load_json(root / "registry.json", rep)
    if registry is None:
        return
    if registry.get("kind", "registry") != "registry":
        rep.error(f"registry.json: kind is {registry.get('kind')!r}; this is not a registry root (a host document lists roots; point at one of them)")
        return
    fv = registry.get("format_version")
    if fv != SUPPORTED_FORMAT:
        rep.error(f"registry.json: format_version {fv!r}; this checker implements {SUPPORTED_FORMAT}")
        return
    caps = registry.get("capabilities", [])
    if "files" not in set(caps):
        rep.error("registry.json: capabilities must include 'files'")
    blob_template = registry.get("blob_url", "blobs/sha256/{digest}")
    if "{digest}" not in blob_template:
        rep.error("registry.json: blob_url must contain {digest}")
    elif "://" not in blob_template and not safe_path(blob_template.replace("{digest}", "0")):
        rep.error("registry.json: a relative blob_url must stay inside the root")
        blob_template = "://"  # nothing is read through it

    check_kind_manifests(root, registry, rep)

    index = None
    if inside(root, root / "index.json"):
        index = load_json(root / "index.json", rep)
    else:
        rep.error("index.json: is a symlink; not read")
    index_entries: dict[tuple[str, str, str], dict] = {}
    if index is not None:
        for e in index.get("entries", []):
            key = (e.get("namespace"), e.get("kind"), e.get("name"))
            if key in index_entries:
                rep.error(f"index.json: duplicate entry {'/'.join(map(str, key))}")
            index_entries[key] = e

    known_versions: set[str] = set()
    seen_keys: set[tuple[str, str, str]] = set()
    pending_refs: list[tuple[str, str]] = []

    for stray in sorted(root.glob("*/*/*/versions.json")):
        rep.error(f"{stray.relative_to(root)}: namespaces must live under artifacts/ in format 1")
    artifacts = root / "artifacts"
    if artifacts.is_symlink():
        rep.error("artifacts/ is a symlink; not read")
    elif not artifacts.is_dir() and index_entries:
        rep.error("artifacts/ is missing but index.json has entries")

    for vpath in sorted(artifacts.glob("*/*/*/versions.json")) if inside(root, artifacts) and artifacts.is_dir() else []:
        name_dir = vpath.parent
        ns, kind, name = name_dir.parts[-3:]
        key = (ns, kind, name)
        seen_keys.add(key)
        label = f"{ns}/{kind}/{name}"
        # The glob follows links, so a linked folder or file is refused before it is read.
        if not inside(root, vpath):
            rep.error(f"{label}: versions.json is a symlink or sits under one; not read")
            continue
        if not NAMESPACE_RE.match(ns):
            rep.error(f"{label}: namespace violates grammar")
        if not KIND_RE.match(kind):
            rep.error(f"{label}: kind violates grammar")
        if not NAME_RE.match(name):
            rep.error(f"{label}: name violates grammar")
        for segment in (ns, kind, name):
            if DEVICE_RE.match(segment):
                rep.error(f"{label}: {segment!r} is a device name on Windows")

        vdoc = load_json(vpath, rep)
        if vdoc is None:
            continue
        for field, expected in (("namespace", ns), ("kind", kind), ("name", name)):
            if vdoc.get(field) != expected:
                rep.error(f"{vpath}: {field} is {vdoc.get(field)!r}, path says {expected!r}")

        listed: dict[str, dict] = {}
        for entry in vdoc.get("versions", []):
            v = entry.get("version")
            if not isinstance(v, str) or not VERSION_RE.match(v) or v == "latest":
                rep.error(f"{label}: version {v!r} violates grammar")
                continue
            if DEVICE_RE.match(v):
                rep.error(f"{label}: version {v!r} is a device name on Windows")
            if v in listed:
                rep.error(f"{label}: version {v} listed twice")
            listed[v] = entry
            if entry.get("status") not in STATUSES:
                rep.error(f"{label}@{v}: status {entry.get('status')!r} not in lifecycle")
            if not isinstance(entry.get("yanked"), bool):
                rep.error(f"{label}@{v}: yanked must be a boolean")

            vdir = name_dir / v
            if not inside(root, vdir / "artifact.json"):
                rep.error(f"{label}@{v}: artifact.json is a symlink or sits under one; not read")
                continue
            if not vdir.is_dir():
                if partial:
                    rep.warn(f"{label}@{v}: not present locally (partial copy)")
                else:
                    rep.error(f"{label}@{v}: directory missing")
                continue
            known_versions.add(f"{label}@{v}")
            env = load_json(vdir / "artifact.json", rep)
            if env is None:
                continue

            meta = env.get("metadata", {})
            for field, expected in (("namespace", ns), ("kind", None), ("name", name), ("version", v)):
                actual = env.get("kind") if field == "kind" else meta.get(field)
                expected = kind if field == "kind" else expected
                if actual != expected:
                    rep.error(f"{label}@{v}: artifact.json {field} is {actual!r}, path says {expected!r}")
            if env.get("apiVersion") != "aireg.sh/v1":
                rep.error(f"{label}@{v}: apiVersion must be aireg.sh/v1")

            changed = False
            files = env.get("files", [])
            if not files:
                rep.error(f"{label}@{v}: files[] is empty")
            clash = colliding_paths([fd.get("path") for fd in files if safe_path(fd.get("path"))])
            if clash is not None:
                rep.error(f"{label}@{v}: {clash[0]!r} and {clash[1]!r} are one file on a case-insensitive disk")
            for fd in files:
                p = fd.get("path", "")
                if not safe_path(p):
                    rep.error(f"{label}@{v}: file path {p!r} is not a safe relative path")
                    continue
                urls = fd.get("urls")
                if urls:
                    if "://" in urls[0]:
                        rep.warn(f"{label}@{v}: {p} is remote ({urls[0]}); not verified offline")
                        continue
                    target = vdir / urls[0]
                    if not inside(root, target):
                        rep.error(f"{label}@{v}: {p} points outside the registry")
                        continue
                else:
                    if not DIGEST_RE.match(fd.get("digest", "")):
                        rep.error(f"{label}@{v}: {p} has no urls and no valid digest to resolve a blob")
                        continue
                    target = resolve_blob(root, blob_template, fd["digest"])
                    if target is None:
                        rep.warn(f"{label}@{v}: {p} resolves to a remote blob host; not verified offline")
                        continue
                    if not inside(root, target):
                        rep.error(f"{label}@{v}: {p} resolves to a blob outside the registry")
                        continue
                if not target.is_file():
                    rep.error(f"{label}@{v}: {p} -> {target.relative_to(root)} missing")
                    continue
                data = target.read_bytes()
                actual_digest, actual_size = digest_of(data), len(data)
                if fix and (fd.get("digest") != actual_digest or fd.get("size") != actual_size):
                    fd["digest"], fd["size"] = actual_digest, actual_size
                    changed = True
                if fd.get("digest") != actual_digest:
                    rep.error(f"{label}@{v}: {p} digest mismatch (expected {actual_digest})")
                if fd.get("size") != actual_size:
                    rep.error(f"{label}@{v}: {p} size {fd.get('size')} != {actual_size}")

            try:
                cdig = content_digest(env)
            except ValueError as e:
                rep.error(f"{label}@{v}: {e}")
                continue
            if fix and meta.get("digest") != cdig:
                meta["digest"] = cdig
                changed = True
            if changed:
                write_json(root, vdir / "artifact.json", env, rep)
            if meta.get("digest") not in (None, cdig):
                rep.error(f"{label}@{v}: metadata.digest {meta.get('digest')} != computed {cdig}")

            catdig = catalog_digest(cdig, entry.get("status"), bool(entry.get("yanked")), env)
            if print_digests:
                print(f"{label}@{v}\n  digest          {cdig}\n  catalog_digest  {catdig}")
            if fix:
                entry["digest"], entry["catalog_digest"] = cdig, catdig
            if entry.get("digest") != cdig:
                rep.error(f"{label}@{v}: versions.json digest {entry.get('digest')} != computed {cdig}")
            if "catalog_digest" in entry and entry["catalog_digest"] != catdig:
                rep.error(f"{label}@{v}: versions.json catalog_digest != computed {catdig}")

            for rel in env.get("relationships", []) or []:
                to = rel.get("to", "")
                if not REF_RE.match(to):
                    rep.error(f"{label}@{v}: relationship target {to!r} is not a valid ref")
                else:
                    pending_refs.append((f"{label}@{v}", to))

        for child in name_dir.iterdir():
            if child.is_dir() and child.name not in listed:
                rep.error(f"{label}: directory {child.name} exists but is not listed in versions.json")

        latest = vdoc.get("latest")
        if latest not in listed:
            rep.error(f"{label}: latest {latest!r} is not a listed version")
        want = newest(vdoc.get("versions", []))
        if want is not None and latest != want:
            rep.error(f"{label}: latest is {latest!r}, but the newest active release is {want!r}")
        if fix:
            write_json(root, vpath, vdoc, rep)

        idx = index_entries.get(key)
        if idx is None:
            if fix and index is not None and latest in listed:
                latest_path = name_dir / latest / "artifact.json"
                env_latest = (load_json(latest_path, rep) if inside(root, latest_path) else None) or {}
                idx = {"namespace": ns, "kind": kind, "name": name}
                meta_l = env_latest.get("metadata", {})
                for f in ("display_name", "description"):
                    if f in meta_l:
                        idx[f] = meta_l[f]
                index["entries"].append(idx)
                index_entries[key] = idx
            else:
                rep.error(f"index.json: no entry for {label}")
        if idx is not None and latest in listed:
            le = listed[latest]
            if fix:
                idx["latest"], idx["digest"], idx["status"] = latest, le["digest"], le["status"]
                idx["catalog_digest"] = le.get("catalog_digest")
                idx["updated_at"] = le.get("published_at")
            for f, want in (("latest", latest), ("digest", le.get("digest")), ("status", le.get("status"))):
                if idx.get(f) != want:
                    rep.error(f"index.json: {label} {f} is {idx.get(f)!r}, versions.json says {want!r}")
            if "catalog_digest" in idx and idx["catalog_digest"] != le.get("catalog_digest"):
                rep.error(f"index.json: {label} catalog_digest disagrees with versions.json")

    for key in set(index_entries) - seen_keys:
        rep.error(f"index.json: entry {'/'.join(map(str, key))} has no versions.json")

    for src, to in pending_refs:
        if to not in known_versions:
            rep.warn(f"{src}: relationship target {to} is not in this registry (external?)")

    if fix and index is not None:
        index["entries"].sort(key=lambda e: (e["namespace"], e["kind"], e["name"]))
        write_json(root, root / "index.json", index, rep)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", type=Path, help="registry root directory")
    ap.add_argument("--fix", action="store_true", help="write computed digests into the registry (authoring aid)")
    ap.add_argument("--print-digests", action="store_true", help="print computed digests per version")
    ap.add_argument("--partial", action="store_true", help="accept versions listed in versions.json whose directory is absent (a client's on-demand copy)")
    args = ap.parse_args()

    rep = Report()
    check_registry(args.root.resolve(), rep, args.fix, args.print_digests, args.partial)
    for w in rep.warnings:
        print(f"warning: {w}")
    for e in rep.errors:
        print(f"error: {e}")
    if rep.errors:
        print(f"{len(rep.errors)} error(s)")
        return 1
    print(f"ok: {args.root} passes file spec checks ({len(rep.warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
