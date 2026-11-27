import { conformance } from "#test/conformance/kit.ts";

// Both commands list what Devin loaded without signing in; in-process starts no daemon. It
// prints a linked skill's resolved path from the folder it runs in, and a name both scopes
// hold prefixed with the project's path.
const local = ["--process-model", "in-process"];

conformance({
  id: "devin",
  probes: [
    {
      scope: "project",
      argv: ["devin", "skills", "list", ...local],
      expect: [
        /lint \[user,model\] \(\.\/\.registry\/artifacts\/fx\/ns\/skills\/lint\) - Lints a change\./,
      ],
    },
    {
      scope: "project",
      argv: ["devin", "doctor", ...local],
      expect: [/custom subagent profiles +\d+ profile\(s\) loaded: .*reviewer/],
    },
    {
      scope: "user",
      argv: ["devin", "skills", "list", ...local],
      expect: [
        /\/lint \[user,model\] \(\.\/\.registry\/artifacts\/fx\/ns\/skills\/lint\) - Lints a change\./,
        /\/ship \[user,model\] \(\.\/\.registry\/artifacts\/kit\/kit\/skills\/ship\) - Ships a change\./,
      ],
    },
    {
      scope: "user",
      argv: ["devin", "doctor", ...local],
      expect: [/custom subagent profiles +\d+ profile\(s\) loaded: .*planner.*reviewer/],
    },
  ],
});
