#!/usr/bin/env python3
"""Write the documentation figures to docs/assets as self-contained SVG.

Static, light palette, no external CSS. Run: python3 tools/build_figures.py [--check]
"""
from __future__ import annotations

import sys
from html import escape as esc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets"

INK, INK2, INK3 = "#17201F", "#4A5654", "#7A8583"
LINES, GREYS, WHITE = "#B9C2BF", "#EEF0EF", "#FFFFFF"
TEAL, TEALI, TEALS = "#0F6E56", "#085041", "#E1F5EE"
AMB, AMBI, AMBS = "#BA7517", "#633806", "#FAEEDA"
FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, Menlo, Consolas, monospace"

CLIENTS = ["Claude Code", "Codex", "Cursor", "Copilot"]
CX = [30, 200, 370, 540]
CW = 150

ARROW = ('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
         f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{INK3}"/></marker></defs>')


def text(x, y, t, size=12.5, fill=INK, weight="normal", anchor="start", mono=False, baseline=None):
    fam = MONO if mono else FONT
    extra = f' dominant-baseline="{baseline}"' if baseline else ""
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}"{extra}>{esc(t)}</text>')


def box(o, x, y, w, t, fill=WHITE, stroke=LINES, tc=INK, size=12.5, h=34, dash="", mono=False, weight="normal"):
    o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{fill}" stroke="{stroke}" stroke-width="1"{dash}/>')
    o.append(text(round(x + w / 2), round(y + h / 2), t, size=size, fill=tc, anchor="middle", mono=mono, baseline="central", weight=weight))


