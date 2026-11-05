import { list, quoted } from "#adapter/text.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { among, relativeRef } from "#engine/address/probe.ts";

/**
 * Each pick as the manifest records it: `<namespace>/<kind>/<name>`, or
 * `<kind>/<name>` where the source groups nothing. A plugin is its namespace.
 */
export function qualify(
  picks: readonly string[],
  /** What `aireg registry show` takes for this registry. */
  shown: string,
  all: readonly Entry[],
  /** True when only the requested names were read, so `all` is not the catalog. */
  partial: boolean,
  alias: string,
): string[] {
  const addresses: string[] = [];
  const missing: string[] = [];
  for (const pick of picks) {
    const address = addressOf(pick, all, alias);
    if (address === undefined) missing.push(pick);
    else addresses.push(address);
  }
  if (missing.length > 0) {
    // Several plugins may publish the same leaf.
    const available = [...new Set(all.map((entry) => entry.name))].sort();
    // A partial read has no complete catalog to offer as the hint.
    throw new AiregError(`${alias} publishes nothing named ${list(missing.map(quoted), "or")}.`, {
      code: ErrorCode.NotFound,
      hint: partial
        ? `Run \`aireg registry show ${shown}\` to see what it publishes.`
        : `Use ${list(available, "or")}.`,
    });
  }
  return addresses;
}

/** One word names an artifact, or a namespace when no artifact has that name. */
function addressOf(pick: string, all: readonly Entry[], alias: string): string | undefined {
  const namespaces = new Set(
    all.flatMap((entry) => (entry.group === undefined ? [] : [entry.group])),
  );
  const whole = pickedNamespace(pick);
  if (whole !== undefined) return namespaces.has(whole) ? whole : undefined;

  const ref = relativeRef(pick);
  const word = ref.name ?? (ref.namespace as string);
  const [entry] = among(
    all,
    alias,
    ref.name === undefined
      ? { name: word }
      : { name: ref.name, namespace: ref.namespace, kind: ref.kind },
  );
  const plugin = all.some((candidate) => candidate.kind === "plugin" && candidate.name === word);
  if (entry !== undefined) {
    const address = [entry.group, entry.kind, entry.name].filter(Boolean).join("/");
    if (plugin && ref.name === undefined) refuseShared(word, address, entry.kind, alias);
    return ref.version === undefined ? address : `${address}@${ref.version}`;
  }
  return ref.name === undefined && (namespaces.has(word) || plugin) ? word : undefined;
}

function pickedNamespace(value: string): string | undefined {
  return value.endsWith("/") ? value.slice(0, -1) : undefined;
}

/** A plugin and an artifact of the same name: either is a fair reading, so neither is taken. */
function refuseShared(word: string, address: string, kind: string, alias: string): never {
  throw new AiregError(
    `${quoted(word)} names both the plugin ${word} and the ${kind} ${address}.`,
    {
      code: ErrorCode.Usage,
      hint: `Add the whole plugin with \`aireg add ${alias}/${word}\`, or only the ${kind} with \`-s ${address}\`.`,
    },
  );
}

/** No artifact name can look like this. */
export function namespaceChoice(namespace: string): string {
  return `${namespace}/`;
}
