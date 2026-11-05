import { expect, test } from "vitest";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { commandContext } from "#test/kit/command.ts";
import type { CommandSpec } from "./command.ts";
import { action, defineCommand, STREAMED } from "./define.ts";

const SPEC: CommandSpec = { name: "probe", summary: "", group: "Check", usage: [] };

function printedBy(format: "json" | "text") {
  const printed: string[] = [];
  return { printed, context: (argv: string[]) => commandContext(argv, { format, printed }) };
}

test("a parse that refuses the command line rejects, rather than throwing", async () => {
  const { run } = defineCommand({
    spec: SPEC,
    parse: () => {
      throw new AiregError("No.", { code: ErrorCode.Usage });
    },
    run: async () => ({}),
    text: () => {},
  });
  const running = run(printedBy("json").context([]));
  await expect(running).rejects.toThrow("No.");
});

test("prints the data an action picks, under the ok it gives, and the full result as text", async () => {
  const probe = {
    run: async () => ({ count: 2, cwd: "/here" }),
    text: (result: { count: number; cwd: string }, printer: { info(line: string): void }) =>
      printer.info(`${result.count} in ${result.cwd}`),
    data: (result: { count: number }) => ({ count: result.count }),
    ok: () => false,
  };
  const { run } = defineCommand({ spec: SPEC, parse: () => ({}), ...probe });

  const json = printedBy("json");
  await run(json.context([]));
  expect(json.printed.join("")).toBe('{"ok":false,"data":{"count":2}}\n');

  const text = printedBy("text");
  await run(text.context([]));
  expect(text.printed.join("")).toBe("2 in /here\n");
});

test("prints nothing more for an action that streamed", async () => {
  const { run } = defineCommand({
    spec: { ...SPEC, actions: [{ name: "follow" }] },
    parse: () => ({ action: "follow", options: {} }),
    actions: { follow: action({ run: async () => STREAMED, text: () => {} }) },
  });
  const json = printedBy("json");
  await run(json.context([]));
  expect(json.printed).toEqual([]);
});