def vline(o, x, y1, y2, stroke=INK3, dash=""):
    o.append(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="{stroke}" stroke-width="0.9"{dash}/>')


def line(o, x1, y1, x2, y2, stroke=INK3, dash="", arrow=False):
    m = ' marker-end="url(#arrow)"' if arrow else ""
    o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="0.9"{dash}{m}/>')


def head(o, t, sub):
    o.append(text(30, 26, t, size=15, weight="700"))
    o.append(text(30, 45, sub, size=12.5, fill=INK2))


def clients(o, y):
    for i, c in enumerate(CLIENTS):
        box(o, CX[i], y, CW, c)


def wrap(h, label, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 {h}" width="720" height="{h}" '
            f'role="img" aria-label="{esc(label)}">\n<rect width="720" height="{h}" fill="{WHITE}"/>\n{ARROW}\n'
            + "\n".join(body) + "\n</svg>\n")


# ---------------------------------------------------------------- anatomy of a root

def fig_anatomy():
    o = ['<g transform="translate(0,-44)">']

    def entry(x, y, w, h, title, note, dash="", fill=WHITE):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{fill}" stroke="{LINES}" stroke-width="1"{dash}/>')
        o.append(text(x + 12, y + 19, title, size=12, weight="600", mono=True))
        o.append(text(x + 12, y + 35, note, size=10.5, fill=INK3))

    entry(30, 64, 200, 46, "registry.json", "discovery: what this root is")
    entry(250, 64, 200, 46, "index.json", "catalog of every artifact")
    entry(470, 64, 220, 46, "kinds/", "optional: the kind manifests", dash=' stroke-dasharray="4 3"')
    # artifacts container with the nested path
    o.append(f'<rect x="30" y="126" width="440" height="176" rx="6" fill="{GREYS}" stroke="{LINES}" stroke-width="1"/>')
    o.append(text(44, 146, "artifacts/", size=12, weight="600", mono=True))
    o.append(text(122, 146, "every artifact lives here", size=10.5, fill=INK3))
    o.append(f'<rect x="46" y="158" width="408" height="130" rx="5" fill="{WHITE}" stroke="{LINES}" stroke-width="1"/>')
    o.append(text(58, 176, "<namespace>/", size=11.5, mono=True))
    o.append(text(170, 176, "the owner: a team, a workspace, a GitHub owner", size=10.5, fill=INK3))
    o.append(f'<rect x="62" y="186" width="376" height="94" rx="5" fill="{WHITE}" stroke="{LINES}" stroke-width="1"/>')
    o.append(text(74, 204, "<kind>/", size=11.5, mono=True))
    o.append(text(150, 204, "skill, agent", size=10.5, fill=INK3))
    o.append(f'<rect x="78" y="214" width="344" height="58" rx="5" fill="{WHITE}" stroke="{LINES}" stroke-width="1"/>')
    o.append(text(90, 232, "<name>/", size=11.5, mono=True))
    box(o, 90, 242, 110, "versions.json", h=22, size=10.5, mono=True, fill=TEALS, stroke=TEAL, tc=TEALI)
    box(o, 210, 242, 210, "<version>/  artifact.json + files", h=22, size=10, mono=True)
    entry(490, 126, 200, 60, "blobs/", "sha256/<digest>")
    o.append(text(502, 175, "shared bytes, stored once", size=10.5, fill=INK3))
    o.append(text(30, 326, "Teal: the one file about a version that changes after publish. Dashed: optional. Paths are relative to the root.", size=11.5, fill=INK3))
    o.append('</g>')
    return wrap(294, "Anatomy of a registry root: registry.json, index.json, an optional kinds directory, the artifacts directory with its namespace, kind, name, versions.json and version folders, and the blobs directory.", o)


# ---------------------------------------------------------------- overview: one registry, any client, any storage

def fig_overview():
    o = []
    head(o, "One registry, any client, any storage", "A registry that follows the specification is a set of files. Who reads them and where they live are both open.")
    clients(o, 64)
    for i in range(4):
        vline(o, CX[i] + CW / 2, 98, 118)
    o.append(f'<rect x="30" y="118" width="660" height="44" rx="6" fill="{WHITE}" stroke="{LINES}" stroke-width="1" stroke-dasharray="4 3"/>')
    o.append(text(44, 140, "any client, any number", size=11.5, fill=INK2, baseline="central"))
    box(o, 230, 128, 110, "aireg CLI", fill=GREYS, stroke=LINES, tc=INK2, h=24, size=11)
    box(o, 352, 128, 150, "MCP server (planned)", fill=WHITE, stroke=LINES, tc=INK2, h=24, size=11, dash=' stroke-dasharray="4 3"')
    box(o, 514, 128, 70, "CI job", fill=GREYS, stroke=LINES, tc=INK2, h=24, size=11)
    for i in range(4):
        vline(o, CX[i] + CW / 2, 162, 176)
    o.append(f'<rect x="30" y="176" width="660" height="78" rx="6" fill="{TEALS}" stroke="{TEAL}" stroke-width="1"/>')
    o.append(text(360, 194, "registry", size=13, weight="600", fill=TEALI, anchor="middle"))
    for t, x, w in [("skills", 275, 80), ("agents", 365, 80)]:
        box(o, x, 204, w, t, fill=WHITE, stroke=TEAL, tc=TEALI, h=24, size=11.5)
    o.append(text(360, 245, "defined by the specification: versions, ownership, status, digests, dependencies", size=11, fill=TEALI, anchor="middle"))
    vline(o, 360, 254, 270)
    o.append(f'<rect x="30" y="270" width="660" height="44" rx="6" fill="{WHITE}" stroke="{LINES}" stroke-width="1" stroke-dasharray="4 3"/>')
    o.append(text(44, 292, "any storage, pick one", size=11.5, fill=INK2, baseline="central"))
    for t, x, w, dash in [("folder", 200, 70, ""), ("git repository", 282, 110, ""),
                          ("object storage bucket", 404, 150, ' stroke-dasharray="4 3"'), ("hosted service", 566, 110, ' stroke-dasharray="4 3"')]:
        box(o, x, 280, w, t, fill=GREYS if dash == "" else WHITE, stroke=LINES, tc=INK2, h=24, size=11, dash=dash)
    o.append(text(30, 342, "Teal: what the specification defines. Grey: your choice on both sides. Dashed: planned, or no client reads it yet.", size=11.5, fill=INK3))
    o.append(text(30, 359, "aireg reads a registry from a folder or a git repository.", size=11.5, fill=INK3))
    return wrap(372, "One registry holding skills and agents, read by any client for any agent, and stored on one storage: a folder or a git repository today, and later an object storage bucket or a hosted service.", o)


# ---------------------------------------------------------------- use cases: teams, individuals

def flow(o, left_label, left, mid_title, mid_sub, chips, right_label, right, verbs):
    """Three columns: sources on the left, the registry in the middle, where it is used on the right."""
    o.append(text(30, 72, left_label, size=10.5, fill=INK3, weight="600"))
    o.append(text(510, 72, right_label, size=10.5, fill=INK3, weight="600"))
    ys = [80, 124, 168]
    for y, t in zip(ys[:len(left)] if len(left) > 1 else [124], left):
        box(o, 30, y, 180, t, size=12)
        line(o, 210, y + 17, 268, y + 17, arrow=True)
    o.append(f'<rect x="270" y="80" width="180" height="122" rx="6" fill="{TEALS}" stroke="{TEAL}" stroke-width="1"/>')
    o.append(text(360, 100, mid_title, size=13, weight="600", fill=TEALI, anchor="middle"))
    o.append(text(360, 117, mid_sub, size=10.5, fill=TEALI, anchor="middle"))
    for i, c in enumerate(chips):
        box(o, 280, 132 + i * 32, 160, c, fill=WHITE, stroke=TEAL, tc=TEALI, h=24, size=11)
    for y, t in zip(ys, right):
        line(o, 450, y + 17, 508, y + 17, arrow=True)
        box(o, 510, y, 180, t, size=12)
    o.append(text(240, 222, verbs[0], size=10.5, fill=INK3, anchor="middle"))
    o.append(text(480, 222, verbs[1], size=10.5, fill=INK3, anchor="middle"))


def fig_teams():
    o = []
    head(o, "One registry for the whole company", "Teams publish from their own repositories, every change is reviewed, and everyone installs exact versions.")
    flow(o, "TEAMS' REPOSITORIES", ["payments app repo", "data app repo", "platform app repo"],
         "team registry", "a git repository", ["reviewed changes", "every version kept"],
         "WHERE IT IS USED", ["projects pin versions", "CI uses pinned versions", "laptops stay current"],
         ["publish on merge", "install and keep in sync"])
    o.append(text(30, 254, "Teal: the team registry. A change is reviewed once, then reaches every project and laptop that uses it.", size=11.5, fill=INK3))
    return wrap(268, "Teams publish skills from their own app repositories on merge into one team registry, a git repository where every change is reviewed and every version is kept. Projects pin exact versions, CI uses the pinned versions, and laptops stay current.", o)


def fig_individuals():
    o = []
    head(o, "Your skills, in every tool and on every machine", "Release a version once, and every coding agent on every machine you use picks it up.")
    flow(o, "YOU", ["release a new version"],
         "your registry", "a private GitHub repository", ["every version kept", "go back any time"],
         "WHERE IT IS USED", ["Claude Code", "Codex and Cursor", "your other laptop"],
         ["publish", "within 15 minutes"])
    o.append(text(30, 254, "Teal: your registry. One release reaches every coding agent on this laptop and your other machines.", size=11.5, fill=INK3))
    return wrap(268, "You release a new version of a skill to your registry, a private GitHub repository that keeps every version. Claude Code, Codex, Cursor and your other laptop pick it up within 15 minutes.", o)


# ---------------------------------------------------------------- architecture: files, catalog, clients

def fig_system():
    o = []
    head(o, "Files, catalog, clients", "Clients read a registry as files. A planned catalog API would create, connect, and govern registries.")
    o.append(text(30, 72, "CLIENTS", size=10.5, fill=INK3, weight="600"))
    o.append(f'<rect x="30" y="80" width="210" height="52" rx="5" fill="{WHITE}" stroke="{LINES}" stroke-width="1"/>')
    o.append(text(135, 100, "aireg CLI", size=12.5, weight="600", anchor="middle"))
    o.append(text(135, 118, "install, publish, keep in sync", size=10.5, fill=INK3, anchor="middle"))
    o.append(f'<rect x="260" y="80" width="210" height="52" rx="5" fill="{WHITE}" stroke="{LINES}" stroke-width="1" stroke-dasharray="4 3"/>')
    o.append(text(365, 100, "MCP server", size=12.5, weight="600", fill=INK2, anchor="middle"))
    o.append(text(365, 118, "planned: read without installing", size=10.5, fill=INK3, anchor="middle"))
    line(o, 135, 132, 135, 163, arrow=True)
    line(o, 365, 132, 365, 163, arrow=True, dash=' stroke-dasharray="3 3"')
    o.append(text(145, 152, "read files", size=10.5, fill=INK3))
    o.append(f'<rect x="30" y="164" width="440" height="78" rx="6" fill="{TEALS}" stroke="{TEAL}" stroke-width="1"/>')
    o.append(text(250, 184, "registry files, laid out by the file spec", size=13, weight="600", fill=TEALI, anchor="middle"))
    x = 44
    for label, w in [("registry.json", 90), ("index.json", 72), ("versions.json", 90), ("artifact.json", 90), ("files", 42)]:
        box(o, x, 196, w, label, fill=WHITE, stroke=TEAL, tc=TEALI, h=24, size=10, mono=True)
        x += w + 6
    o.append(text(250, 234, "what agents read, from disk or from storage", size=10.5, fill=TEALI, anchor="middle"))
    vline(o, 250, 242, 262)
    o.append(f'<rect x="30" y="262" width="440" height="40" rx="6" fill="{WHITE}" stroke="{LINES}" stroke-width="1" stroke-dasharray="4 3"/>')
    o.append(text(44, 282, "storage", size=11.5, fill=INK2, baseline="central"))
    x = 110
    for label, w, dash in [("git repository", 96, ""), ("object storage bucket", 138, ' stroke-dasharray="4 3"'), ("hosted service", 100, ' stroke-dasharray="4 3"')]:
        box(o, x, 270, w, label, fill=GREYS if dash == "" else WHITE, stroke=LINES, tc=INK2, h=24, size=10.5, dash=dash)
        x += w + 8
    o.append(f'<rect x="490" y="80" width="200" height="222" rx="6" fill="{WHITE}" stroke="{AMB}" stroke-width="1" stroke-dasharray="5 4"/>')
    o.append(text(590, 104, "Catalog API", size=13, weight="600", fill=AMBI, anchor="middle"))
    o.append(text(590, 122, "planned", size=10.5, fill=AMBI, anchor="middle"))
    for i, label in enumerate(["create registries", "federate them across", "teams and organizations", "govern who publishes", "and what is approved"]):
        o.append(text(590, 154 + i * 18, label, size=11, fill=INK2, anchor="middle"))
    o.append(text(590, 262, "clients read files directly;", size=10.5, fill=INK3, anchor="middle"))
    o.append(text(590, 278, "reads never go through it", size=10.5, fill=INK3, anchor="middle"))
    line(o, 490, 203, 472, 203, arrow=True)
    o.append(text(30, 330, "Teal: what clients read. Dashed amber: planned. Dashed grey: planned, or your choice.", size=11.5, fill=INK3))
    return wrap(342, "A registry's files, laid out by the file spec and kept on any storage, are read directly by clients: the aireg CLI today and an MCP server later. A planned catalog API would create, federate, and govern registries and would not serve reads.", o)


# ---------------------------------------------------------------- file-tree drawings

TREE_STATE = {
    "same": (WHITE, LINES, INK, ""),
    "new": (TEALS, TEAL, TEALI, ""),
    "chg": (AMBS, AMB, AMBI, ""),
    "blob": (WHITE, LINES, INK, ' stroke-dasharray="4 3"'),
}
TREE_BADGE = {
    "latest": (TEALS, TEAL, TEALI), "active": (TEALS, TEAL, TEALI), "new": (TEALS, TEAL, TEALI),
    "changed": (AMBS, AMB, AMBI), "unchanged": (WHITE, LINES, INK2),
}


def R(depth, label, state="same", note="", badge=""):
    return dict(depth=depth, label=label, state=state, note=note, badge=badge)


def tree_svg(rows, label, legend=None):
    """A stacked file list: one box per path, connectors by depth, optional badge and note."""
    row_h, indent = 32, 26
    x0 = 20
    top = 12
    boxes = []
    for i, r in enumerate(rows):
        w = int(7.6 * len(r["label"]) + 18)
        boxes.append((x0 + r["depth"] * indent, top + i * row_h, w))
    max_right = max(x + w for x, y, w in boxes)
    for i, r in enumerate(rows):
        if r.get("badge"):
            x, y, w = boxes[i]
            max_right = max(max_right, x + w + 8 + int(6.2 * len(r["badge"]) + 14))
    notes_x = max_right + 28
    max_note = max((len(r.get("note", "")) for r in rows), default=0)
    W = max(int(notes_x + 6.2 * max_note + 20), 560)
    legend_y = top + len(rows) * row_h + 14
    H = legend_y + (28 if legend else 6)
    o = []
    for i, r in enumerate(rows):
        d = r["depth"]
        if d == 0:
            continue
        p = None
        for j in range(i - 1, -1, -1):
            if rows[j]["depth"] == d - 1:
                p = j
                break
            if rows[j]["depth"] < d - 1:
                break
        if p is None:
            continue
        px, py, pw = boxes[p]
        cx, cy, cw = boxes[i]
        vx = px + 11
        o.append(f'<line x1="{vx}" y1="{py + 26}" x2="{vx}" y2="{cy + 14}" stroke="{LINES}" stroke-width="1"/>')
        o.append(f'<line x1="{vx}" y1="{cy + 14}" x2="{cx - 3}" y2="{cy + 14}" stroke="{LINES}" stroke-width="1"/>')
    for i, r in enumerate(rows):
        x, y, w = boxes[i]
        fill, stroke, tc, dash = TREE_STATE[r.get("state", "same")]
        o.append(f'<rect x="{x}" y="{y + 2}" width="{w}" height="24" rx="4" fill="{fill}" stroke="{stroke}" stroke-width="1"{dash}/>')
        o.append(text(x + 9, y + 14, r["label"], size=12, fill=tc, mono=True, baseline="central"))
        if r.get("badge"):
            b = r["badge"]
            bw = int(6.2 * len(b) + 14)
            bf, bs, bt = TREE_BADGE.get(b.split()[0], TREE_BADGE["unchanged"])
            bx = x + w + 8
            o.append(f'<rect x="{bx}" y="{y + 5}" width="{bw}" height="18" rx="9" fill="{bf}" stroke="{bs}" stroke-width="0.8"/>')
            o.append(text(round(bx + bw / 2), y + 14, b, size=10.5, fill=bt, anchor="middle", baseline="central"))
        if r.get("note"):
            o.append(text(notes_x, y + 14, r["note"], size=11.5, fill=INK2, baseline="central"))
    if legend:
        lx = x0
        for key, caption in legend:
            bf, bs, bt = TREE_BADGE[key]
            o.append(f'<rect x="{lx}" y="{legend_y}" width="14" height="14" rx="3" fill="{bf}" stroke="{bs}" stroke-width="1"/>')
            o.append(text(lx + 20, legend_y + 7, caption, size=11.5, fill=INK2, baseline="central"))
            lx += 20 + int(6.2 * len(caption)) + 26
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{esc(label)}">\n'
            f'<rect width="{W}" height="{H}" fill="{WHITE}"/>\n' + "\n".join(o) + "\n</svg>\n")


