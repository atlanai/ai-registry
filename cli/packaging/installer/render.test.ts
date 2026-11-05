import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { TARGETS } from "#packaging/targets.ts";
import { test } from "#test/kit/fixtures.ts";
import { renderInstaller, renderTemplate, renderWindowsInstaller } from "./render.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

function binaries(body: (filename: string) => string | Uint8Array = (name) => name): string {
  const dir = mkdtempSync(join(scratch, "aireg-binaries-"));
  for (const target of TARGETS) {
    writeFileSync(join(dir, target.filename), body(target.filename));
  }
  return dir;
}

function render(overrides: Record<string, string> = {}): string {
  return renderInstaller({
    version: "1.2.3",
    origin: "https://releases.example.com/aireg",
    binaryDir: binaries(),
    ...overrides,
  });
}

/** Runs a script under `sh` in a throwaway HOME and returns its exit status. */
function runSh(script: string, env: Record<string, string> = {}): number | null {
  const dir = mkdtempSync(join(scratch, "aireg-run-"));
  const file = join(dir, "install.sh");
  writeFileSync(file, script);
  return spawnSync("sh", [file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), ...env },
  }).status;
}

describe("renderTemplate", () => {
  test("fails on a placeholder with no value", () => {
    expect(() => renderTemplate("a {{Missing}} b", {})).toThrow(/no value for \{\{Missing\}\}/);
  });

  // A renamed placeholder would otherwise render a script whose checksum
  // comparison can never match, and only in the field.
  test("fails on a value no placeholder consumed", () => {
    expect(() => renderTemplate("a {{Used}}", { Used: "x", Stale: "y" })).toThrow(
      /never used Stale/,
    );
  });
});

describe("renderInstaller", () => {
  test("pins the version, origin and derived download URL", () => {
    const script = render();
    expect(script).toContain('VERSION="1.2.3"');
    expect(script).toContain('ORIGIN="https://releases.example.com/aireg"');
    expect(script).toContain(
      '--output "$stage_dir/$2" "https://releases.example.com/aireg/artifacts/v1.2.3/$1"',
    );
    expect(script).not.toContain("<no value>");
    expect(script).not.toMatch(/\{\{|\}\}/);
  });

  test("pins a SHA-256 for every platform, each in its own installer", () => {
    const config = {
      version: "1.2.3",
      origin: "https://releases.example.com/aireg",
      binaryDir: binaries((name) => `binary-of-${name}`),
    };
    const sh = renderInstaller(config);
    const powershell = renderWindowsInstaller(config);
    for (const target of TARGETS) {
      const digest = createHash("sha256").update(`binary-of-${target.filename}`).digest("hex");
      const [has, lacks] = target.os === "windows" ? [powershell, sh] : [sh, powershell];
      expect(has, target.filename).toContain(digest);
      expect(lacks, target.filename).not.toContain(digest);
    }
  });

  // The installed CLI is the artifact, so the installer must not need a JavaScript runtime.
  test("needs no Node and downloads no tarball", () => {
    const script = render();
    expect(script).not.toMatch(/\bnode\b|node -e|\.mjs|\.tgz|tar /);
    expect(script).not.toMatch(/windows-|\.exe/i);
  });

  test("installs another release through that release's own installer", () => {
    const script = render();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, matched literally.
    expect(script).toContain('want="${AIREG_VERSION:-$VERSION}"');
    expect(script).toContain(
      '--output "$script" "https://releases.example.com/aireg/artifacts/v$1/install.sh"',
    );
    expect(script).toContain('AIREG_VERSION="$1" sh "$script" < /dev/null');
    expect(script).toContain("*[!0-9A-Za-z.+-]*)");
  });

  // The layout, PATH and skills belong to the binary, so the script only hands over.
  test("hands the install to the verified binary, never with the piped script as stdin", () => {
    const script = render();
    expect(script).toContain('"$binary" --setup < /dev/tty');
    expect(script).toContain('"$binary" --setup < /dev/null');
  });

  test("accepts a bare-host origin, as the release serves from a bucket root", () => {
    for (const origin of ["https://aireg.sh", "https://aireg.sh/"]) {
      expect(render({ origin })).toContain("https://aireg.sh/artifacts/v1.2.3");
    }
  });

  test("refuses an origin or version it cannot derive a URL from", () => {
    for (const bad of [
      { origin: "http://releases.example.com/aireg" },
      { origin: 'https://releases.example.com/cli";whoami' },
      { origin: "https://releases.example.com/cli?x=1" },
      { version: "latest" },
      { version: "../../etc" },
    ]) {
      expect(() => render(bad), JSON.stringify(bad)).toThrow(/https origin|exact version/);
    }
  });

  test("refuses a missing or empty binary", () => {
    const empty = mkdtempSync(join(scratch, "aireg-binaries-"));
    expect(() => render({ binaryDir: empty })).toThrow();
    for (const target of TARGETS) writeFileSync(join(empty, target.filename), "");
    expect(() => render({ binaryDir: empty })).toThrow(/not a built binary/);
    const dir = mkdtempSync(join(scratch, "aireg-binaries-"));
    mkdirSync(join(dir, TARGETS[0]?.filename ?? "x"));
    expect(() => render({ binaryDir: dir })).toThrow();
  });
});

