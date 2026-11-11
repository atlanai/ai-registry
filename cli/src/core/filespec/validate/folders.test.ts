import { describe, expect, test } from "vitest";
import { type KindManifest, kindsOf } from "#core/filespec/kind-manifests.ts";
import { fractionProblems, versionProblems } from "./folders.ts";

describe("fractionProblems", () => {
  test("names each number an envelope cannot hold, by its field", () => {
    const spec = {
      name: "retail",
      model: { ai_context: { threshold: 0.85 }, datasets: [{ name: "sales", rows: 1e21 }] },
    };
    expect(fractionProblems(spec)).toEqual([
      "`model.ai_context.threshold` is 0.85, and an envelope takes whole numbers only: write it as a string",
      "`model.datasets.0.rows` is 1e+21, and an envelope takes whole numbers only: write it as a string",
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
    expect(problems(model)).toEqual(["`model.datasets.0.name` is still TODO"]);
  });

  test("asks for exactly one of the two files", () => {
    expect(versionProblems(manifest, at, new Set(["notes.md"]), new Map())).toEqual([
      "has no semantic_model.yaml or semantic_model.json",
      "has no front matter to read its fields from",
    ]);
  });
});