def fig_tree_one_skill():
    rows = [
        R(0, "registry.json", note="discovery: format_version, name, slug, url, auth, kinds[]"),
        R(0, "index.json", note="catalog: one entry per artifact"),
        R(0, "artifacts/", note="every artifact lives here and nothing else does"),
        R(1, "engineering/", note="namespace: the owner inside this root"),
        R(2, "agent/", note="kind"),
        R(3, "reviewer/", note="name; holds versions.json and 0.3.0/, which depends on pr-review@1.2.0"),
        R(2, "skill/", note="kind"),
        R(3, "pr-review/", note="name"),
        R(4, "versions.json", note="the pointer: latest, and per-version digest and status"),
        R(4, "1.2.0/", badge="latest"),
        R(5, "artifact.json", note="the envelope: files[] with digests, spec, relationships[]"),
        R(5, "SKILL.md", note="the author's file, unchanged"),
        R(5, "references/checklist.md"),
        R(0, "blobs/"),
        R(1, "sha256/28eb…fc0c", state="blob", note="large or shared bytes, addressed by digest"),
        R(0, "kinds/", note="optional: the manifests registry.json points to"),
    ]
    return tree_svg(rows, "The acme root: registry.json, index.json, the engineering namespace with the reviewer agent and the pr-review skill down to versions.json and the 1.2.0 folder, the blob store, and the kinds directory.")


