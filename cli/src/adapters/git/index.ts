import { defineAdapter, KINDS, onPath } from "#adapter/index.ts";
import { connect } from "./connect.ts";
import { CREDENTIALS, ID } from "./errors.ts";
import { gitVersion } from "./exec.ts";

export default defineAdapter({
  id: ID,
  displayName: "Git",
  artifactKinds: [...KINDS],
  dispatch: { schemes: ["http", "https", "ssh", "file"] },
  configSchema: {
    properties: { ref: { type: "string" }, path: { type: "string" }, layout: { type: "string" } },
  },
  capabilities: { pinsSource: true, publish: false, auth: false },
  credentialsHint: CREDENTIALS,
  readOnly: {
    message: "{registry} is a git registry, and aireg does not publish to git.",
    instead: "publish into a local clone with `{how}`, then push it with git",
  },
  async ready() {
    const version = await gitVersion();
    return [
      {
        name: "git",
        ok: version !== undefined,
        detail: version ?? "not on your PATH; needed for git registries",
      },
      {
        name: "gh",
        ok: true,
        detail: onPath("gh") ? "available for private repositories" : "not installed",
      },
    ];
  },
  connect,
});
