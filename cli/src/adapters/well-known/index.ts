import { defineAdapter } from "#adapter/index.ts";
import { connect } from "./connect.ts";
import { ID } from "./errors.ts";

// Claims any web address but a code host's or a repository's: a git URL stays git's.
export default defineAdapter({
  id: ID,
  displayName: "Agent Skills index",
  artifactKinds: ["skill"],
  dispatch: {
    sites: {
      schemes: ["https", "http"],
      exceptHosts: ["github.com", "gitlab.com", "bitbucket.org"],
      exceptSuffixes: [".git"],
    },
  },
  configSchema: { properties: { layout: { type: "string" } } },
  capabilities: { pinsSource: false, publish: false, auth: false },
  readOnly: {
    message: "{registry} is a site's skills index, and aireg reads it but does not publish to it.",
    instead:
      "publish to a registry of your own, made with `aireg registry init <folder>`, with `{how}`",
  },
  connect,
});
