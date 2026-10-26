import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "github-copilot",
  // Without COPILOT_AUTO_UPDATE, Copilot may fetch a newer version and run that instead.
  env: (home) => ({ COPILOT_HOME: `${home}/.copilot`, COPILOT_AUTO_UPDATE: "false" }),
  probes: [
    // A project skill wins over a personal one of the same name.
    {
      scope: "project",
      argv: ["copilot", "skill", "list", "--json"],
      expect: [/"path": "[^"]*\/project\/\.github\/skills\/lint"/],
    },
    {
      scope: "user",
      argv: ["copilot", "skill", "list", "--json"],
      expect: [
        /"path": "[^"]*\/\.copilot\/skills\/lint"/,
        /"path": "[^"]*\/\.copilot\/skills\/ship"/,
      ],
    },
  ],
});
