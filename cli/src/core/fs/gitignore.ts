/** One pattern, read. */
interface Rule {
  /** The pattern as written, which a caller reports by. */
  pattern: string;
  negated: boolean;
  /** It ends in `/`, so only a folder matches it. */
  folderOnly: boolean;
  regex: RegExp;
}

function bracket(body: string, at: number): { source: string; end: number } | undefined {
  let end = at + 1;
  if (body[end] === "!" || body[end] === "^") end += 1;
  if (body[end] === "]") end += 1;
  while (end < body.length && body[end] !== "]") end += 1;
  if (end >= body.length) return undefined;
  const inner = body.slice(at + 1, end);
  const negated = inner.startsWith("!") || inner.startsWith("^");
  const set = (negated ? inner.slice(1) : inner).replace(/[\\\]^]/g, "\\$&");
  return { source: `[${negated ? "^" : ""}${set}]`, end };
}

const escaped = (char: string) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function doubleStar(body: string, at: number): { source: string; end: number } | undefined {
  if (body[at + 1] !== "*") return undefined;
  const before = at === 0 || body[at - 1] === "/";
  const last = at + 2 === body.length;
  if (!before || !(last || body[at + 2] === "/")) return undefined;
  return last ? { source: ".*", end: at + 1 } : { source: "(?:.*/)?", end: at + 2 };
}

function token(body: string, at: number): { source: string; end: number } {
  const char = body[at] as string;
  if (char === "*") return doubleStar(body, at) ?? { source: "[^/]*", end: at };
  if (char === "?") return { source: "[^/]", end: at };
  if (char === "[") return bracket(body, at) ?? { source: "\\[", end: at };
  if (char === "\\" && at + 1 < body.length) {
    return { source: escaped(body[at + 1] as string), end: at + 1 };
  }
  return { source: escaped(char), end: at };
}

function sourceOf(body: string): string {
  let source = "";
  for (let at = 0; at < body.length; at += 1) {
    const read = token(body, at);
    source += read.source;
    at = read.end;
  }
  return source;
}

function ruleOf(pattern: string): Rule | undefined {
  let body = pattern.replace(/(?<!\\)\s+$/, "");
  if (body === "" || body.startsWith("#")) return undefined;
  const negated = body.startsWith("!");
  if (negated) body = body.slice(1);
  else if (body.startsWith("\\!") || body.startsWith("\\#")) body = body.slice(1);
  const folderOnly = body.endsWith("/");
  if (folderOnly) body = body.slice(0, -1);

  const anchored = body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  if (body === "") return undefined;
  const prefix = anchored ? "" : "(?:.*/)?";
  return { pattern, negated, folderOnly, regex: new RegExp(`^${prefix}${sourceOf(body)}$`, "s") };
}

/** Patterns read once and matched against many paths. */
export interface Ignore {
  /** Whether git would leave this file out. */
  ignores(path: string): boolean;
  /** The patterns that matched no file or folder of those asked about so far. */
  unmatched(): string[];
}

export function gitignore(patterns: readonly string[]): Ignore {
  const rules = patterns.flatMap((pattern) => ruleOf(pattern) ?? []);
  const matched = new Set<Rule>();

  const decide = (path: string, folder: boolean): boolean | undefined => {
    let ignored: boolean | undefined;
    for (const rule of rules) {
      if (rule.folderOnly && !folder) continue;
      if (!rule.regex.test(path)) continue;
      matched.add(rule);
      ignored = !rule.negated;
    }
    return ignored;
  };
  return {
    ignores(path) {
      const parts = path.split("/");
      // Git never looks inside a folder it leaves out, so nothing below it comes back. Every
      // level is still read, so a pattern counts as matching whatever it would match.
      let below = false;
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (decide(parts.slice(0, depth).join("/"), true) === true) below = true;
      }
      const itself = decide(path, false) === true;
      return below || itself;
    },
    unmatched: () => rules.filter((rule) => !matched.has(rule)).map((rule) => rule.pattern),
  };
}