describe("renderWindowsInstaller", () => {
  function renderWindows(): string {
    return renderWindowsInstaller({
      version: "1.2.3",
      origin: "https://releases.example.com/aireg",
      binaryDir: binaries(),
    });
  }

  test("pins the version, origin and download URL, and leaves no placeholder", () => {
    const script = renderWindows();
    expect(script).toContain("$Version = '1.2.3'");
    expect(script).toContain("$Origin = 'https://releases.example.com/aireg'");
    expect(script).toContain(
      '-Uri "https://releases.example.com/aireg/artifacts/v1.2.3/$Name-windows-$arch.exe"',
    );
    expect(script).not.toMatch(/\{\{|\}\}/);
  });

  // `irm | iex` runs the script in the caller's own session.
  test("never exits the PowerShell session it runs in", () => {
    expect(renderWindows()).not.toMatch(/^\s*exit\b/m);
  });

  test("installs another release through that release's own installer", () => {
    expect(renderWindows()).toContain(
      '"https://releases.example.com/aireg/artifacts/v$Want/install.ps1"',
    );
  });

  test("hands the install to the verified binary", () => {
    const script = renderWindows();
    expect(script.indexOf("Get-FileHash")).toBeLessThan(script.indexOf("& $binary --setup"));
  });
});

// install.sh is checked with POSIX sh and bash, which Windows runners do not ship as `sh`.
describe.skipIf(process.platform === "win32")("the rendered installer", () => {
  test("is valid POSIX sh", () => {
    expect(() => execFileSync("sh", ["-n"], { input: render() })).not.toThrow();
    expect(() => execFileSync("bash", ["-n"], { input: render() })).not.toThrow();
  }, 30_000);

  // A `curl | sh` cut off mid-download must run nothing. The whole body is one
  // function precisely so sh cannot accept the definitions it has read so far.
  test("runs nothing when it is truncated", () => {
    const script = render();
    const withoutMarker = script.slice(0, script.lastIndexOf("installer_complete=true\n"));
    expect(withoutMarker).not.toBe(script);
    expect(runSh(withoutMarker)).not.toBe(0);
    expect(runSh(script.slice(0, Math.floor(script.length / 2)))).not.toBe(0);
    // Even the marker on its own, with the body cut short, is refused.
    expect(
      runSh(`${script.slice(0, Math.floor(script.length / 2))}\ninstaller_complete=true\n`),
    ).not.toBe(0);
  }, 30_000);

  test("removes another release's installer when that install is interrupted", () => {
    const bin = mkdtempSync(join(scratch, "aireg-bin-"));
    const downloads = join(bin, "downloads");
    // The downloaded installer interrupts the one that started it, as a Ctrl-C would.
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/sh",
        'while [ "$1" != --output ]; do shift; done',
        `echo "$2" >> "${downloads}"`,
        "echo 'kill -INT $PPID; kill -INT $$; sleep 5' > \"$2\"",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "curl"), 0o755);

    const status = runSh(render(), {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AIREG_VERSION: "1.0.0",
    });

    expect(status).not.toBe(0);
    const scripts = readFileSync(downloads, "utf8").trim().split("\n");
    expect(scripts).toHaveLength(1);
    expect(scripts.filter((path) => existsSync(path))).toEqual([]);
  }, 30_000);
});
