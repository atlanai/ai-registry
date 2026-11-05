import { describe, expect, test } from "vitest";
import { compile, compileArgs } from "./compile.ts";
import { findTarget, hostTarget, TARGETS, type Target } from "./targets.ts";

function need(os: string, arch: string): Target {
  const found = findTarget(os, arch);
  if (found === undefined) throw new Error(`${os}/${arch} is not in the matrix`);
  return found;
}

const TARGET = need("linux", "arm64");

function args(overrides: Partial<Parameters<typeof compileArgs>[0]> = {}): string[] {
  return compileArgs({
    target: TARGET,
    version: "1.2.3",
    origin: "https://releases.example.com/aireg",
    keyring: "k1:AAAA",
    outFile: "/out/aireg-linux-arm64",
    ...overrides,
  });
}

describe("compileArgs", () => {
  test("embeds the verified executable instead of downloading a target runtime", () => {
    const options = {
      target: TARGET,
      version: "1.2.3",
      origin: "",
      keyring: "",
      outFile: "/out/aireg",
    };
    expect(compileArgs(options, "/verified/bun")).toContain(
      "--compile-executable-path=/verified/bun",
    );
  });

  test("refuses a release target that differs from its native runner", () => {
    const target = TARGETS.find((item) => item.platform !== hostTarget()?.platform);
    expect(target).toBeDefined();
    expect(() =>
      compile(
        { target: target as Target, version: "1.2.3", origin: "", keyring: "", outFile: "/out" },
        "/unused",
        "/unused/bun",
      ),
    ).toThrow(/native runner/);
  });

  test("compiles the entrypoint for the requested Bun target", () => {
    // The entry is a literal, not the constant: a stale entry path is the whole risk.
    expect(args()).toEqual([
      "build",
      "--compile",
      "--target=bun-linux-arm64",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--define",
      '__VERSION__="1.2.3"',
      "--define",
      '__RELEASE_ORIGIN__="https://releases.example.com/aireg"',
      "--define",
      '__RELEASE_KEYRING__="k1:AAAA"',
      "--define",
      '__COMMIT__=""',
      "--outfile=/out/aireg-linux-arm64",
      "src/main.ts",
    ]);
  });

  // Not style: --bytecode cannot compile the top-level await this entrypoint
  // ends in, so a "make it smaller" edit must not reintroduce it.
  test("never asks for a bytecode cache", () => {
    for (const target of TARGETS) {
      expect(args({ target })).not.toContain("--bytecode");
    }
  });

  test("quotes stamped values so a define cannot be read as an expression", () => {
    expect(args({ origin: 'https://evil"; run()' })).toContain(
      '__RELEASE_ORIGIN__="https://evil\\"; run()"',
    );
    expect(args({ keyring: "" })).toContain('__RELEASE_KEYRING__=""');
  });

  test("gives a Windows binary its publisher and a numeric version, and only a Windows binary", () => {
    const windows = args({ target: need("windows", "amd64"), version: "1.2.3-rc.1" });
    expect(windows).toContain("--target=bun-windows-x64");
    expect(windows).toContain("--windows-publisher=Atlan Pte. Ltd.");
    expect(windows).toContain("--windows-version=1.2.3.0");
    expect(args().some((arg) => arg.startsWith("--windows-"))).toBe(false);
  });

  test("refuses a version that is not exact SemVer", () => {
    for (const version of ["latest", "v1.2.3", "1.2", "../../etc", "1.2.3+build"]) {
      expect(() => args({ version })).toThrow(/exact SemVer/);
    }
  });
});
