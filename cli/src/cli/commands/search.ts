import { list, plural, quoted, withoutCredentials } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { knownRegistries, undeclaredRegistry } from "#cli/registries.ts";
import { search } from "#cli/search.ts";
import { probe, type Resolved, throughManifest } from "#cli/source.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type ArtifactKind, isKind, KINDS } from "#core/kinds.ts";
import { formatAddress } from "#core/ref.ts";
import { scopeName } from "#core/store/paths.ts";
import { truncate } from "#core/term/format.ts";
import { table } from "#core/term/table.ts";
import { scopeRoots } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/** Room for the description once the other columns are printed. */
const DESCRIPTION_WIDTH = 60;

interface Match {
  address: string;
  registry: string;
  namespace: string | undefined;
  kind: ArtifactKind;
  name: string;
  version: string | undefined;
  description: string | undefined;
  labels: Readonly<Record<string, string>> | undefined;
  /** What `aireg add` takes for it from here: the registry's name, or its address and -r. */
  add: string;
}

interface Skipped {
  registry: string;
  message: string;
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals, common, own } = parse<{ registry?: string; kind?: string }>(
    context.argv,
    builtin("search"),
  );
  const query = positionals.join(" ").trim();
  if (query === "") {
    throw new AiregError("`aireg search` needs something to search for.", {
      code: ErrorCode.Usage,
      hint: "Name it: `aireg search <query>`, such as `aireg search review`.",
    });
  }
  const kind = own.kind === undefined ? undefined : kindOf(own.kind);

  const known = await knownRegistries(common, context.cwd);
  const targets =
    own.registry === undefined
      ? Object.keys(known)
          .sort()
          .map((alias) => throughManifest(alias, known, {}))
      : [throughManifest(own.registry, known, {})];
  const [first] = targets;
  if (first === undefined) {
    throw new AiregError(
      `There are no registries to search in ${scopeName(scopeRoots(common, context.cwd, "user").scope)}.`,
      {
        code: ErrorCode.NotFound,
        hint: "Declare one with `aireg registry add <address>`, or name one with `--registry`.",
      },
    );
  }
  if (own.registry !== undefined && !first.declared) {
    const unknown = await undeclaredRegistry(own.registry, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }

  const read = await Promise.allSettled(targets.map((target) => matchesIn(target, context.cwd)));
  const matches: Match[] = [];
  const skipped: Skipped[] = [];
  read.forEach((outcome, at) => {
    if (outcome.status === "fulfilled") {
      matches.push(...outcome.value);
      return;
    }
    // One registry named on its own is the whole search, so its failure is the answer.
    if (targets.length === 1) throw outcome.reason;
    const target = targets[at] as Resolved;
    const reason =
      outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    skipped.push({ registry: target.alias ?? target.input, message: reason });
  });
  if (skipped.length === targets.length) {
    throw new AiregError(`Could not read ${list(skipped.map((item) => item.registry))}.`, {
      code: ErrorCode.Unavailable,
      hint: "Run `aireg registry show <registry>` to see why.",
    });
  }

  const found = search(
    matches.filter((match) => kind === undefined || match.kind === kind),
    query,
  );
  report(context, query, found, skipped);
}

/** Read through the same listing `aireg registry show` prints. */
async function matchesIn(target: Resolved, cwd: string): Promise<Match[]> {
  const source = await probe(target.input, target.flags, cwd, [], target);
  try {
    const registry = target.alias ?? source.alias;
    const entries = source.catalog.entries;
    return entries.map((entry) => {
      const address = formatAddress({
        registry,
        namespace: entry.group,
        kind: entry.kind,
        name: entry.name,
      });
      // The kind is spelled out only where the namespace holds two artifacts of one name.
      const shared = entries.some(
        (other) => other !== entry && other.group === entry.group && other.name === entry.name,
      );
      const inside = formatAddress({
        registry: "",
        namespace: entry.group,
        kind: shared ? entry.kind : undefined,
        name: entry.name,
      }).replace(/^\//, "");
      return {
        address,
        registry,
        namespace: entry.group,
        kind: entry.kind,
        name: entry.name,
        version: source.versionOf(entry),
        description: entry.description,
        labels: source.labelsOf(entry),
        add: target.declared
          ? `aireg add ${registry}/${inside}`
          : `aireg add ${inside} -r ${withoutCredentials(target.input)}`,
      };
    });
  } finally {
    await source.close();
  }
}

function kindOf(raw: string): ArtifactKind {
  const kind = raw.trim().toLowerCase();
  if (isKind(kind)) return kind;
  throw new AiregError(`${quoted(raw)} is not a kind.`, {
    code: ErrorCode.Usage,
    hint: `Use ${list(KINDS, "or")}.`,
  });
}

function report(
  context: CommandContext,
  query: string,
  found: readonly Match[],
  skipped: readonly Skipped[],
): void {
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        query,
        matches: found.map(({ add: _, labels, ...match }) => ({
          ...match,
          ...(labels === undefined ? {} : { labels }),
        })),
        skipped,
      },
    });
    return;
  }
  for (const item of skipped) {
    context.printer.warning(
      `Skipped ${item.registry}, which could not be read: ${item.message.replace(/\.$/, "")}.`,
    );
  }
  if (found.length === 0) {
    context.printer.info(`No artifacts match ${quoted(query)}.`);
    context.printer.hint(
      "Run `aireg registry show <registry>` to see everything a registry publishes.",
    );
    return;
  }
  const style = context.printer.style;
  context.printer.info(
    style.bold(`${plural(found.length, "match", "matches")} for ${quoted(query)}`),
  );
  table(
    context.printer,
    [
      {
        header: "name",
        value: (match: Match) => [match.namespace, match.name].filter(Boolean).join("/"),
      },
      { header: "kind", value: (match: Match) => style.dim(match.kind) },
      { header: "version", value: (match: Match) => match.version ?? "", optional: true },
      { header: "registry", value: (match: Match) => match.registry },
      {
        header: "description",
        value: (match: Match) => truncate(match.description ?? "", DESCRIPTION_WIDTH),
      },
    ],
    found,
  );
  context.printer.note("next", (found[0] as Match).add);
}
