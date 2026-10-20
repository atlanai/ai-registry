import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "devin",
  env: (home) => ({ XDG_CONFIG_HOME: `${home}/.config` }),
  probes: [
    {
      scope: "project",
      argv: ["devin", "skills", "list", "--json"],
      expect: [/"base_dir": "[^"]*\/project\/\.agents\/skills\/lint"/],
    },
    // It lists agents only among the checks of its configuration.
    {
      scope: "project",
      argv: ["devin", "doctor", "--json"],
      expect: [/profile\(s\) loaded: [^"]*\breviewer\b/],
    },
    {
      scope: "user",
      argv: ["devin", "skills", "list", "--json"],
      expect: [
        /"base_dir": "[^"]*\/\.agents\/skills\/lint"/,
        /"base_dir": "[^"]*\/\.agents\/skills\/ship"/,
      ],
    },
    {
      scope: "user",
      argv: ["devin", "doctor", "--json"],
      expect: [/profile\(s\) loaded: [^"]*\bplanner\b/, /profile\(s\) loaded: [^"]*\breviewer\b/],
    },
  ],
});
