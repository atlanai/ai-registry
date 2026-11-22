import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ArtifactRow } from "#core/console/model.ts";
import { joined } from "./page-state.ts";

const copy = join(homedir(), ".registry", "artifacts", "acme", "skills", "pr-review");

const row: ArtifactRow = {
  key: "engineering/pr-review",
  name: "pr-review",
  kind: "skill",
  registry: "acme",
  namespace: "engineering",
  id: "",
  version: "1.2.0",
  lockDigest: "sha256:1",
  diskDigest: "sha256:2",
  state: "ok",
  detail: undefined,
  targets: ["claude-code"],
  copy,
  changedAtMs: undefined,
  links: [{ target: "claude-code", path: copy, present: true, ok: true }],
};

test("shows paths under ~ and targets by name, and keeps where the copy is", () => {
  const [artifact] = joined([], [{ row, local: false }]);
  expect(artifact).toMatchObject({
    key: "acme/engineering/pr-review",
    installedVersion: "1.2.0",
    digest: "sha256:1",
    diskDigest: "sha256:2",
    path: "~/.registry/artifacts/acme/skills/pr-review",
    copy,
    installedKey: "engineering/pr-review",
  });
  expect(artifact?.harnesses).toEqual(["Claude Code"]);
  expect(artifact?.links[0]?.path).toBe("~/.registry/artifacts/acme/skills/pr-review");
});
