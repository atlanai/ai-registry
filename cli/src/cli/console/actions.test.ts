import { describe, expect, test } from "vitest";
import { actionOf } from "#cli/commands/command.ts";
import { builtin } from "#cli/commands/index.ts";
import { parse, takeGlobals } from "#cli/options/parse.ts";
import { isStepPolicy } from "#core/config/model.ts";
import * as actions from "#core/console/actions.ts";

/** Read as `aireg` reads it: the command, its action when it has them, then the options. */
function accepted(argv: readonly string[]): void {
  const [name = "", ...rest] = argv;
  const spec = builtin(name);
  const action = spec.actions?.find((each) => each.name === rest[0]);
  // A command that takes no options of its own only runs through an action.
  if (spec.options === undefined) expect(action, `an action of aireg ${name}`).toBeDefined();
  const accepts = action === undefined ? spec : actionOf(spec, action.name);
  const { own } = parse<Record<string, unknown>>(
    action === undefined ? rest : rest.slice(1),
    accepts,
  );
  for (const option of accepts.options ?? []) {
    const value = own[option.flag.slice(2)];
    if (option.value === "<policy>" && typeof value === "string") {
      expect(isStepPolicy(value), `${option.flag} ${value}`).toBe(true);
    }
  }
}

describe("console actions", () => {
  const commands = [
    actions.pullLatest("acme", "project"),
    actions.pullLatest(undefined, "user"),
    actions.publish(["engineering/pr-review"], "engineering", "user"),
    actions.runJob("job_skills_acme"),
    actions.setJobEnabled("job_skills_acme", true),
    actions.setJobEnabled("job_skills_acme", false),
    actions.retryRun("run_1"),
  ];

  test.each(commands)("$display is a command aireg takes", (command) => {
    expect(command.display).toBe(`aireg ${command.argv.join(" ")}`);
    accepted(command.argv);
  });

  test("passes a name spelled like an option as data", () => {
    for (const [built, words] of [
      [actions.publish(["-g"], undefined, "project"), ["-g"]],
      [actions.pullLatest("-g", "project"), ["-g"]],
      [actions.runJob("-g"), ["start", "-g"]],
      [actions.setJobEnabled("-g", false), ["disable", "-g"]],
      [actions.retryRun("-g"), ["retry", "-g"]],
    ] as const) {
      const [command = "", ...rest] = built.argv;
      const { positionals, common } = parse<Record<string, unknown>>(
        takeGlobals(rest, builtin(command)).argv,
        builtin(command),
      );
      expect(positionals, built.display).toEqual(words);
      expect(common.scope, built.display).toBeUndefined();
    }
  });
});
