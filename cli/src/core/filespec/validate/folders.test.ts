import { describe, expect, test } from "vitest";
import { type KindManifest, kindsOf } from "#core/filespec/kind-manifests.ts";
import { fractionProblems, versionProblems } from "./folders.ts";

describe("fractionProblems", () => {
  test("names each number an envelope cannot hold, by its field", () => {
    const spec = { name: "review", metadata: { threshold: 0.85, limits: [{ rows: 1e21 }] } };
    expect(fractionProblems(spec)).toEqual([
      "`metadata.threshold` is 0.85, and an envelope takes whole numbers only: write it as a string",
      "`metadata.limits.0.rows` is 1e+21, and an envelope takes whole numbers only: write it as a string",
    ]);
  });

  test("passes whole numbers, text and nothing at all", () => {
    expect(fractionProblems({ count: 3, ratio: "0.85", empty: null, list: [1, 2] })).toEqual([]);
  });
});

describe("versionProblems for a semantic model", async () => {
  const manifest = (await kindsOf(undefined)).semantic_model as KindManifest;
  const at = { kind: "semantic_model", name: "retail" };
  const problems = (model: string, file = "semantic_model.yaml") =>
    versionProblems(manifest, at, new Set([file]), new Map([[file, model]]));

  test("passes a model that satisfies the Ossie version it declares", () => {
    const model =
      "version: 0.2.0.dev0\nname: Retail\ndatasets:\n  - name: sales\n    source: db.sales\n";
    expect(problems(model)).toEqual([]);
  });

  test("finds a placeholder left inside a list", () => {
    const model =
      "version: 0.2.0.dev0\nname: Retail\ndatasets:\n  - name: TODO\n    source: db.sales\n";
    expect(problems(model)).toEqual(["semantic_model.yaml: `datasets.0.name` is still TODO"]);
  });

  test("passes a decimal, which the file keeps and the envelope never holds", () => {
    const model =
      "version: 0.2.0.dev0\nname: Retail\nai_context:\n  threshold: 0.85\ndatasets:\n  - name: sales\n    source: db.sales\n";
    expect(problems(model)).toEqual([]);
  });

  test("refuses a 0.1.1 file that lists several models, and says to split it", () => {
    const one = (name: string) =>
      `  - name: ${name}\n    datasets:\n      - name: t\n        source: db.t\n`;
    const model = `version: "0.1.1"\nsemantic_model:\n${one("sales")}${one("customers")}`;
    expect(problems(model)).toEqual([
      "semantic_model.yaml: lists 2 models under `semantic_model`, and an artifact holds one: split it into one artifact per model",
    ]);
  });

  test("refuses a 0.1.1 file that lists no model", () => {
    expect(problems('version: "0.1.1"\nsemantic_model: []\n')).toEqual([
      "semantic_model.yaml: lists no model under `semantic_model`, and an artifact holds one",
    ]);
  });

  test("names the file that does not parse", () => {
    expect(problems("version: [\n")[0]).toMatch(/^semantic_model\.yaml does not parse: /);
  });

  test("asks for exactly one of the two files", () => {
    expect(versionProblems(manifest, at, new Set(["notes.md"]), new Map())).toEqual([
      "has no semantic_model.yaml or semantic_model.json",
      "has no front matter to read its fields from",
    ]);
  });
});
