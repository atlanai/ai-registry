import { defineAdapter, KINDS } from "#adapter/index.ts";
import { connect } from "./connect.ts";
import { ID } from "./errors.ts";

// Publishes no `plugin`: the spec's version folders are per kind, and a plugin is a projection
// of a namespace rather than a kind a root stores.
export default defineAdapter({
  id: ID,
  displayName: "Local directory",
  artifactKinds: [...KINDS],
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
