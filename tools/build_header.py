#!/usr/bin/env python3
"""Write the README header and the social preview to docs/assets as PNG.

Draws each image as SVG in the figure palette (build_figures.py), checks it,
then renders it with headless Chrome. Set CHROME to the browser binary if it is
not at the macOS default. Run: python3 tools/build_header.py [--check]

--check only runs the checks: at most 30 text items, no text below 11px at the
830px width GitHub shows a README image at, and WCAG contrast of 4.5 or more.
Harness folders match cli/src/harnesses/*.ts.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from html import escape as esc
from pathlib import Path

import build_figures as bf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
GITHUB_WIDTH, MIN_PX, MIN_CONTRAST, MAX_TEXT = 830, 11, 4.5, 30

BG, INK, INK2, LINE, CHIP = bf.WHITE, bf.INK, bf.INK2, bf.LINES, bf.GREYS
TEAL, TEAL_INK, TEAL_BG = bf.TEAL, bf.TEALI, bf.TEALS
AMB_INK, AMB_BG = bf.AMBI, bf.AMBS
FONT, MONO = bf.FONT, bf.MONO

LABEL = ("ai-registry: Engineering, Data and Support publish skills to one registry, acme. "
         "Active versions sync to Claude Code, Codex and Cursor; a version pending review does not. "
         "The registry can be stored on a git repository, a folder, object storage and more.")


class Canvas:
    def __init__(self):
        self.o, self.texts = [], []

    def text(self, x, y, s, size, fill, weight=400, anchor="start", mono=False, bg=BG):
        self.o.append(f'<text x="{x}" y="{y}" font-family="{MONO if mono else FONT}" font-size="{size}" '
                      f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{esc(s)}</text>')
        self.texts.append((s, size, fill, bg))

    def raw(self, s):
        self.o.append(s)


def draw(c, dy):
    # wordmark left, tagline right
    c.raw(f'<text x="60" y="{100 + dy}" font-family="{FONT}" font-size="62" font-weight="750" letter-spacing="-1.5">'
          f'<tspan fill="{TEAL}">ai</tspan><tspan fill="{INK}">-registry</tspan></text>')
    c.texts.append(("ai-registry", 62, INK, BG))
    c.text(1540, 70 + dy, "Manage the lifecycle of all your organisation's AI artifacts.", 26, INK2, anchor="end")
    c.text(1540, 104 + dy, "Automatically sync changes to all users and harnesses.", 26, INK2, anchor="end")

    # the registry: one row per team, only active versions sync
    rx, rw, top = 500, 520, 190 + dy
    rows = [("pr-review", "1.2.0", "active"), ("dbt-review", "1.0.0", "active"), ("triage", "2.1.0", "pending review")]
    head_h, row_h = 58, 70
    ys = [top + head_h + row_h * i + row_h / 2 for i in range(3)]
    bottom = top + head_h + row_h * 3 + 4
    c.raw(f'<rect x="{rx}" y="{top}" width="{rw}" height="{bottom - top}" rx="14" fill="{BG}" stroke="{TEAL}" stroke-width="2"/>')
    c.raw(f'<path d="M {rx + 1} {top + head_h} V {top + 14} a 13 13 0 0 1 13 -13 H {rx + rw - 14} a 13 13 0 0 1 13 13 V {top + head_h} Z" fill="{TEAL_BG}"/>')
    c.raw(f'<line x1="{rx}" y1="{top + head_h}" x2="{rx + rw}" y2="{top + head_h}" stroke="{TEAL}" stroke-width="2"/>')
    c.text(rx + 28, top + 38, "acme", 25, TEAL_INK, weight=700, bg=TEAL_BG)
    c.text(rx + rw - 28, top + 38, "only active versions sync", 22, TEAL_INK, anchor="end", bg=TEAL_BG)
    for i, ((name, ver, state), y) in enumerate(zip(rows, ys)):
        if i:
            c.raw(f'<line x1="{rx + 28}" y1="{y - row_h / 2}" x2="{rx + rw - 28}" y2="{y - row_h / 2}" stroke="{LINE}" stroke-width="1.5"/>')
        live = state == "active"
        c.text(rx + 28, y + 8, name, 24, INK if live else INK2, weight=600, mono=True)
        c.text(rx + 214, y + 8, ver, 24, INK2, mono=True)
        pw = 96 if live else 188
        fill, ink = (TEAL_BG, TEAL_INK) if live else (AMB_BG, AMB_INK)
        px = rx + rw - 28 - pw
        c.raw(f'<rect x="{px}" y="{y - 18}" width="{pw}" height="36" rx="18" fill="{fill}"/>')
        c.text(px + pw / 2, y + 8, state, 22, ink, weight=600, anchor="middle", bg=fill)

    # teams publish into their own row
    for name, y in zip(["Engineering", "Data", "Support"], ys):
        c.raw(f'<rect x="60" y="{y - 28}" width="260" height="56" rx="12" fill="{BG}" stroke="{LINE}" stroke-width="1.5"/>')
        c.text(88, y + 9, name, 25, INK, weight=600)
        c.raw(f'<line x1="320" y1="{y}" x2="{rx}" y2="{y}" stroke="{INK2}" stroke-width="2.5"/>')
        c.raw(f'<circle cx="{rx}" cy="{y}" r="5" fill="{INK2}"/>')
    c.text(410, ys[0] - 18, "publish", 22, INK2, anchor="middle")

    # active rows feed one line, which feeds every harness
    bus, hx, r = 1070, 1120, 16
    for y in ys[:2]:
        c.raw(f'<line x1="{rx + rw}" y1="{y}" x2="{hx}" y2="{y}" stroke="{TEAL}" stroke-width="2.5"/>')
    c.raw(f'<path d="M {bus} {ys[0]} V {ys[2] - r} Q {bus} {ys[2]} {bus + r} {ys[2]} H {hx}" fill="none" stroke="{TEAL}" stroke-width="2.5"/>')
    c.text(bus, ys[0] - 18, "sync", 22, TEAL_INK, anchor="middle")
    for (name, path), y in zip([("Claude Code", ".claude/skills/"), ("Codex", ".agents/skills/"), ("Cursor", ".cursor/skills/")], ys):
        c.raw(f'<rect x="{hx}" y="{y - 31}" width="420" height="62" rx="12" fill="{BG}" stroke="{LINE}" stroke-width="1.5"/>')
        c.raw(f'<circle cx="{hx}" cy="{y}" r="5" fill="{TEAL}"/>')
        c.text(hx + 26, y + 9, name, 25, INK, weight=600)
        c.text(hx + 394, y + 8, path, 22, INK2, anchor="end", mono=True)

    # any storage, git first
    sy = bottom + 30
    c.raw(f'<line x1="{rx + rw / 2}" y1="{bottom}" x2="{rx + rw / 2}" y2="{sy}" stroke="{INK2}" stroke-width="2.5"/>')
    chips = ["git repository", "folder", "object storage", "+ more"]
    widths = [11.6 * len(s) + 44 for s in chips]
    gap, lw = 12, 118
    x = rx + rw / 2 - (lw + sum(widths) + gap * (len(chips) - 1)) / 2
    c.text(x, sy + 30, "stored on", 22, INK2)
    x += lw
    for i, (s, w) in enumerate(zip(chips, widths)):
        main = i == 0
        dash = ' stroke-dasharray="5 4"' if s == "+ more" else ""
        fill = CHIP if main else BG
        c.raw(f'<rect x="{x}" y="{sy}" width="{w}" height="44" rx="22" fill="{fill}" '
              f'stroke="{INK2 if main else LINE}" stroke-width="1.5"{dash}/>')
        c.text(x + w / 2, sy + 30, s, 22, INK if main else INK2, weight=650 if main else 400, anchor="middle", bg=fill)
        x += w + gap


def svg(w, h, dy):
    c = Canvas()
    draw(c, dy)
    body = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
            f'aria-label="{esc(LABEL)}">\n<rect width="{w}" height="{h}" fill="{BG}"/>\n' + "\n".join(c.o) + "\n</svg>\n")
    return body, c.texts


def contrast(a, b):
    def lum(h):
        v = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        v = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in v]
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
    hi, lo = sorted([lum(a), lum(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


# name: (viewBox width, height, vertical offset, render scale) -> 3200x1200 and 2560x1280
IMAGES = {"readme-header.png": (1600, 600, 0, 2), "social-preview.png": (1600, 800, 100, 1.6)}


def main(argv):
    check, failed = "--check" in argv, False
    with tempfile.TemporaryDirectory() as tmp:
        for name, (w, h, dy, scale) in IMAGES.items():
            body, texts = svg(w, h, dy)
            smallest = min(size for _, size, _, _ in texts) * GITHUB_WIDTH / w
            worst = min(contrast(fill, bg) for _, _, fill, bg in texts)
            ok = len(texts) <= MAX_TEXT and smallest >= MIN_PX and worst >= MIN_CONTRAST
            failed |= not ok
            print(f"{name}: {len(texts)} text items, smallest {smallest:.1f}px, contrast {worst:.2f} "
                  f"{'ok' if ok else 'FAILED'}")
            if check or not ok:
                continue
            src = Path(tmp) / f"{name}.svg"
            src.write_text(body)
            subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                            f"--force-device-scale-factor={scale}", f"--window-size={w},{h}",
                            f"--screenshot={OUT / name}", src.as_uri()],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"wrote {(OUT / name).relative_to(ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
