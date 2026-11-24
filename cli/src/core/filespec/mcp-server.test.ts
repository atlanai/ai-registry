import { describe, expect, test } from "vitest";
import { mcpPolicyProblems } from "./mcp-server.ts";

const server = {
  name: "com.example/issues",
  packages: [
    {
      registryType: "npm",
      identifier: "@example/issues",
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "ISSUES_URL", isRequired: true },
        { name: "ISSUES_TOKEN", isSecret: true },
        { name: "MODE", value: "readonly" },
      ],
      packageArguments: [
        { type: "positional", valueHint: "workspace" },
        { type: "named", name: "--region", choices: ["eu", "us"] },
      ],
      runtimeArguments: [
        { type: "named", name: "--image", value: "{image}", variables: { image: {} } },
      ],
    },
    {
      registryType: "oci",
      identifier: "example/issues",
      transport: {
        type: "streamable-http",
        url: "http://localhost:{port}/mcp",
        headers: [{ name: "X-Team" }],
      },
    },
  ],
  remotes: [
    {
      type: "streamable-http",
      url: "https://{tenant}.issues.example.com/mcp",
      variables: { tenant: { isRequired: true } },
      headers: [
        {
          name: "Authorization",
          value: "Bearer {token}",
          variables: { token: { isSecret: true } },
        },
      ],
    },
  ],
};

const problems = (inputs: Record<string, string>) =>
  mcpPolicyProblems({ server, policy: { inputs } });

describe("mcpPolicyProblems", () => {
  test("accepts values for declared inputs, found by the names URL templates use", () => {
    expect(
      problems({
        ISSUES_URL: "https://x",
        workspace: "core",
        "--region": "eu",
        tenant: "acme",
        image: "issues:1",
        "X-Team": "platform",
      }),
    ).toEqual([]);
  });

  test("refuses a value for a secret, whether a variable or a template's variable", () => {
    expect(problems({ ISSUES_TOKEN: "t", token: "t" })).toEqual([
      "`policy.inputs.ISSUES_TOKEN` is a secret in server.json, so the policy cannot give it a value",
      "`policy.inputs.token` is a secret in server.json, so the policy cannot give it a value",
    ]);
  });

  test("refuses an input server.json does not declare, or already fixes", () => {
    expect(problems({ ISSUES_HOST: "x", MODE: "write", Authorization: "x" })).toEqual([
      "`policy.inputs.ISSUES_HOST` names no input server.json declares",
      "`policy.inputs.MODE` already has a value in server.json",
      "`policy.inputs.Authorization` already has a value in server.json",
    ]);
  });

  test("keeps a value to the input's choices", () => {
    expect(problems({ "--region": "apac" })).toEqual([
      '`policy.inputs.--region` "apac" is not one of its choices, "eu" or "us"',
    ]);
  });

  test("has nothing to say without a policy that fixes inputs", () => {
    expect(mcpPolicyProblems({ server })).toEqual([]);
    expect(mcpPolicyProblems({ server, policy: { tools: { deny: ["x"] } } })).toEqual([]);
  });
});
