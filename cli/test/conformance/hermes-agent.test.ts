import { conformance } from "#test/conformance/kit.ts";

// PyPI stops at 0.19 and a git install starts slowly in a fresh home, so put a `hermes` on PATH
// that runs `python -m hermes_cli.main` from a checkout.
const list = ["hermes", "skills", "list"];

conformance({
  id: "hermes-agent",
  env: (home) => ({ HERMES_HOME: `${home}/.hermes` }),
  probes: [
    { scope: "user", argv: list, expect: [/│ lint +│ +│ local +│/, /│ ship +│ +│ local +│/] },
    // It loads a project's skills, found at the nearest `.git`, once the project is trusted.
    { scope: "project", argv: ["git", "init", "-q"], expect: [] },
    {
      scope: "project",
      argv: ["hermes", "skills", "trust"],
      expect: [/1 project skill\(s\) will load/],
    },
    { scope: "project", argv: list, expect: [/│ lint +│ +│ project +│/] },
  ],
});
