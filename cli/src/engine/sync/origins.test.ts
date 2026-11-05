import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Step } from "#core/config/model.ts";
import { digest } from "#core/fs/digest.ts";
import { emptyLock, type Lock, writeLock } from "#core/lock.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { lock as lockOf } from "#test/kit/builders/lock.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  applyOrigins,
  forgetOrigins,
  recordServed,
  surveyOrigins,
  takeIntoOrigins,
} from "./origins.ts";
import type { Scan } from "./scan.ts";

let home: string;
let roots: Roots;

function step(over: Partial<Step> = {}): Step {
  return {
    name: "mine",
    kind: "origins",
    needs: [],
    to: "kit/mine",
    select: [{ from: join(home, ".claude", "skills") }],
    policy: "on",
    extra: {},
    ...over,
  };
}

const origin = () => join(home, ".claude", "skills", "my-helper", "SKILL.md");
const copy = () =>
  join(home, ".registry", "artifacts", "kit", "mine", "skills", "my-helper", "SKILL.md");

async function write(body: string): Promise<void> {
  await mkdir(join(home, ".claude", "skills", "my-helper"), { recursive: true });
  await writeFile(origin(), `---\nname: my-helper\ndescription: mine\n---\n${body}\n`);
}

async function runOnce(lock: Lock, steps = [step()]): Promise<void> {
  await applyOrigins(await surveyOrigins(steps, lock, roots), lock, roots);
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  roots = makeRoots("project", home);
});

describe("an origins step", () => {
  test("copies the folder in and leaves it exactly where it was", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);

    expect(await readFile(copy(), "utf8")).toContain("One.");
    expect((await lstat(origin())).isSymbolicLink()).toBe(false);
    expect(await readFile(origin(), "utf8")).toContain("One.");
  });

  test("writes a row whose origin is what makes it yours", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);

    const row = lock.artifacts["mine/my-helper"];
    expect(row?.origin).toMatchObject({ target: "claude-code", step: "mine" });
    expect(row?.kind).toBe("skill");
    // Upstream assigns these on the first publish; before that there are none.
    expect(row?.id).toBeUndefined();
    expect(row?.content).toBeUndefined();
    expect(row?.links).toEqual([]);
  });

  test("re-reads the origin every run, keeping what the registry assigned", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);
    const assigned = {
      id: "artifacts/mine/skill/my-helper/0.1.0",
      address: "artifacts/mine/skill/my-helper",
      content: "sha256:c",
      version: "0.1.0",
    };
    Object.assign(lock.artifacts["mine/my-helper"] ?? {}, assigned);
    const first = lock.artifacts["mine/my-helper"]?.digest;

    await write("Two.");
    await runOnce(lock);
    expect(await readFile(copy(), "utf8")).toContain("Two.");
    expect(lock.artifacts["mine/my-helper"]).toMatchObject(assigned);
    expect(lock.artifacts["mine/my-helper"]?.digest).not.toBe(first);
  });

  test("does nothing on a run where the origin has not moved", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);

    const outcomes = await surveyOrigins([step()], lock, roots);
    expect(outcomes.map((item) => item.state)).toEqual(["unchanged"]);
  });

  test("keeps the copy and the row of an origin that is gone", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);
    await rm(join(home, ".claude", "skills", "my-helper"), { recursive: true });

    await runOnce(lock);
    // A step that deletes is a step that deletes by accident.
    expect(await readFile(copy(), "utf8")).toContain("One.");
    expect(lock.artifacts["mine/my-helper"]).toBeDefined();
  });

  test("never offers a copy another registry installed into the watched folder", async () => {
    await write("Mine.");
    const placed = join(home, ".claude", "skills", "eng", "skills", "stamp");
    await mkdir(placed, { recursive: true });
    await writeFile(join(placed, "SKILL.md"), "---\nname: stamp\ndescription: theirs\n---\nbody\n");
    const lock = lockOf()
      .artifact("eng/stamp", {
        registry: "other",
        id: "artifacts/eng/skill/stamp/0.1.0",
        namespace: "eng",
        address: "artifacts/eng/skill/stamp",
        content: "sha256:0",
        version: "0.1.0",
        path: ".registry/artifacts/other/eng/skills/stamp",
        digest: "sha256:0",
        links: [{ target: "claude-code", path: ".claude/skills/eng", mode: "copy" }],
      })
      .build();

    const outcomes = await surveyOrigins([step()], lock, roots);
    expect(outcomes.map((outcome) => outcome.origin.name)).toEqual(["my-helper"]);
  });

  test("honors a match that excludes a draft", async () => {
    await write("One.");
    await mkdir(join(home, ".claude", "skills", "draft-thing"), { recursive: true });
    await writeFile(
      join(home, ".claude", "skills", "draft-thing", "SKILL.md"),
      "---\nname: draft-thing\ndescription: wip\n---\nWip.\n",
    );

    const lock = emptyLock();
    await runOnce(lock, [
      step({ select: [{ from: join(home, ".claude", "skills"), match: "!(draft-*)" }] }),
    ]);
    expect(Object.keys(lock.artifacts)).toEqual(["mine/my-helper"]);
  });
});

