import { cp, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ENVELOPE } from "#adapter/filespec/names.ts";
import { bumpVersion, compareVersion, parseVersion } from "#adapter/semver.ts";
import { isVersion } from "#adapter/spec/ref.ts";
import { plural, quoted } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import type { KindBump } from "#cli/commands/kind/result.ts";
import type { Own } from "#cli/commands/kind.ts";
import { needsInput } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import { refuseRedirect } from "#core/fs/fresh.ts";
import { present } from "#core/fs/tree.ts";
import type { Printer } from "#core/term/printer.ts";
import { nameOf, valid } from "./fields.ts";
import { FRESH } from "./files.ts";
import { keepFromEnvelope } from "./new-from.ts";
import { locate } from "./place.ts";

export interface Bumped extends KindBump {
  shown: { from: string; to: string };
  kept: { relationships: number; blobs: number };
}

export async function version(
  kind: string,
  context: CommandContext,
  input: string | undefined,
  how: string | undefined,
  own: Own,
): Promise<Bumped> {
  if (input === undefined) {
    throw needsInput(
      `${kind} bump`,
      "a name",
      `Name the ${kind}: \`aireg ${kind} bump <name> [patch | minor | major | <version>]\`.`,
    );
  }
  const root = requireRegistry(context.cwd);
  const namespace = own.namespace === undefined ? undefined : valid(own.namespace);
  const home = await locate(root, context.cwd, kind, nameOf(input, input), namespace);
  // Folder names as written: `1.0.0+build` is copied from that folder, not `1.0.0`.
  const versions = (await readdir(home, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && isVersion(item.name))
    .flatMap((item) => {
      const parsed = parseVersion(item.name);
      return parsed === undefined ? [] : [{ name: item.name, parsed }];
    })
    .sort((left, right) => compareVersion(left.parsed, right.parsed));
  const latest = versions.at(-1)?.name;
  if (latest === undefined)
    throw new AiregError(`${input} has no version to start from.`, {
      code: ErrorCode.Invalid,
      hint: `Start one with \`aireg ${kind} new ${input}\`.`,
    });

  const bump = how ?? "patch";
  // `v1.2.0` names a tag; the folder is the bare version.
  const next =
    bump === "patch" || bump === "minor" || bump === "major"
      ? bumpVersion(latest, bump)
      : bump.replace(/^v(?=\d)/, "");
  const parsed = parseVersion(next);
  if (!isVersion(next) || parsed === undefined) {
    throw new AiregError(`${quoted(bump)} is not patch, minor, major or a version.`, {
      code: ErrorCode.Usage,
      hint: "Use patch, minor, major or a version such as 1.4.0.",
    });
  }
  if (versions.some((item) => compareVersion(item.parsed, parsed) === 0)) {
    throw new AiregError(`${input} ${next} already exists.`, {
      code: ErrorCode.Conflict,
      hint: "Edit it there, or name a newer version.",
    });
  }
  // Refuses any entry where the version goes, even a link a folder listing skips.
  refuseRedirect(root, join(home, next));
  if (await present(join(home, next))) {
    throw new AiregError(`${input} ${next} already exists.`, {
      code: ErrorCode.Conflict,
      hint: `Move ${relative(context.cwd, join(home, next)) || "."} aside, or name a newer version.`,
    });
  }
  await cp(join(home, latest), join(home, next), FRESH);
  await rm(join(home, next, ENVELOPE), { force: true });
  const kept = await keepFromEnvelope(join(home, latest), join(home, next));

  return {
    kind,
    name: input,
    from: latest,
    to: next,
    shown: {
      from: relative(context.cwd, join(home, latest)) || ".",
      to: relative(context.cwd, join(home, next)) || ".",
    },
    kept,
  };
}

export function printBumped(result: Bumped, printer: Printer): void {
  const { from, kept } = result;
  printer.success(`Copied ${result.shown.from} to ${result.shown.to}.`);
  if (kept.relationships > 0) {
    printer.note(
      "kept",
      `${plural(kept.relationships, "relationship")} from ${from}, in ${ENVELOPE}`,
    );
  }
  if (kept.blobs > 0) {
    printer.note("kept", `${plural(kept.blobs, "blob-backed file")} from ${from}, in ${ENVELOPE}`);
  }
  printer.note("edit", result.shown.to);
  printer.note("next", "aireg registry index");
}
