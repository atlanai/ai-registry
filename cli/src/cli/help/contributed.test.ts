import { describe, expect, vi } from "vitest";
import { lookup } from "#cli/commands/index.ts";
import type { CommandContribution } from "#core/host/extend.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { capturedPrinter } from "#test/kit/printer.ts";
import { buildMap } from "./map.ts";
import { printHelp } from "./print.ts";

const KIT: CommandContribution = {
  name: "kit",
  aliases: ["k"],
  hiddenAliases: ["toolkit"],
  summary: "Kit things",
  group: "Maintain",
  actions: [
    { name: "sync", summary: "Bring the kit up to date" },
    "status",
    { name: "hook", summary: "Run by a session hook", hidden: true },
  ],
  load: async () => ({ run: async () => {} }),
};

vi.mock("#core/host/load.ts", () => ({ contributedCommands: async () => [KIT] }));

async function help(page: string[]): Promise<string> {
  const { printer, printed } = capturedPrinter();
  await printHelp(printer, page, false);
  return printed.join("");
}

describe("an adapter's command", () => {
  test("shows each action's summary and leaves hidden names out of help", async () => {
    const page = await help(["kit"]);
    expect(page).toMatch(/sync +Bring the kit up to date/);
    expect(page).toMatch(/\n {2}status\n/);
    expect(page).not.toContain("hook");
    expect(page).toContain("aireg k");
    expect(page).not.toContain("toolkit");
    expect(await help([])).not.toMatch(/sync +status +hook/);
  });

  test("still answers to a hidden alias and a hidden action", async () => {
    expect((await lookup("toolkit"))?.name).toBe("kit");
    expect(await help(["kit", "hook"])).toContain("Run by a session hook");
  });

  test("leaves hidden actions out of the map", async () => {
    const kit = (await buildMap()).children?.find((node) => node.path === "aireg kit");
    expect(kit?.aliases).toEqual(["k"]);
    expect(kit?.children?.map((node) => node.path)).toEqual(["aireg kit sync", "aireg kit status"]);
    expect(kit?.children?.[0]?.summary).toBe("Bring the kit up to date");
  });
});
