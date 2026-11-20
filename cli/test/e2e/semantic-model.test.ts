import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, type Git, fileTest as test } from "#test/kit/fixtures.ts";

const OSSIE = join(import.meta.dirname, "..", "fixtures", "ossie");
/** Where a project keeps an installed model: no coding agent has a folder for one. */
const INSTALLED = ".registry/artifacts/acme/analytics/semantic_models/retail";

let aireg: Aireg;
let git: Git;
let registry: string;
let project: string;

const model = (version: string, file = "semantic_model.yaml") =>
  join(registry, "artifacts", "analytics", "semantic_model", "retail", version, file);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const inRegistry = (args: string[]) => aireg(args, { cwd: registry });

test.beforeAll(async ({ aireg: run, git: gitIn, tmp, project: dir }) => {
  [aireg, git, project] = [run, gitIn, dir];
  registry = join(tmp, "acme");
  await git.init(project);
  // A coding agent is in use here, and still nothing of a model is placed in its folder.
  await mkdir(join(project, ".claude"));
  const init = ["registry", "init", registry, "--name", "acme", "--namespace", "analytics", "-y"];
  expect((await aireg(init, { cwd: tmp })).code).toBe(0);
});

describe("a data team publishes a semantic model once", () => {
  test("refuses a file that is not a semantic model before it enters the registry", async () => {
    const ontology = join(OSSIE, "invalid-flights-ontology.yaml");
    const refused = await inRegistry([
      "semantic_model",
      "new",
      "--from",
      ontology,
      "--name",
      "flights",
      "--namespace",
      "analytics",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is not a valid semantic_model");
    expect(refused.stderr).toContain("`model.datasets` is required");
    expect(existsSync(join(registry, "artifacts", "analytics", "semantic_model"))).toBe(false);
  });

  test("copies in a model under the kind's file name, whatever the file was called", async () => {
    const copied = await inRegistry([
      "semantic_model",
      "new",
      "--from",
      join(OSSIE, "tpcds_semantic_model.yaml"),
      "--name",
      "retail",
      "--namespace",
      "analytics",
    ]);
    expect(copied.code, copied.stderr).toBe(0);
    expect(await readFile(model("0.1.0"), "utf8")).toBe(
      await readFile(join(OSSIE, "tpcds_semantic_model.yaml"), "utf8"),
    );
  });

  test("indexes it with the whole model in the envelope, under the registry's slug", async () => {
    const indexed = await inRegistry(["registry", "index"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    expect(indexed.stdout).toContain("analytics/semantic_model/retail  0.1.0");
    const envelope = await json(model("0.1.0", "artifact.json"));
    expect(envelope.kind).toBe("semantic_model");
    expect(envelope.spec.name).toBe("retail");
    expect(envelope.spec.model.name).toBe("tpcds_retail_model");
    expect(envelope.spec.model.metrics).toHaveLength(8);
    expect(envelope.metadata.description).toBe(envelope.spec.description);
    expect((await inRegistry(["registry", "validate"])).code).toBe(0);
    await git.init(registry);
    await git.commit(registry, "release retail 0.1.0");
  });

  test("names the field when a model holds a number an envelope cannot", async () => {
    expect(
      (await inRegistry(["semantic_model", "bump", "retail", "--namespace", "analytics"])).code,
    ).toBe(0);
    // Ossie lets `ai_context` be a free-form object, the one place its schema allows a number.
    const edited = (await readFile(model("0.1.1"), "utf8")).replace(
      /\nai_context:\n {2}instructions: [^\n]*\n/,
      "\nai_context:\n  threshold: 0.85\n",
    );
    expect(edited).toContain("threshold: 0.85");
    await writeFile(model("0.1.1"), edited);
    const refused = await inRegistry(["registry", "index"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("0.1.1: `model.ai_context.threshold` is 0.85");
    // Put right, so the versions below are the only ones the registry has.
    await cp(model("0.1.0"), model("0.1.1"));
    await writeFile(
      model("0.1.1"),
      (await readFile(model("0.1.1"), "utf8")).replace(
        "TPC-DS retail semantic model",
        "TPC-DS retail model, with returns",
      ),
    );
    const indexed = await inRegistry(["registry", "index"]);
    expect(indexed.code, indexed.stderr).toBe(0);
  });
});

describe("a project installs the model and takes its new versions", () => {
  test("finds it by what it describes", async () => {
    expect((await aireg(["registry", "add", registry, "--as", "acme"])).code).toBe(0);
    const found = await aireg(["search", "retail", "--kind", "semantic_model"]);
    expect(found.stdout).toContain("analytics/retail");
    expect(found.stdout).toContain("semantic_model");
  });

  test("keeps the file in the project and links it into no coding agent", async () => {
    const added = await aireg(["add", "acme/analytics/semantic_model/retail@0.1.0", "-y"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("Installed retail.");
    expect(added.stdout).toContain(INSTALLED);
    expect(added.stderr).not.toContain("installed into no target");
    expect(await readFile(join(project, INSTALLED, "semantic_model.yaml"), "utf8")).toBe(
      await readFile(model("0.1.0"), "utf8"),
    );
    expect(existsSync(join(project, ".claude", "semantic_models"))).toBe(false);
    const lock = await readFile(join(project, ".registry", "manifest.lock.yml"), "utf8");
    expect(lock).toContain("kind: semantic_model");
    expect(lock).toContain("version: 0.1.0");
  });

  test("lists it with where its file is, and reports it in step with the lockfile", async () => {
    const listed = await aireg(["list", "--json"]);
    const [row] = JSON.parse(listed.stdout).data.artifacts;
    expect(row).toMatchObject({ name: "retail", kind: "semantic_model", ref: "0.1.0" });
    expect(row.targets).toEqual([]);
    expect((await aireg(["list"])).stdout).toContain(INSTALLED);
    const status = await aireg(["status"]);
    expect(status.code, status.stdout).toBe(0);
    expect(status.stdout).toContain("Everything matches the lockfile.");
  });

  test("prints the model", async () => {
    const shown = await aireg(["show", "acme/analytics/semantic_model/retail"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("name: tpcds_retail_model");
  });

  test("says nothing changed when the same version is added again", async () => {
    const again = await aireg(["add", "acme/analytics/semantic_model/retail@0.1.0", "-y"]);
    expect(again.stdout).toContain("Already up to date.");
  });

  test("replaces the file with the newest version on update, once the pin is lifted", async () => {
    expect((await aireg(["add", "acme/analytics/semantic_model/retail", "-y"])).code).toBe(0);
    const installed = await readFile(join(project, INSTALLED, "semantic_model.yaml"), "utf8");
    expect(installed).toContain("TPC-DS retail model, with returns");
    const lock = await readFile(join(project, ".registry", "manifest.lock.yml"), "utf8");
    expect(lock).toContain("version: 0.1.1");
  });

  test("removes the file and its lockfile row", async () => {
    const removed = await aireg(["remove", "retail", "-y"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("Removed retail.");
    expect(existsSync(join(project, INSTALLED))).toBe(false);
  });
});

describe("a registry that serves its own semantic_model manifest", () => {
  test("validates a model against the Ossie schemas it serves beside the manifest", async ({
    tmp,
  }) => {
    const served = join(tmp, "served");
    const init = ["registry", "init", served, "--name", "served", "--namespace", "analytics", "-y"];
    expect((await aireg(init, { cwd: tmp })).code).toBe(0);
    const kinds = join(import.meta.dirname, "..", "..", "schema", "kinds");
    await cp(kinds, join(served, "kinds"), { recursive: true });
    const document = await json(join(served, "registry.json"));
    document.kinds = [{ name: "semantic_model", manifest_url: "kinds/semantic_model.json" }];
    await writeFile(join(served, "registry.json"), `${JSON.stringify(document, null, 2)}\n`);

    const from = (file: string, name: string) =>
      aireg(
        [
          "semantic_model",
          "new",
          "--from",
          join(OSSIE, file),
          "--name",
          name,
          "--namespace",
          "analytics",
        ],
        { cwd: served },
      );
    expect((await from("invalid-flights-ontology.yaml", "flights")).stderr).toContain(
      "`model.datasets` is required",
    );
    const released = await from("tpcds_semantic_model.v0.1.1.yaml", "retail");
    expect(released.code, released.stderr).toBe(0);
    const indexed = await aireg(["registry", "index"], { cwd: served });
    expect(indexed.code, indexed.stderr).toBe(0);
    expect((await aireg(["registry", "validate"], { cwd: served })).code).toBe(0);
  });
});
