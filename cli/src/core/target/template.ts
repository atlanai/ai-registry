import { readdir } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { ConfigValue, KindMapping } from "./contract.ts";

const VAR = /\{([a-z]+)\}/g;

export type Vars = Readonly<Record<string, string>>;

export function templateVars(template: string): string[] {
  return [...template.matchAll(VAR)].map((match) => match[1] as string);
}

/** A value starting at `{root}` is a path, so it takes this platform's separators. */
export function expand(template: string, vars: Vars): string {
  const out = template.replace(VAR, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new AiregError(`Nothing fills {${key}} in "${template}".`, { code: ErrorCode.Invalid });
    }
    return value;
  });
  return template.startsWith("{root}") ? normalize(out) : out;
}

/** Keys and strings alike, so a key can carry a placement's name. */
export function expandValue<T extends ConfigValue>(value: T, vars: Vars): T {
  if (typeof value === "string") return expand(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => expandValue(item, vars)) as T;
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [expand(key, vars), expandValue(item, vars)]),
    ) as T;
  }
  return value;
}

/** Where one placement of a kind sits under its target root, as a template. */
export function placementTemplate(mapping: KindMapping): string | undefined {
  if (mapping.subdir === undefined) return undefined;
  if (mapping.subdir.includes("{")) return mapping.subdir;
  const leaf = mapping.shape === "file" ? `{name}${mapping.extension ?? ""}` : "{name}";
  return `${mapping.subdir}/${leaf}`;
}

/** Only the fixed segments: `plugins/cache/{source}/{name}` places under `plugins/cache`. */
export function fixedPrefix(template: string): string[] {
  const segments = template.split("/").filter((segment) => segment !== "");
  const templated = segments.findIndex((segment) => segment.includes("{"));
  return templated === -1 ? segments : segments.slice(0, templated);
}

interface Segment {
  literal: string;
  pattern: RegExp;
  vars: string[];
}

export function placementPattern(template: string): PlacementPattern {
  const segments = compile(template);
  return {
    match(path) {
      const parts = path.split(sep);
      if (parts.length <= segments.length) return undefined;
      const tail = parts.slice(-segments.length);
      const vars: Record<string, string> = {};
      if (!segments.every((segment, index) => bind(segment, tail[index] as string, vars))) {
        return undefined;
      }
      const root = parts.slice(0, -segments.length).join(sep);
      return root === "" ? undefined : { path, root, vars };
    },
    async scan(root) {
      let found: PlacedPath[] = [{ path: root, root, vars: {} }];
      for (const segment of segments) {
        const next: PlacedPath[] = [];
        for (const at of found) {
          if (segment.vars.length === 0) {
            next.push({ ...at, path: join(at.path, segment.literal) });
            continue;
          }
          for (const entry of await readdir(at.path).catch(() => [] as string[])) {
            const vars = { ...at.vars };
            if (bind(segment, entry, vars)) next.push({ path: join(at.path, entry), root, vars });
          }
        }
        found = next;
      }
      return found;
    },
  };
}

function compile(template: string): Segment[] {
  return template
    .split("/")
    .filter((segment) => segment !== "")
    .map((literal) => {
      const vars = templateVars(literal);
      const source = literal
        .split(VAR)
        .map((part, index) =>
          index % 2 === 1 ? "([^/\\\\]+)" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return { literal, pattern: new RegExp(`^${source}$`), vars };
    });
}

export interface PlacedPath {
  path: string;
  /** The target root it is under, which the template does not name. */
  root: string;
  vars: Record<string, string>;
}

/** Placement paths of one kind, read in both directions. */
export interface PlacementPattern {
  /** The variables an absolute path of this shape carries, and the root it is under. */
  match(path: string): PlacedPath | undefined;
  /** Every path under `root` this template could have placed. */
  scan(root: string): Promise<PlacedPath[]>;
}

/** Reads one segment's variables off a path segment into `into`; false when it does not fit. */
function bind(segment: Segment, part: string, into: Record<string, string>): boolean {
  const match = segment.pattern.exec(part);
  if (match === null) return false;
  for (const [index, name] of segment.vars.entries()) {
    const value = match[index + 1] as string;
    if (into[name] !== undefined && into[name] !== value) return false;
    into[name] = value;
  }
  return true;
}
