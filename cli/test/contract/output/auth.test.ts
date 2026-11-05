import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { outputContract } from "./kit.ts";

const contract = outputContract("auth");

const TOKEN = "synthetic-contract-token";

/** Signs in with whatever token it is given, and says who that is. */
const ADAPTER = `export default {
  id: "signs-in", displayName: "Signs in", protocol: 1, artifactKinds: ["skill"],
  dispatch: { hosts: ["registry.acme.example"] },
  capabilities: { pinsSource: false, auth: true },
  auth: {
    login: async ({ token }) => ({
      credential: { type: "bearer", accessToken: token },
      identity: { name: "jane@acme.example", account: "Acme" },
    }),
  },
  connect: async () => ({ resolve: async () => ({ artifacts: [] }), fetch: async () => new Uint8Array(), close: async () => {} }),
};
`;

test("each auth action prints data its schema describes", async ({ aireg, home }) => {
  const adapter = join(home.dir, "signs-in.mjs");
  await writeFile(adapter, ADAPTER);
  await mkdir(home.aireg, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home.aireg, "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  signs-in: ${adapter}\naccounts: []\njobs: []\n`,
  );
  const signIn = ["auth", "login", "acme", "--address", "https://registry.acme.example/team"];
  const piped = (args: readonly string[]) => aireg(args, { input: `${TOKEN}\n` });

  expect(await contract.violations(piped, [...signIn, "--token-stdin"], "login")).toBe("");
  expect(await contract.violations(aireg, ["auth", "list"], "list")).toBe("");
  expect(await contract.violations(aireg, ["auth", "logout", "acme"], "logout")).toBe("");
  expect(await contract.violations(aireg, ["auth", "remove", "acme"], "remove")).toBe("");
  expect(contract.unchecked()).toEqual([]);
});
