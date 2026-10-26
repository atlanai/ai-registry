import { conformance } from "#test/conformance/kit.ts";

// Copy to `test/conformance/<id>.test.ts` and fill in each part from `<id>/EVIDENCE.md`.
// This copy defines a target by file, so the kit runs on a target no tool installs.
conformance({
  id: "example",
  file: {
    id: "example",
    displayName: "Example",
    roots: { project: ".example", user: { default: "~/.example", env: "EXAMPLE_HOME" } },
    kinds: {
      plugin: { shape: "contents" },
      skill: { shape: "directory", subdir: "skills" },
      agent: { shape: "file", subdir: "agents", extension: ".md" },
    },
  },
  env: (home) => ({ EXAMPLE_HOME: `${home}/.example` }),
  probes: [{ scope: "user", argv: ["example", "skills", "list"], expect: [/lint/, /ship/] }],
});
