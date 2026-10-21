import { list } from "#adapter/text.ts";
import { STEP_POLICIES } from "#core/config/model.ts";
import type { OptionSpec } from "#core/host/extend.ts";

const policy = (name: string, what: string): OptionSpec => ({
  flag: `--${name}`,
  value: "<policy>",
  describe: `${what}: ${list(STEP_POLICIES, "or")}`,
});

export const POLICIES: readonly OptionSpec[] = [
  policy("pull", "What to do with changes the registry made"),
  policy("publish", "What to do with edits made here"),
  policy("delete", "What to do with artifacts deleted here"),
  policy("adopt", "What to do with artifacts no registry has yet"),
  policy("claim", "Whether to manage a folder that matches the registry"),
];

export const TOKEN_STDIN: OptionSpec = {
  flag: "--token-stdin",
  describe: "Read the registry's token from standard input",
};

export const REGISTRY: OptionSpec = {
  flag: "--registry",
  short: "-r",
  value: "<registry>",
  describe: "The registry, by name or address",
};

export const NAMESPACE: OptionSpec = {
  flag: "--namespace",
  value: "<namespace>",
  describe: "The namespace in the registry",
};
