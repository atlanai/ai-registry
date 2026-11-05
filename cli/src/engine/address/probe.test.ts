import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import type { Entry } from "#core/catalog/catalog.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  atAddress,
  insideRegistry,
  rememberSource,
  sourceConfig,
  throughManifest,
} from "./probe.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

// Settling a pasted link asks the host which refs exist; these links name `main` plainly.
vi.mock("#adapters/git/api.ts", async (original) => ({
  ...(await original<typeof import("#adapters/git/api.ts")>()),
  settlePastedLink: async <T>(pasted: T) => pasted,
}));

const declared: Record<string, RegistrySource> = {
  kit: { location: "github.com/acme/kit", adapter: "git", config: { ref: "v1" } },
};

describe("throughManifest", () => {
  test("leaves an address nothing declares alone", () => {
    const resolved = throughManifest("github.com/other/repo", declared, {});
    expect(resolved).toMatchObject({ input: "github.com/other/repo", declared: false });
  });

  test("resolves a bare alias to the location it was declared by", () => {
    const resolved = throughManifest("kit", declared, {});
    expect(resolved).toMatchObject({
      input: "github.com/acme/kit",
      name: undefined,
      declared: true,
    });
  });

  // Two aliases can share one host, one per account, so a read by address
  // must not hand the second alias the first one's account.
  test("names the alias, so a read uses that alias's account", () => {
    const shared: Record<string, RegistrySource> = {
      first: { location: "https://api.example.com", adapter: "hosted", config: {} },
      second: { location: "https://api.example.com", adapter: "hosted", config: {} },
    };
    expect(throughManifest("second/team", shared, {}).alias).toBe("second");
    expect(throughManifest("github.com/other/repo", declared, {}).alias).toBeUndefined();
  });

  test("carries the declared adapter and config through", () => {
    const { flags } = throughManifest("kit", declared, {});
    expect(flags.adapter).toBe("git");
    expect(flags.config).toContain("ref=v1");
  });

  // `kit/skill/lint` must resolve the alias, not reach the git adapter as a repository name.
  test("takes the artifact out of a kind-qualified address", () => {
    expect(throughManifest("kit/skill/lint", declared, {}).name).toBe("lint");
  });

  test("names no artifact for a whole namespace", () => {
    const resolved = throughManifest("kit/sales", declared, {});
    expect(resolved.name).toBeUndefined();
    expect(resolved.declared).toBe(true);
  });

  test("lets a flag override what the manifest pinned", () => {
    const { flags } = throughManifest("kit", declared, { ref: "v2" });
    expect(flags.ref).toBe("v2");
  });
});

describe("sourceConfig", () => {
  test("folds --ref and --path into adapter config", () => {
    expect(sourceConfig({ ref: "v2", path: "/regs/kit/" })).toMatchObject({
      ref: "v2",
      path: "regs/kit",
    });
  });
});

describe("rememberSource", () => {
  test("keeps the declared location and stores the probed config for acquire", () => {
    const existing = { location: "./kit", adapter: "local", config: { ref: "v1" } };
    const probed = {
      location: "/tmp/kit",
      adapter: "local",
      config: sourceConfig({ path: "regs", config: ["ref=v1"] }),
    };
    expect(rememberSource(existing, probed)).toEqual({
      location: "./kit",
      adapter: "local",
      config: { ref: "v1", path: "regs" },
    });
    expect(rememberSource(undefined, probed)).toBe(probed);
  });
});