def fig_tree_publisher():
    rows = [
        R(0, "registry.json", note="unchanged"),
        R(0, "index.json", state="chg", badge="changed", note="aireg registry index moves run-benchmark's latest to 0.2.0"),
        R(0, "artifacts/"),
        R(1, "engineering/"),
        R(2, "agent/"),
        R(3, "reviewer/", note="untouched"),
        R(2, "skill/"),
        R(3, "pr-review/", note="untouched"),
        R(3, "run-benchmark/"),
        R(4, "versions.json", state="chg", badge="changed", note="aireg registry index adds 0.2.0 and points latest at it"),
        R(4, "0.1.0/", badge="active", note="untouched; anyone pinned to it still verifies"),
        R(5, "artifact.json"),
        R(5, "SKILL.md"),
        R(4, "0.2.0/", state="new", badge="new", note="created by aireg skill bump run-benchmark minor"),
        R(5, "artifact.json", state="new", note="written by aireg registry index: files[] with digests"),
        R(5, "SKILL.md", state="new", note="your edit"),
        R(0, "blobs/"),
        R(0, "kinds/"),
    ]
    return tree_svg(rows, "Updating run-benchmark to 0.2.0: aireg skill bump creates the folder, and aireg registry index writes its artifact.json and rewrites versions.json and index.json.",
                    legend=[("new", "new in this release"), ("changed", "rewritten by aireg registry index"), ("unchanged", "untouched")])


