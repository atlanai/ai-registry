import { conformance } from "#test/conformance/kit.ts";

// `hermes skills list` prints each skill it loaded and where from, and needs no sign-in. A git
// install's launcher finds its packages under the home it was installed into, so it will not start
// with the sandbox's `HERMES_HOME`; run this with a PyPI install's `hermes`, or the install's own
// dependency environment's, on PATH.
const list = ["hermes", "skills", "list"];

conformance({
  id: "hermes-agent",
  env: (home) => ({ HERMES_HOME: `${home}/.hermes` }),
  probes: [
    // From the home folder, which is no project, it lists your own skills alone.
    { scope: "user", argv: list, expect: [/│ lint +│ +│ local +│/, /│ ship +│ +│ local +│/] },
    // It takes a project at the nearest `.git`, and loads its skills once the project is trusted.
    { scope: "project", argv: ["git", "init", "-q"], expect: [] },
    {
      scope: "project",
      argv: ["hermes", "skills", "trust"],
      expect: [/1 project skill\(s\) will load/],
    },
    { scope: "project", argv: list, expect: [/│ lint +│ +│ project +│/] },
  ],
});
