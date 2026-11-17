import type { Command } from "#core/console/actions.ts";
import { NAME } from "#core/product.ts";
import type { Scope } from "#core/store/paths.ts";

function scoped(scope: Scope): string[] {
  return scope === "user" ? ["-g"] : [];
}

/** After `--` and every option, so a name such as `-g` or `--yes` cannot steer the child. */
function data(values: readonly string[]): string[] {
  return values.length === 0 ? [] : ["--", ...values];
}

/** Shown as a POSIX shell would need it typed, so the confirm screen can be pasted. */
function shown(argv: string[]): Command {
  const words = argv.map((arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
  );
  return { display: `${NAME} ${words.join(" ")}`, argv };
}

export interface AddChoices {
  /** Narrows a source of many artifacts to these names. */
  select?: readonly string[];
  /** Plugins the person read and chose to trust, by name. */
  trust?: readonly string[];
  /** Plans and prints the plan as data, writing nothing. */
  dryRun: boolean;
  /** Prints what was installed as data, for a caller that reads it. */
  json?: boolean;
}

/** Values ride in `--flag=value` form, so one such as `--all` stays a value. */
export function add(address: string, choices: AddChoices, scope: Scope): Command {
  const argv = ["add", ...scoped(scope)];
  for (const name of choices.select ?? []) argv.push(`--select=${name}`);
  for (const name of choices.trust ?? []) argv.push(`--trust=${name}`);
  argv.push(
    ...(choices.dryRun
      ? ["--dry-run", ...(choices.json === false ? [] : ["--json"])]
      : ["--yes", ...(choices.json === true ? ["--json"] : [])]),
    ...data([address]),
  );
  return shown(argv);
}

/** The screen that names the command is the confirmation, as for a publish. */
export function remove(names: readonly string[], scope: Scope, dryRun = false): Command {
  return shown(["remove", ...scoped(scope), dryRun ? "--dry-run" : "--yes", ...data(names)]);
}

export function doctor(): Command {
  return shown(["doctor", "--json"]);
}
