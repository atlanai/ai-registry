import { conformance } from "#test/conformance/kit.ts";

// A project's skills load only in a trusted workspace, so they are checked at L1 alone.
conformance({
  id: "muse",
  probes: [
    {
      scope: "user",
      argv: ["muse", "skills", "list", "--source", "user", "--json"],
      expect: [
        /"path": "\$HOME\/\.agents\/skills\/lint\/SKILL\.md"/,
        /"path": "\$HOME\/\.agents\/skills\/ship\/SKILL\.md"/,
      ],
    },
  ],
});