describe("atAddress", () => {
  const entry = (group: string, kind: Entry["kind"], name: string): Entry => ({
    name,
    kind,
    group,
    path: `artifacts/${group}/${kind}/${name}`,
    description: undefined,
    engine: undefined,
    from: { file: "index.json", pointer: "" },
  });
  const catalog = [
    entry("sales", "skill", "deploy"),
    entry("sales", "agent", "deploy"),
    entry("sales", "skill", "lint"),
    entry("ops", "skill", "lint"),
  ];

  test("takes the one artifact a short address names", () => {
    const found = atAddress(throughManifest("kit/sales/lint", declared, {}), catalog, "kit");
    expect(found.map((item) => `${item.group}/${item.kind}/${item.name}`)).toEqual([
      "sales/skill/lint",
    ]);
  });

  test("refuses a name two kinds share, and lists the addresses to choose from", () => {
    expect(() =>
      atAddress(throughManifest("kit/sales/deploy", declared, {}), catalog, "kit"),
    ).toThrow(
      expect.objectContaining({
        hint: "Name one of them: kit/sales/agent/deploy or kit/sales/skill/deploy.",
      }),
    );
  });

  test("takes the kind when the address writes it", () => {
    const found = atAddress(
      throughManifest("kit/sales/agent/deploy", declared, {}),
      catalog,
      "kit",
    );
    expect(found.map((item) => item.kind)).toEqual(["agent"]);
  });

  test("refuses a namespace that does not publish the name, and names those that do", () => {
    expect(() =>
      atAddress(throughManifest("kit/ops/skill/deploy", declared, {}), catalog, "kit"),
    ).toThrow(
      expect.objectContaining({
        message: "kit/ops/skill/deploy matches nothing this registry publishes.",
        hint: "Did you mean `kit/sales/agent/deploy` or `kit/sales/skill/deploy`? Run `aireg registry show kit` to see what it publishes.",
      }),
    );
  });
});

describe("insideRegistry", () => {
  async function registryAt(): Promise<string> {
    const root = await mkdtemp(join(scratch, "aireg-inside-"));
    await writeFile(join(root, "registry.json"), "{}");
    await mkdir(join(root, "artifacts/engineering/skill/pr-review/1.2.0"), { recursive: true });
    return root;
  }

  test("leaves an address that names no folder inside a registry alone", async () => {
    const root = await registryAt();
    expect(await insideRegistry("acme/engineering/pr-review", root)).toBeUndefined();
    expect(await insideRegistry("https://github.com/acme/registry", root)).toBeUndefined();
    expect(await insideRegistry(".", root)).toBeUndefined();
    expect(await insideRegistry("./missing", root)).toBeUndefined();
  });

  test("walks a folder up to its registry, and names the artifact in it", async () => {
    const root = await registryAt();
    expect(await insideRegistry("./artifacts/engineering/skill/pr-review", root)).toEqual({
      registry: ".",
      flags: {},
      address: "engineering/skill/pr-review",
    });
    const version = join(root, "artifacts/engineering/skill/pr-review/1.2.0");
    expect(await insideRegistry(version, root)).toEqual({
      registry: root,
      flags: {},
      address: "engineering/skill/pr-review@1.2.0",
    });
    expect(
      await insideRegistry(
        "../pr-review/1.2.0",
        join(root, "artifacts/engineering/skill/pr-review"),
      ),
    ).toMatchObject({ registry: "../../../..", address: "engineering/skill/pr-review@1.2.0" });
  });

  test("leaves a folder no registry holds to be read as a source of its own", async ({ tmp }) => {
    expect(await insideRegistry(tmp, tmp)).toBeUndefined();
  });

  test("refuses a folder inside a registry that is not an artifact", async () => {
    const root = await registryAt();
    await expect(insideRegistry("./artifacts/engineering", root)).rejects.toThrow(
      expect.objectContaining({ code: "usage" }),
    );
  });

  test("splits a pasted link into the registry's folder and the artifact", async () => {
    const link =
      "https://github.com/acme/tools/tree/main/registry/artifacts/engineering/skill/pr-review/1.2.0";
    expect(await insideRegistry(link, "/")).toEqual({
      registry: "github.com/acme/tools",
      flags: { ref: "main", path: "registry" },
      address: "engineering/skill/pr-review@1.2.0",
    });
    expect(
      await insideRegistry(
        "https://github.com/acme/tools/tree/main/artifacts/ops/agent/triage",
        "/",
      ),
    ).toEqual({
      registry: "github.com/acme/tools",
      flags: { ref: "main" },
      address: "ops/agent/triage",
    });
  });
});
