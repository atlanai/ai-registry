import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { chooseOption, resolveServer } from "./resolve.ts";

const ISSUE_TRACKER = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../../examples/acme-registry/artifacts/engineering/mcp_server/issue-tracker/1.2.0/server.json",
    ),
    "utf8",
  ),
);

const npm = (extra: Record<string, unknown> = {}) => ({
  packages: [
    {
      registryType: "npm",
      identifier: "@example/srv",
      version: "1.0.0",
      transport: { type: "stdio" },
      ...extra,
    },
  ],
});

describe("resolveServer", () => {
  test("offers the remote first, then the package, with secrets as references", () => {
    const { options, leftOut } = resolveServer(ISSUE_TRACKER, {
      with: { tenant: "acme", ISSUES_URL: "https://issues.test" },
    });
    expect(leftOut).toEqual([]);
    expect(options).toEqual([
      {
        entry: {
          transport: "streamable-http",
          url: "https://acme.issues.example.com/mcp",
          headers: { Authorization: ["Bearer ", { secret: "TOKEN" }] },
        },
        secrets: ["TOKEN"],
      },
      {
        entry: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/issue-tracker-mcp@1.2.0"],
          env: { ISSUES_URL: "https://issues.test", ISSUES_TOKEN: [{ secret: "ISSUES_TOKEN" }] },
        },
        secrets: ["ISSUES_TOKEN"],
      },
    ]);
  });

  test("leaves out what needs an input nothing sets, saying which", () => {
    const { options, leftOut } = resolveServer(ISSUE_TRACKER);
    expect(options).toEqual([]);
    expect(leftOut).toEqual([
      'it needs "tenant", which nothing sets; give it under `with`',
      'it needs "ISSUES_URL", which nothing sets; give it under `with`',
    ]);
  });

  test("shows a required input nothing sets as a placeholder, when asked", () => {
    const { options } = resolveServer(ISSUE_TRACKER, { placeholders: true });
    expect(options[0]?.entry).toMatchObject({ url: "https://<tenant>.issues.example.com/mcp" });
    expect(options[1]?.entry).toMatchObject({ env: { ISSUES_URL: "<ISSUES_URL>" } });
  });

  test("renames a secret's variable, and never takes a secret's value from with", () => {
    const { options } = resolveServer(ISSUE_TRACKER, {
      with: { tenant: "acme", ISSUES_URL: "u", ISSUES_TOKEN: "leaked" },
      env: { ISSUES_TOKEN: "ACME_TOKEN" },
    });
    const pkg = options[1];
    expect(pkg?.entry).toMatchObject({ env: { ISSUES_TOKEN: [{ secret: "ACME_TOKEN" }] } });
    expect(pkg?.secrets).toEqual(["ACME_TOKEN"]);
    expect(JSON.stringify(options)).not.toContain("leaked");
  });

  test("takes a fixed value over with, and with over the default", () => {
    const env = (variable: Record<string, unknown>, withValue?: string) =>
      resolveServer(
        npm({ environmentVariables: [{ name: "MODE", ...variable }] }),
        withValue === undefined ? {} : { with: { MODE: withValue } },
      ).options[0]?.entry;
    expect(env({ value: "fixed", default: "d" }, "w")).toMatchObject({ env: { MODE: "fixed" } });
    expect(env({ default: "d" }, "w")).toMatchObject({ env: { MODE: "w" } });
    expect(env({ default: "d" })).toMatchObject({ env: { MODE: "d" } });
    expect(env({})).toMatchObject({ env: {} });
  });

  test("refuses a value outside its choices", () => {
    const server = npm({ environmentVariables: [{ name: "MODE", choices: ["a", "b"] }] });
    expect(resolveServer(server, { with: { MODE: "c" } }).leftOut).toEqual([
      '"MODE" is "c", not one of a, b',
    ]);
    expect(resolveServer(server, { with: { MODE: "b" } }).options).toHaveLength(1);
  });

  test("orders runtime arguments, the package, then package arguments, named as --flag=value", () => {
    const server = npm({
      runtimeArguments: [{ type: "named", name: "--node-flag", value: "x" }],
      packageArguments: [
        { type: "positional", valueHint: "dir", default: "." },
        { type: "named", name: "--port", default: "3000" },
        { type: "named", name: "--tag", isRepeated: true },
      ],
    });
    const entry = resolveServer(server, { with: { tag: ["a", "b"] } }).options[0]?.entry;
    expect(entry).toMatchObject({
      command: "npx",
      args: ["-y", "--node-flag=x", "@example/srv@1.0.0", ".", "--port=3000", "--tag=a", "--tag=b"],
    });
  });

  test("starts pypi, nuget and oci packages with their runtimes", () => {
    const one = (pkg: Record<string, unknown>) =>
      resolveServer({ packages: [{ transport: { type: "stdio" }, ...pkg }] }).options[0]?.entry;
    expect(one({ registryType: "pypi", identifier: "srv", version: "2.0" })).toMatchObject({
      command: "uvx",
      args: ["srv==2.0"],
    });
    expect(one({ registryType: "nuget", identifier: "Srv", version: "1.0" })).toMatchObject({
      command: "dnx",
      args: ["Srv@1.0", "--yes"],
    });
    expect(
      one({
        registryType: "oci",
        identifier: "docker.io/example/srv:1.0",
        environmentVariables: [{ name: "KEY", isSecret: true }],
      }),
    ).toMatchObject({
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "KEY", "docker.io/example/srv:1.0"],
      env: { KEY: [{ secret: "KEY" }] },
    });
    expect(
      one({ registryType: "oci", identifier: "docker.io/example/srv", version: "1.0" }),
    ).toMatchObject({ args: ["run", "-i", "--rm", "docker.io/example/srv:1.0"] });
  });

  test("takes a runtimeHint only when it names the package's own runtime, keeping its flags", () => {
    const hinted = (runtimeHint: string) => resolveServer(npm({ runtimeHint }));
    expect(hinted("npx").options[0]?.entry).toMatchObject({
      command: "npx",
      args: ["-y", "@example/srv@1.0.0"],
    });
    const other = hinted("sh");
    expect(other.options).toEqual([]);
    expect(other.leftOut[0]).toContain('runtimeHint "sh" is not npx');
  });

  test.for([
    ["npm with no version", npm({ version: undefined }), "has no exact version"],
    ["npm with a range", npm({ version: "^1" }), "has no exact version"],
    ["pypi with a wildcard", npm({ registryType: "pypi", version: "2.*" }), "has no exact version"],
    ["a flag as the package", npm({ identifier: "--yes=true" }), "is not a package name"],
    [
      "an untagged image",
      npm({ registryType: "oci", identifier: "docker.io/example/srv", version: undefined }),
      "names no tag or digest",
    ],
    [
      "an image at latest",
      npm({ registryType: "oci", identifier: "docker.io/example/srv:latest", version: undefined }),
      "names no tag or digest",
    ],
  ] as const)("leaves out %s, which would not run the same code everywhere", ([, server, why]) => {
    const { options, leftOut } = resolveServer(server);
    expect(options).toEqual([]);
    expect(leftOut[0]).toContain(why);
  });

  test.for([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text an agent expands
    ["${AWS_SECRET_ACCESS_KEY}", "a variable in braces"],
    ["$HOME/.ssh", "a bare variable"],
    ["{env:GITHUB_TOKEN}", "an OpenCode variable"],
    ["{file:~/.ssh/id_rsa}", "an OpenCode file"],
  ])("leaves out a server whose own text holds %s, %s an agent would expand", ([text]) => {
    const remote = {
      remotes: [
        {
          type: "streamable-http",
          url: "https://x.test/mcp",
          headers: [{ name: "X", value: text }],
        },
      ],
    };
    const arg = npm({ packageArguments: [{ type: "positional", value: text }] });
    for (const server of [remote, arg]) {
      const { options, leftOut } = resolveServer(server);
      expect(options).toEqual([]);
      expect(leftOut[0]).toContain("a coding agent would replace with a variable or a file");
    }
  });

  test("takes https remotes, and plain http only on this machine", () => {
    const at = (url: string) => resolveServer({ remotes: [{ type: "sse", url }] });
    expect(at("https://x.test/sse").options).toHaveLength(1);
    expect(at("http://localhost:8080/sse").options).toHaveLength(1);
    expect(at("http://x.test/sse").leftOut[0]).toContain("not https://");
  });

  test("leaves out an mcpb package and one serving over HTTP, saying why", () => {
    const { options, leftOut } = resolveServer({
      packages: [
        { registryType: "mcpb", identifier: "x", transport: { type: "stdio" } },
        { registryType: "npm", identifier: "y", transport: { type: "streamable-http" } },
      ],
    });
    expect(options).toEqual([]);
    expect(leftOut).toHaveLength(2);
    expect(leftOut[0]).toContain('"mcpb"');
  });
});

describe("chooseOption", () => {
  const resolved = resolveServer(ISSUE_TRACKER, { with: { tenant: "acme", ISSUES_URL: "u" } });

  test("prefers a remote the target loads, else a package", () => {
    expect(chooseOption(resolved, ["stdio", "streamable-http"])).toBe(resolved.options[0]);
    expect(chooseOption(resolved, ["stdio"])).toBe(resolved.options[1]);
  });

  test("says why when the target loads none of them", () => {
    expect(chooseOption(resolved, ["sse"])).toBe(
      "it runs over streamable-http or stdio, which this target does not load",
    );
    expect(chooseOption(resolveServer({}), ["stdio"])).toBe(
      "its server.json names no package or remote",
    );
  });

  test("names every reason when nothing can run", () => {
    expect(chooseOption(resolveServer(ISSUE_TRACKER), ["stdio", "sse", "streamable-http"])).toBe(
      'it needs "tenant", which nothing sets; give it under `with`; it needs "ISSUES_URL", which nothing sets; give it under `with`',
    );
  });
});
