import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "claude",
  env: (home) => ({ CLAUDE_CONFIG_DIR: `${home}/.claude` }),
  probes: [
    { scope: "user", argv: ["claude", "plugin", "list", "--json"], expect: [/"kit@skills-dir"/] },
    {
      scope: "user",
      argv: ["claude", "plugin", "details", "kit"],
      expect: [/Skills \(1\)\s+ship/, /Agents \(1\)\s+planner/],
    },
    // Lists what a session loads, then stops before it needs an account.
    {
      scope: "project",
      argv: ["claude", "-p", "/context"],
      expect: [
        /\| lint \| User \|/,
        /\| reviewer \| Project \|/,
        /\| kit:ship \| Plugin \(kit\) \|/,
        /\| kit:planner \| Plugin \|/,
      ],
    },
  ],
});
