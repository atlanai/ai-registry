import type { ArtifactKind } from "#adapter/kinds.ts";
import { list, plural, quoted, withoutCredentials } from "#adapter/text.ts";
import { search } from "#cli/commands/search/rank.ts";
import type { SearchMatch, SearchResult, SkippedRegistry } from "#cli/commands/search/result.ts";
import { SEARCH_COMMAND } from "#cli/commands/search/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { trackSearch } from "#cli/telemetry/events.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { formatAddress } from "#core/ref.ts";
import { scopeName } from "#core/store/paths.ts";
import { truncate } from "#core/term/format.ts";
import { table } from "#core/term/table.ts";
import { probe, type Resolved, throughManifest } from "#engine/address/probe.ts";
import { knownRegistries, undeclaredRegistry } from "#engine/address/registries.ts";
import type { CommonOptions } from "#engine/options.ts";
import { scopeRoots } from "#engine/scope/locate.ts";
import { defineCommand } from "./define.ts";

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

interface Options {
  query: string;
  registry: string | undefined;
  kind: ArtifactKind | undefined;
  common: CommonOptions;
}

interface Searched {
  data: SearchResult;
  /** What `aireg add` takes for the best match, which the data leaves out. */
  next: string | undefined;
}

export const { run } = defineCommand({
  spec: SEARCH_COMMAND,
  parse(argv): Options {
    const { positionals, common, own } = parse<{ registry?: string; kind?: ArtifactKind }>(
      argv,
      SEARCH_COMMAND,
    );
    const query = positionals.join(" ").trim();
    if (query === "") {
      throw needsInput(
        "search",
        "something to search for",
        "Name it: `aireg search <query>`, such as `aireg search review`.",
      );
    }
    return { query, registry: own.registry, kind: own.kind, common };
  },
  async run({ query, registry, kind, common }, context): Promise<Searched> {
    const known = await knownRegistries(common, context.cwd);
    const targets =
      registry === undefined
        ? Object.keys(known)
            .sort()
            .map((alias) => throughManifest(alias, known, {}))
        : [throughManifest(registry, known, {})];
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
    if (registry !== undefined && !first.declared) {
      const unknown = await undeclaredRegistry(registry, known, common, context.cwd);
      if (unknown !== undefined) throw unknown;
    }

    const read = await Promise.allSettled(targets.map((target) => matchesIn(target, context.cwd)));
    const matches: Match[] = [];
    const skipped: SkippedRegistry[] = [];
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
    const searched = targets.map((target) => ({
      location: target.input,
      adapter: target.flags.adapter,
    }));
    trackSearch(query, found.length, kind, searched);
    return { data: { query, matches: found.map(published), skipped }, next: found[0]?.add };
  },
  data: (result) => result.data,
  text({ data, next }, printer) {
    const { query, matches, skipped } = data;
    for (const item of skipped) {
      printer.warning(
        `Skipped ${item.registry}, which could not be read: ${item.message.replace(/\.$/, "")}.`,
      );
    }
    if (matches.length === 0) {
      printer.info(`No artifacts match ${quoted(query)}.`);
      printer.hint("Run `aireg registry show <registry>` to see everything a registry publishes.");
      return;
    }
    const style = printer.style;
    printer.info(style.bold(`${plural(matches.length, "match", "matches")} for ${quoted(query)}`));
    table(
      printer,
      [
        {
          header: "name",
          value: (match: SearchMatch) => [match.namespace, match.name].filter(Boolean).join("/"),
        },
        { header: "kind", value: (match: SearchMatch) => style.dim(match.kind) },
        { header: "version", value: (match: SearchMatch) => match.version ?? "", optional: true },
        { header: "registry", value: (match: SearchMatch) => match.registry },
        {
          header: "description",
          value: (match: SearchMatch) => truncate(match.description ?? "", DESCRIPTION_WIDTH),
        },
      ],
      matches,
    );
    if (next !== undefined) printer.note("next", next);
  },
});

/** Read through the same listing `aireg registry show` prints. */
async function matchesIn(target: Resolved, cwd: string): Promise<Match[]> {
  const source = await probe({ input: target.input, flags: target.flags, cwd, declared: target });
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

function published(match: Match): SearchMatch {
  const { address, registry, namespace, kind, name, version, description, labels } = match;
  return {
    address,
    registry,
    ...(namespace === undefined ? {} : { namespace }),
    kind,
    name,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(labels === undefined ? {} : { labels }),
  };
}
