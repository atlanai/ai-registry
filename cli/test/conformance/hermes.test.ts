import { conformance } from "#test/conformance/kit.ts";

conformance({
  id: "hermes",
  probes: [
    {
      scope: "user",
      argv: ["hermes", "skills", "list"],
      expect: [/│ lint\s+│[^│\n]*│ local\s+│/, /│ ship\s+│[^│\n]*│ local\s+│/],
    },
  ],
});