describe("forgetOrigins", () => {
  test("unlinks what a pull linked to the copy, and leaves the folder", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);
    const link = join(home, ".agents", "skills", "my-helper");
    await mkdir(join(link, ".."), { recursive: true });
    await symlink(join(copy(), ".."), link);
    lock.artifacts["mine/my-helper"]?.links.push({
      target: "universal",
      path: ".agents/skills/my-helper",
      mode: "symlink",
    });
    await writeLock(roots, lock);

    await forgetOrigins(roots, "kit", [join(home, ".claude", "skills")]);
    await expect(lstat(link)).rejects.toThrow();
    expect(await readFile(origin(), "utf8")).toContain("One.");
  });
});

describe("takeIntoOrigins", () => {
  test("writes the registry's copy into your folder, and keeps yours in backups", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);
    await writeLock(roots, lock);
    await writeFile(copy(), "---\nname: my-helper\ndescription: mine\n---\nTheirs.\n");
    await write("Mine.");

    const [taken] = await takeIntoOrigins(roots, ["mine/my-helper"], "20260101T000000Z");
    expect(taken?.written).toBe(true);
    expect(await readFile(origin(), "utf8")).toContain("Theirs.");
    expect(await readFile(join(taken?.backup ?? "", "SKILL.md"), "utf8")).toContain("Mine.");
  });
});

describe("recordServed", () => {
  const address = "artifacts/mine/skill/my-helper";
  const scan = (disposition: string) =>
    ({
      items: [{ name: "mine/my-helper", disposition }],
      acquired: [
        {
          alias: "kit",
          catalog: {
            entries: [{ kind: "skill", name: "my-helper", group: "mine", path: address }],
          },
          placements: new Map([
            [address, { id: `${address}/0.1.0`, contentId: "sha256:c", version: "0.1.0" }],
          ]),
        },
      ],
    }) as unknown as Scan;

  test("takes what the registry assigned only once it serves exactly this copy", async () => {
    await write("One.");
    const lock = emptyLock();
    await runOnce(lock);
    const unpublished = structuredClone(lock);

    recordServed(lock, scan("publish"), ["mine/my-helper"]);
    expect(lock).toEqual(unpublished);
    recordServed(lock, scan("synced"), ["mine/my-helper"]);
    expect(lock.artifacts["mine/my-helper"]).toMatchObject({
      id: `${address}/0.1.0`,
      address,
      content: "sha256:c",
      version: "0.1.0",
    });
  });
});

describe("an origins step over a folder holding a link", () => {
  test("refuses the folder rather than copying what the link points at", async () => {
    await write("One.");
    await writeFile(join(home, "outside-secret"), "CANARY");
    await symlink(
      join(home, "outside-secret"),
      join(home, ".claude", "skills", "my-helper", "notes.md"),
    );
    const lock = emptyLock();
    const outcomes = await surveyOrigins([step()], lock, roots);

    expect(outcomes.map(({ state, reason }) => ({ state, reason }))).toEqual([
      {
        state: "refused",
        reason: "my-helper/notes.md is a symlink; an artifact holds regular files only",
      },
    ]);
    await applyOrigins(outcomes, lock, roots);
    await expect(lstat(copy())).rejects.toThrow();
    expect(lock.artifacts["mine/my-helper"]).toBeUndefined();
  });

  test("leaves litter out of the copy and still sees the copy as unedited", async () => {
    await write("One.");
    await writeFile(join(home, ".claude", "skills", "my-helper", ".DS_Store"), "x");
    const lock = emptyLock();
    await runOnce(lock);

    const row = lock.artifacts["mine/my-helper"];
    await expect(lstat(join(copy(), "..", ".DS_Store"))).rejects.toThrow();
    expect(row?.digest).toBe(await digest(join(copy(), "..")));
    expect((await surveyOrigins([step()], lock, roots))[0]?.state).toBe("unchanged");
  });
});
