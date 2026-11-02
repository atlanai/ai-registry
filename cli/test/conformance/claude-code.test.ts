import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "claude-code",
  env: (home) => ({ CLAUDE_CONFIG_DIR: `${home}/.claude` }),
  probes: [
    // A registry's namespaces load as one plugin from aireg's marketplace, once a person accepts
    // the command its entry names; `aireg targets setup` runs these for them.
    {
      scope: "user",
      argv: ["claude", "plugin", "marketplace", "add", "./.claude/aireg"],
      expect: [/marketplace: aireg/],
    },
    {
      scope: "user",
      argv: ["claude", "plugin", "validate", "./.claude/aireg/kit"],
      expect: [/Validation passed/],
    },
    {
      scope: "user",
      argv: ["claude", "plugin", "marketplace", "list"],
      expect: [/aireg/],
    },
    // Lists what a session loads, then stops before it needs an account.
    {
      scope: "project",
      argv: ["claude", "-p", "/context"],
      expect: [/\| lint \| User \|/, /\| reviewer \| Project \|/],
    },
  ],
});
