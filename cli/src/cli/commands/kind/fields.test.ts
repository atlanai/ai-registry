import { describe, expect, test } from "vitest";
import { type KindManifest, kindsOf } from "#core/filespec/kind-manifests.ts";
import { versionProblems } from "#core/filespec/validate/folders.ts";
import { renderDocument, starterModel } from "./fields.ts";

describe("starterModel", () => {
  test("is a valid Ossie model once its placeholders are written", async () => {
    const manifest = (await kindsOf(undefined)).semantic_model as KindManifest;
    const { document, todo } = starterModel("retail");
    const text = renderDocument("semantic_model.yaml", document);
    expect(text.startsWith("version: 0.1.1\n")).toBe(true);
    expect(todo).toEqual(["description", "datasets"]);
    const problems = (model: string) =>
      versionProblems(
        manifest,
        { kind: "semantic_model", name: "retail" },
        new Set(["semantic_model.yaml"]),
        new Map([["semantic_model.yaml", model]]),
      );
    // Only the placeholders are wrong, so the file is the right shape for its version.
    expect(problems(text)).toEqual([
      "`description` is still TODO",
      "`model.semantic_model.0.description` is still TODO",
      "`model.semantic_model.0.datasets.0.name` is still TODO",
      "`model.semantic_model.0.datasets.0.source` is still TODO",
    ]);
    expect(problems(text.replaceAll("TODO", "sales"))).toEqual([]);
  });

  test("renders a JSON model as JSON", () => {
    const text = renderDocument("semantic_model.json", starterModel("retail").document);
    expect(JSON.parse(text).semantic_model[0].name).toBe("retail");
  });
});
