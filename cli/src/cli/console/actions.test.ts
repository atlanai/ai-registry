import { describe, expect, it } from "vitest";
import { actionOf, builtin } from "#cli/commands/index.ts";
import { parse, takeGlobals } from "#cli/options.ts";
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

  it.each(commands)("$display is a command aireg takes", (command) => {
    expect(command.display).toBe(`aireg ${command.argv.join(" ")}`);
    accepted(command.argv);
  });

  // A committed lockfile or config chooses these names, so one spelled like an option
  // must not widen the scope, skip a prompt or force anything.
  it.each(["-g", "--force", "--yes", "--help", "--to=elsewhere"])(
    "pass the name %j as a name, not an option",
    (name) => {
      for (const [built, words] of [
        [actions.publish([name], undefined, "project"), [name]],
        [actions.pullLatest(name, "project"), [name]],
        [actions.runJob(name), ["start", name]],
        [actions.setJobEnabled(name, false), ["disable", name]],
        [actions.retryRun(name), ["retry", name]],
      ] as const) {
        const [command = "", ...rest] = built.argv;
        const globals = takeGlobals(rest, builtin(command));
        expect(globals.values, built.display).toEqual({});
        const { positionals, common, own } = parse<Record<string, unknown>>(
          globals.argv,
          builtin(command),
        );
        expect(positionals, built.display).toEqual(words);
        expect(common.scope, built.display).toBeUndefined();
        expect(common.force, built.display).toBe(false);
        expect(own.to, built.display).toBeUndefined();
      }
    },
  );
});
