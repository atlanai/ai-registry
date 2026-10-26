import { conformance } from "#test/conformance/kit.ts";

// Gemini CLI lists agents only in a signed-in session, but `skills list` loads them
// and prints each one its strict loader refuses.
conformance({
  id: "gemini-cli",
  env: (home) => ({ GEMINI_CLI_HOME: home }),
  probes: [
    {
      scope: "user",
      argv: ["gemini", "skills", "list"],
      expect: [
        /lint \[Enabled\]\n\s+Description: Lints a change\.\n\s+Location: +\S+\/\.gemini\/skills\/lint\/SKILL\.md/,
        /ship \[Enabled\]\n\s+Description: Ships a change\.\n\s+Location: +\S+\/\.gemini\/skills\/ship\/SKILL\.md/,
        /^(?![\s\S]*Agent loading error)/,
      ],
    },
    // The project is not trusted, so its skills and agents are checked at L1 only.
    {
      scope: "project",
      argv: ["gemini", "skills", "list"],
      expect: [/Skipping project agents due to untrusted folder\./],
    },
  ],
});
