import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { OfferedVersion } from "#adapter/filespec/merge.ts";
import { ENVELOPE, INDEX_DOCUMENT, VERSIONS_DOCUMENT } from "#adapter/filespec/names.ts";
import { plural } from "#adapter/text.ts";
import { action } from "#cli/commands/define.ts";
import type { IndexedVersion, RegistryIndexed } from "#cli/commands/registry/result.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { indexRoot } from "#core/filespec/indexer.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import { commitAndPush, releaseSubject } from "#engine/publish/target.ts";
import type { Options } from "./options.ts";

interface Built {
  data: RegistryIndexed;
  /** The registry as typed from where you are, for the commit command. */
  shown: string;
  /** Only a git repository is released with a commit. */
  git: boolean;
}

/** The spec's indexer over a registry folder; releasing it is a commit, made by you. */
export const index = action({
  async run({ argument: input }: Options, context): Promise<Built> {
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
    return {
      data: { root, added: added.map(indexed), moved: moved.map(indexed), paths },
      shown: relative(context.cwd, root) || ".",
      git: existsSync(join(root, ".git")),
    };
  },
  data: (result) => result.data,
  text({ data, shown, git }, printer) {
    const { added, moved, paths } = data;
    for (const item of moved) {
      printer.info(`  latest  ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
    }
    if (added.length === 0) {
      printer.success(
        moved.length > 0
          ? "Updated latest and index.json. No new versions."
          : paths.includes(INDEX_DOCUMENT)
            ? "Updated index.json. No new versions."
            : "Nothing new to index. Every version folder is listed.",
      );
      return;
    }
    for (const item of added) {
      printer.info(`  add     ${item.namespace}/${item.kind}/${item.name}  ${item.version}`);
    }
    printer.success(`Validated and indexed ${plural(added.length, "new version")}.`);
    const envelopes = paths.filter((path) => path.endsWith(ENVELOPE)).length;
    const versions = paths.filter((path) => path.endsWith(VERSIONS_DOCUMENT)).length;
    printer.note(
      "wrote",
      `index.json, ${plural(versions, "versions.json", "versions.json")}, ${plural(envelopes, "artifact.json", "artifact.json")}`,
    );
    if (!git) return;
    printer.note("next", commitAndPush(releaseSubject(added), shown));
  },
});

function indexed({
  description,
  status,
  catalogDigest,
  ...version
}: OfferedVersion): IndexedVersion {
  return {
    ...version,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(catalogDigest === undefined ? {} : { catalogDigest }),
  };
}
