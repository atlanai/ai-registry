import { isArtifactName, isDeviceName } from "#adapter/filespec/names.ts";
import type { Clash, Renamed, Selected } from "#core/plan/model.ts";
import { addressOf } from "#core/plan/select.ts";

/** Kinds whose name a harness reads from front matter, which a rename rewrites. */
const RENAMEABLE = new Set(["skill", "agent"]);

/** How a person reads an address: `ops/review`, without the registry or the kind. */
export function shownAddress(address: string): string {
  const parts = address.split("/");
  return parts.length >= 4 ? `${parts[1]}/${parts[3]}` : (parts.at(-1) ?? address);
}

/** The one command that changes what an install does about a taken name. */
export const NAME_COLLISION_HINT =
  "To change the default, run `aireg config set defaults.name-collision <rename|report|fail>`.";

/** The name a harness folder shows: the last segment of an installed name. */
export function leafOf(name: string): string {
  return name.split("/").at(-1) ?? name;
}

/**
 * The name a harness copy's front matter takes, when it installs under one not its own. A
 * folder and its `name:` must agree, or the harness shows two artifacts under one name.
 */
export function renamedTo(
  item: Pick<Selected, "kind" | "name" | "upstreamName">,
): string | undefined {
  const leaf = leafOf(item.name);
  return RENAMEABLE.has(item.kind) && leaf !== item.upstreamName ? leaf : undefined;
}

/** Its namespace and name, then the registry's too: never install order, so every machine agrees. */
function candidates(item: Selected): string[] {
  const own = [item.group ?? item.source, item.upstreamName].join("-");
  if (item.group === undefined) return [own];
  return [own, [item.source, item.group, item.upstreamName].join("-")];
}

/**
 * A name for each artifact a harness path clash left out. One the person named with `as:`,
 * or with no free valid name, stays left out.
 */
export function renamesFor(
  clashes: readonly Clash[],
  selected: readonly Selected[],
  held: readonly string[],
): Map<string, string> {
  const taken = new Set([...selected.map((item) => leafOf(item.name)), ...held.map(leafOf)]);
  const byAddress = new Map(
    selected.map((item) => [addressOf({ ...item, name: item.upstreamName }, item.source), item]),
  );
  const renames = new Map<string, string>();
  for (const clash of clashes) {
    if (clash.at === undefined || clash.container === true || renames.has(clash.dropped)) continue;
    const item = byAddress.get(clash.dropped);
    if (item === undefined || item.aliased === true || !RENAMEABLE.has(item.kind)) continue;
    const name = candidates(item).find(
      (candidate) => isArtifactName(candidate) && !isDeviceName(candidate) && !taken.has(candidate),
    );
    if (name === undefined) continue;
    taken.add(name);
    renames.set(clash.dropped, name);
  }
  return renames;
}

/** The renames a second plan carried out: the ones it no longer reports as left out. */
export function carriedOut(
  renames: ReadonlyMap<string, string>,
  before: readonly Clash[],
  after: readonly Clash[],
): Renamed[] {
  return [...renames].flatMap(([artifact, as]) => {
    const clash = before.find((item) => item.dropped === artifact);
    if (clash === undefined || after.some((item) => item.dropped === artifact)) return [];
    return [{ artifact, as, by: clash.kept }];
  });
}
