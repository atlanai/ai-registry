import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BUILTIN_TARGETS } from "#targets/index.ts";

// A shared folder is no program of its own, so nothing could load what is placed there.
const TOOLS = BUILTIN_TARGETS.filter((target) => target.category !== "shared-folder");

test.each(TOOLS.map((target) => target.id))(
  "has an EVIDENCE.md, a conformance test and a JSON twin for %s",
  (id) => {
    const files = [
      join(import.meta.dirname, id, "EVIDENCE.md"),
      join(import.meta.dirname, `${id}.test.ts`),
      join(import.meta.dirname, "..", "fixtures", "targets", `${id}.json`),
    ];
    expect(files.filter((file) => !existsSync(file))).toEqual([]);
  },
);
