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

  test("starts pypi, nuget and oci packages with their runtimes, and a hint overrides one", () => {
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
      one({ registryType: "npm", identifier: "srv", version: "1.0", runtimeHint: "bunx" }),
    ).toMatchObject({ command: "bunx", args: ["srv@1.0"] });
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
});
