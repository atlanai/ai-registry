import { conformance } from "#test/conformance/kit.ts";

// Codex lists no agents without a model session, so only skills and plugins are probed.
conformance({
  id: "codex",
  env: (home) => ({ CODEX_HOME: `${home}/codex-home` }),
  probes: [
    {
      scope: "project",
      argv: ["codex", "debug", "prompt-input"],
      expect: [/project\/\.agents\/skills`/, /- lint: Lints a change\./, /- kit:ship: Ships/],
    },
    {
      scope: "user",
      argv: ["codex", "debug", "prompt-input"],
      expect: [/\.agents\/skills`/, /- lint: Lints a change\./, /- kit:ship: Ships/],
    },
    {
      scope: "user",
      argv: ["codex", "plugin", "list"],
      expect: [
        /kit@kit +installed, enabled +local +\S+\/codex-home\/plugins\/cache\/kit\/kit\/local/,
      ],
    },
  ],
});
