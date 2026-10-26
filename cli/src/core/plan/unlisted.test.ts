import { describe, expect, it } from "vitest";
import { build } from "#core/plan/build.ts";
import {
  acquired,
  entry,
  installed,
  kitManifest,
  PLAN_OPTIONS,
  SYNCED,
} from "#test/kit/builders/plan.ts";
import { unlistedRows } from "./unlisted.ts";

/** A registry read whole this run, so an empty listing is all it lists. */
const readWhole = (...args: Parameters<typeof acquired>) =>
  acquired(...args).map((source) => ({ ...source, whole: true }));

const readComplete = (entries = [entry({ name: "fmt", path: "skills/fmt" })]) =>
  readWhole(entries).map((source) => ({
    ...source,
    catalog: { ...source.catalog, complete: true },
  }));

describe("unlistedRows", () => {
  it("finds a row the manifest asks for that its registry no longer lists", () => {
    const rows = unlistedRows(
      kitManifest(),
      installed(),
      acquired([entry({ name: "fmt", path: "skills/fmt" })]),
    );
    expect(rows).toEqual([{ name: "lint", registry: "kit", empty: false }]);
  });

  it("says so when the registry lists nothing at all", () => {
    expect(unlistedRows(kitManifest(), installed(), readWhole([]))).toEqual([
      { name: "lint", registry: "kit", empty: true },
    ]);
  });

  it("does not call a registry empty when the run asked it for only some artifacts", () => {
    expect(unlistedRows(kitManifest(), installed(), acquired([]))).toEqual([
      { name: "lint", registry: "kit", empty: false },
    ]);
  });

  it("leaves a row that is still listed, and one the manifest no longer asks for", () => {
    expect(unlistedRows(kitManifest(), installed(), acquired([entry()]))).toEqual([]);
    expect(unlistedRows(kitManifest([]), installed(), acquired([]))).toEqual([]);
  });

  it("leaves a row a whole-registry entry excludes, as `aireg remove` writes it", () => {
    expect(unlistedRows(kitManifest(["kit"]), installed(), acquired([]))).toHaveLength(1);
    const manifest = kitManifest(["kit"]);
    const [whole] = manifest.artifacts;
    if (whole !== undefined) whole.exclude = ["skill/lint"];
    expect(unlistedRows(manifest, installed(), acquired([]))).toEqual([]);
  });
});

describe("unlistedRows, for a listing its adapter says is complete", () => {
  it("leaves out a row only a whole-registry entry reaches", () => {
    expect(unlistedRows(kitManifest(["kit"]), installed(), readComplete())).toEqual([]);
  });

  it("keeps a row an entry names", () => {
    expect(unlistedRows(kitManifest(), installed(), readComplete())).toEqual([
      { name: "lint", registry: "kit", empty: false },
    ]);
  });

  it("keeps a row when the listing is empty", () => {
    expect(unlistedRows(kitManifest(["kit"]), installed(), readComplete([]))).toEqual([
      { name: "lint", registry: "kit", empty: true },
    ]);
  });

  it("keeps a row when the run did not read the registry whole", () => {
    const partial = readComplete().map((source) => ({ ...source, whole: false }));
    expect(unlistedRows(kitManifest(["kit"]), installed(), partial)).toEqual([
      { name: "lint", registry: "kit", empty: false },
    ]);
  });
});

describe("a plan over a registry that stopped listing a row", () => {
  it("keeps the row and unlinks nothing", () => {
    const plan = build(kitManifest(), installed(), readWhole([]), SYNCED, PLAN_OPTIONS);
    expect(plan.actions.filter((action) => action.kind === "unlink")).toEqual([]);
    const record = plan.actions.find((action) => action.kind === "record");
    expect(record?.kind === "record" && Object.keys(record.lock.artifacts)).toEqual(["lint"]);
    expect(plan.unlisted).toEqual([{ name: "lint", registry: "kit", empty: true }]);
  });

  it("still removes a row the manifest dropped", () => {
    const plan = build(kitManifest([]), installed(), acquired([]), SYNCED, PLAN_OPTIONS);
    expect(plan.actions.some((action) => action.kind === "unlink")).toBe(true);
    expect(plan.unlisted).toEqual([]);
  });
});
