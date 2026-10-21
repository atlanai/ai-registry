import { defineAdapter, KINDS } from "#adapter/index.ts";
import { connect } from "./connect.ts";
import { ID } from "./errors.ts";

export default defineAdapter({
  id: ID,
  displayName: "Local directory",
  artifactKinds: [...KINDS],
  // The spec's version directories are per kind, and `plugin` is a projection
  // of a namespace rather than a kind a root stores.
  publishKinds: ["skill", "agent"],
  dispatch: { paths: true },
  configSchema: { properties: { layout: { type: "string" } } },
  capabilities: {
    pinsSource: false,
    publish: true,
    auth: false,
    fileSpec: true,
    relationships: true,
    agentFolders: true,
  },
  connect,
});
