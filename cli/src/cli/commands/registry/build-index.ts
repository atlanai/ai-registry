import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ENVELOPE, INDEX_DOCUMENT, VERSIONS_DOCUMENT } from "#adapter/filespec/names.ts";
import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { indexRoot } from "#core/filespec/indexer.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import { commitAndPush, releaseSubject } from "#engine/publish/target.ts";

/** The spec's indexer over a registry folder; releasing it is a commit, made by you. */
export async function index(context: CommandContext, input: string | undefined): Promise<void> {
  const root = requireRegistry(resolve(context.cwd, input ?? "."));
  // What indexing repairs goes stale by design; anything else has to be fixed before it is released.
  const blocking = (await validateRoot(root)).problems.filter(
    (problem) => problem.path !== INDEX_DOCUMENT && problem.fix !== "aireg registry index",
  );
  if (blocking.length > 0) {
    for (const problem of blocking) {
      context.printer.error(`${problem.path}: ${problem.message}`);
      if (problem.fix !== undefined) context.printer.hint(problem.fix);
    }
    throw new AiregError(
      `The registry has ${plural(blocking.length, "problem")} to fix before it can be indexed.`,
      { code: ErrorCode.Invalid, hint: "Run `aireg registry validate` to see them again." },
    );
  }
  const { added, moved, paths } = await indexRoot(root, new Date().toISOString());
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { root, added, moved, paths } });
    return;
  }
  for (const item of moved) {
    context.printer.info(`  latest  ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
  }
  if (added.length === 0) {
    context.printer.success(
      moved.length > 0
        ? "Updated latest and index.json. No new versions."
        : paths.includes(INDEX_DOCUMENT)
          ? "Updated index.json. No new versions."
          : "Nothing new to index. Every version folder is listed.",
    );
    return;
  }
  for (const item of added) {
    context.printer.info(`  add     ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
  }
  context.printer.success(`Validated and indexed ${plural(added.length, "new version")}.`);
  const envelopes = paths.filter((path) => path.endsWith(ENVELOPE)).length;
  const versions = paths.filter((path) => path.endsWith(VERSIONS_DOCUMENT)).length;
  context.printer.note(
    "wrote",
    `index.json, ${plural(versions, "versions.json", "versions.json")}, ${plural(envelopes, "artifact.json", "artifact.json")}`,
  );
  if (!existsSync(join(root, ".git"))) return;
  context.printer.note(
    "next",
    commitAndPush(releaseSubject(added), relative(context.cwd, root) || "."),
  );
}