def fig_tree_new_skill():
    rows = [
        R(0, "registry.json", note="unchanged"),
        R(0, "index.json", state="chg", badge="changed", note="aireg registry index adds an entry for run-benchmark"),
        R(0, "artifacts/"),
        R(1, "engineering/"),
        R(2, "agent/"),
        R(3, "reviewer/", note="untouched"),
        R(2, "skill/"),
        R(3, "pr-review/", note="untouched"),
        R(3, "run-benchmark/", state="new", badge="new", note="created by aireg skill new run-benchmark"),
        R(4, "versions.json", state="new", note="written by aireg registry index: latest 0.1.0"),
        R(4, "0.1.0/", state="new"),
        R(5, "artifact.json", state="new", note="written by aireg registry index: files[] with digests"),
        R(5, "SKILL.md", state="new", note="your file"),
        R(0, "blobs/"),
        R(0, "kinds/"),
    ]
    return tree_svg(rows, "Adding a new skill, run-benchmark, to the engineering namespace: aireg skill new creates the folder, and aireg registry index writes its artifact.json and versions.json and adds it to index.json.",
                    legend=[("new", "new in this release"), ("changed", "rewritten by aireg registry index"), ("unchanged", "untouched")])


FIGURES = {
    "overview.svg": fig_overview,
    "anatomy.svg": fig_anatomy,
    "system.svg": fig_system,
    "acme-layout.svg": fig_tree_one_skill,
    "publish-version.svg": fig_tree_publisher,
    "publish-skill.svg": fig_tree_new_skill,
    "use-teams.svg": fig_teams,
    "use-individuals.svg": fig_individuals,
}


def main(argv):
    check = "--check" in argv
    OUT.mkdir(parents=True, exist_ok=True)
    stale = []
    for name, fn in FIGURES.items():
        want = fn()
        path = OUT / name
        if check:
            if not path.exists() or path.read_text() != want:
                stale.append(name)
        else:
            path.write_text(want)
            print(f"wrote {path.relative_to(ROOT)}")
    if check and stale:
        print("stale figures: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
