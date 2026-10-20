import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "openclaw",
  probes: [
    {
      scope: "user",
      argv: ["openclaw", "skills", "list", "--json"],
      expect: [
        /"name": "lint",[^}]*"source": "openclaw-managed"/,
        /"name": "ship",[^}]*"source": "openclaw-managed"/,
      ],
    },
  ],
});
