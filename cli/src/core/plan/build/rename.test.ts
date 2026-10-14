import { describe, expect } from "vitest";
import type { Entry } from "#core/catalog/model.ts";
import { emptyLock } from "#core/lock.ts";
import { type BuildOptions, build } from "#core/plan/build.ts";
import type { Action, Plan } from "#core/plan/model.ts";
import { parseRef, withLocalName } from "#core/ref.ts";
import { acquired, entry, kitManifest, PLAN_OPTIONS } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";

const member = (group: string, name = "pr-review", kind: Entry["kind"] = "skill"): Entry =>
  entry({
    name,
    kind,
    group,
    path: kind === "agent" ? `agents/${group}/${name}.md` : `skills/${group}/${name}`,
  });

const RENAME: BuildOptions = { ...PLAN_OPTIONS, nameCollision: "rename" };

function plan(refs: string[], entries: Entry[], options = RENAME): Plan {
  const contents = new Map(entries.map((item) => [item.path, `sha256:${item.path}`]));
  return build(
    kitManifest(refs),
    emptyLock(),
    acquired(entries, "c1", contents),
    { artifacts: {} },
    options,
  );
}

const linkFor = (actions: readonly Action[], name: string) =>
  actions.find((action) => action.kind === "link" && action.name === name);

describe("an artifact whose name another holds", () => {
  test("installs under its namespace and name, as a copy whose front matter says so", () => {
    const planned = plan(
      ["kit/design", "kit/engineering"],
      [member("design"), member("engineering")],
    );
    expect(planned.clashes).toEqual([]);
    expect(planned.renamed).toEqual([
      {
        artifact: "kit/engineering/skill/pr-review",
        as: "engineering-pr-review",
        by: "kit/design/skill/pr-review",
      },
    ]);
    expect(linkFor(planned.actions, "engineering-pr-review")).toMatchObject({
      copy: true,
      rename: "engineering-pr-review",
      to: "/work/.claude/skills/engineering-pr-review",
    });
    expect(linkFor(planned.actions, "design/pr-review")).toMatchObject({ copy: false });
    expect(linkFor(planned.actions, "design/pr-review")).not.toHaveProperty("rename");
  });

  test("takes the registry's name too when its namespace and name are taken", () => {
    const planned = plan(
      ["kit/design", "kit/engineering", "kit/tools"],
      [member("design"), member("engineering"), member("tools", "engineering-pr-review")],
    );
    expect(planned.renamed.map((item) => item.as)).toEqual(["kit-engineering-pr-review"]);
  });

  test("never renames one whose name was written with `as:`", () => {
    const manifest = kitManifest(["kit/design"]);
    manifest.artifacts.push(
      withLocalName(parseRef("kit/engineering/skill/pr-review"), "pr-review"),
    );
    const entries = [member("design"), member("engineering")];
    const planned = build(
      manifest,
      emptyLock(),
      acquired(entries, "c1", new Map(entries.map((item) => [item.path, `sha256:${item.path}`]))),
      { artifacts: {} },
      RENAME,
    );
    expect(planned.renamed).toEqual([]);
    expect(planned.clashes).toEqual([
      expect.objectContaining({ name: "pr-review", dropped: "kit/engineering/skill/pr-review" }),
    ]);
  });
});
