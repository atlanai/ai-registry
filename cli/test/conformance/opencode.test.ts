import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "opencode",
  // So a probe runs the version tested, rather than one it updated itself to.
  env: () => ({ OPENCODE_DISABLE_AUTOUPDATE: "1" }),
  probes: [
    // A skill both scopes hold loads once, from either.
    {
      scope: "project",
      argv: ["opencode", "debug", "skill"],
      expect: [/"location": "[^"]*\/\.agents\/skills\/lint\/SKILL\.md"/],
    },
    { scope: "project", argv: ["opencode", "agent", "list"], expect: [/^reviewer \(all\)$/m] },
    {
      scope: "user",
      argv: ["opencode", "debug", "skill"],
      expect: [
        /"location": "[^"]*\/\.agents\/skills\/lint\/SKILL\.md"/,
        /"location": "[^"]*\/\.agents\/skills\/ship\/SKILL\.md"/,
      ],
    },
    {
      scope: "user",
      argv: ["opencode", "agent", "list"],
      expect: [/^planner \(all\)$/m, /^reviewer \(all\)$/m],
    },
  ],
});
