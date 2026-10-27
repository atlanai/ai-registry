import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isWithin } from "#adapter/paths.ts";
import { list, quoted } from "#adapter/text.ts";
import { canonical } from "#core/fs/canonical.ts";
import { legacyTargetsDir, targetsDir } from "#core/store/paths.ts";
import schema from "#schema/target.schema.json" with { type: "json" };
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { targetProblems } from "./check.ts";
import type { TargetCategory, TargetDefinition } from "./contract.ts";

/** Where a target that no file defines comes from. */
export const BUILT_IN = "built-in";

export interface TargetFile {
  path: string;
  definition: TargetDefinition;
  /** What it says as aireg 0.1 did, which it still loads with. */
  warnings: string[];
}

export interface SkippedFile {
  path: string;
  problems: string[];
}

let validator: ValidateFunction | undefined;

function validate(document: unknown): ErrorObject[] {
  validator ??= new Ajv2020({
    allErrors: true,
    strict: false,
    discriminator: true,
    verbose: true,
  }).compile(schema);
  return validator(document) ? [] : (validator.errors ?? []);
}

/** What each pattern in the schema asks for, in words. */
const PATTERNS: Record<string, string> = {
  "^~/.": "must start with ~/",
  "^[a-z][a-z0-9-]{0,63}$": "must be a lowercase name of letters, digits and dashes",
  "^[A-Za-z_][A-Za-z0-9_]*$": "must be a variable name",
  "^\\.[A-Za-z0-9.]+$": "must be an extension such as .md",
  "^~/.*\\{profile\\}[^/]*$": "must start with ~/ and name {profile} in its last segment",
};

/** Where a list of arguments is expected, a string is a shell command aireg will not run. */
const ARGV = /^\/(detect\/binary|verified\/command)/;

const at = (path: string) => (path === "" ? "The file" : quoted(path.slice(1)));

/** The values a tag may take, read off the branches it picks between. */
function tags(error: ErrorObject, tag: string): string[] {
  const branches = (error.parentSchema?.oneOf ?? []) as {
    properties?: Record<string, { const?: string }>;
  }[];
  return branches.flatMap((branch) => branch.properties?.[tag]?.const ?? []).map(quoted);
}

function describe(error: ErrorObject): string | undefined {
  const where = at(error.instancePath);
  switch (error.keyword) {
    case "additionalProperties":
      return `${where} has an unknown key ${quoted(String(error.params.additionalProperty))}.`;
    case "discriminator": {
      const tag = String(error.params.tag);
      if (error.params.error !== "mapping") return `${where} needs a ${quoted(tag)}.`;
      return `${at(`${error.instancePath}/${tag}`)} must be ${list(tags(error, tag), "or")}.`;
    }
    case "enum":
      return `${where} must be ${list((error.params.allowedValues as string[]).map(quoted), "or")}.`;
    case "oneOf": {
      const keys = ((error.schema ?? []) as { required: string[] }[]).flatMap(
        (each) => each.required,
      );
      return `${where} needs exactly one of ${list(keys.map(quoted), "or")}.`;
    }
    // The union or alternative behind an error already said what is wrong.
    case "anyOf":
      return undefined;
    case "required":
      if (error.schemaPath.includes("/oneOf/")) return undefined;
      return `${where} needs ${quoted(String(error.params.missingProperty))}.`;
  }
  const pattern = error.keyword === "pattern" ? PATTERNS[String(error.params.pattern)] : undefined;
  if (pattern !== undefined) return `${where} ${pattern}.`;
  if (ARGV.test(error.instancePath)) {
    return `${where} is not a program and its arguments: give each as its own list item, never a shell command.`;
  }
  return `${where} ${error.message ?? "is not valid"}.`;
}

/** A JSON type as a person names it. */
const TYPES: Record<string, string> = { object: "an object", array: "a list", string: "text" };

/**
 * A value that fits no alternative fails each one at its own path. Said once, unless an
 * error further in shows which alternative it meant.
 */
function alternatives(errors: readonly ErrorObject[]): {
  said: string[];
  dropped: Set<ErrorObject>;
} {
  const said: string[] = [];
  const dropped = new Set<ErrorObject>();
  for (const union of errors.filter((error) => error.keyword === "anyOf")) {
    const path = union.instancePath;
    const own = errors.filter(
      (error) => error.instancePath === path && error.schemaPath.startsWith(`${union.schemaPath}/`),
    );
    for (const error of own) dropped.add(error);
    if (errors.some((error) => error.instancePath.startsWith(`${path}/`))) continue;
    const forms = own.map((error) =>
      error.keyword === "const"
        ? quoted(String(error.params.allowedValue))
        : (TYPES[String(error.params.type)] ?? String(error.params.type)),
    );
    said.push(`${at(path)} must be ${list(forms, "or")}.`);
  }
  return { said, dropped };
}

function schemaProblems(document: unknown): string[] {
  const errors = validate(document);
  const { said, dropped } = alternatives(errors);
  const rest = errors
    .filter((error) => !dropped.has(error))
    .flatMap((error) => describe(error) ?? []);
  return [...new Set([...said, ...rest])];
}

/** Where a file was found: `earlier` is the folder aireg 0.1 read. */
type Folder = "current" | "earlier";

/**
 * A file's own problems, before it is compared with any other definition. One found in a
 * folder must be named for the id it defines.
 */
function readOne(path: string, text: string, folder?: Folder): TargetFile | SkippedFile {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { path, problems: ["It is not valid JSON."] };
  }
  const problems = schemaProblems(document);
  if (problems.length > 0) return { path, problems };
  const {
    $schema: _,
    overrides,
    ...written
  } = document as Earlier & {
    $schema?: string;
    overrides?: boolean;
  };
  const { definition, warnings, problems: earlier } = upgraded(written);
  const named = folder === "earlier" ? earlierNamed(definition) : definition;
  if (named !== definition) warnings.push(renameWarning(definition.id, named.id));
  problems.push(...earlier, ...builtinProblems(named, overrides === true));
  if (problems.length > 0) return { path, problems };
  if (folder !== undefined && basename(path) !== `${definition.id}.json`) {
    return { path, problems: [`It defines ${quoted(definition.id)}, not its own name.`] };
  }
  return { path, definition: withBuiltinAliases(named), warnings };
}

/** aireg 0.1 named a built-in by the id that is now its alias, so such a file replaces it. */
function earlierNamed(definition: TargetDefinition): TargetDefinition {
  const named = BUILTIN_TARGETS.find((each) => each.aliases?.includes(definition.id));
  return named === undefined ? definition : { ...definition, id: named.id };
}

const renameWarning = (was: string, id: string) =>
  `It defines ${quoted(was)}, the earlier id of ${quoted(id)}; set its id to ${quoted(id)} and name it ${id}.json.`;

/** A file that replaces a built-in keeps answering to its other ids unless it names its own. */
function withBuiltinAliases(definition: TargetDefinition): TargetDefinition {
  if (definition.aliases !== undefined) return definition;
  const aliases = BUILTIN_TARGETS.find((each) => each.id === definition.id)?.aliases;
  return aliases === undefined ? definition : { ...definition, aliases };
}

const CATEGORY_OF: Readonly<Record<string, TargetCategory>> = {
  coding: "coding-agent",
  personal: "personal-agent",
  shared: "shared-folder",
};

/** Keys a file written for aireg 0.1 may carry, read as what replaced them. */
type Earlier = TargetDefinition & { kind?: string; instances?: TargetDefinition["profiles"] };

function upgraded({ kind, instances, ...definition }: Earlier): {
  definition: TargetDefinition;
  warnings: string[];
  problems: string[];
} {
  const warnings: string[] = [];
  const problems: string[] = [];
  let upgrade = definition;
  if (kind !== undefined && definition.category !== undefined) {
    problems.push('It sets both "category" and "kind", its earlier name; keep "category".');
  } else if (kind !== undefined) {
    const category = Object.hasOwn(CATEGORY_OF, kind) ? CATEGORY_OF[kind] : undefined;
    if (category !== undefined) upgrade = { ...upgrade, category };
    warnings.push(
      category === undefined
        ? `It sets "kind": ${quoted(kind)}, which aireg no longer reads; delete it.`
        : `It sets "kind": ${quoted(kind)}, the earlier way to say "category": ${quoted(category)}; set that instead.`,
    );
  }
  if (instances !== undefined && definition.profiles !== undefined) {
    problems.push('It sets both "profiles" and "instances", its earlier name; keep "profiles".');
  } else if (instances !== undefined) {
    upgrade = { ...upgrade, profiles: instances };
    warnings.push('It sets "instances", the earlier name of "profiles"; rename it.');
  }
  return { definition: upgrade, warnings, problems };
}

/** A built-in's id is yours only to replace it; its other ids are never yours. */
function builtinProblems(definition: TargetDefinition, overrides: boolean): string[] {
  const builtin = BUILTIN_TARGETS.find((each) => each.id === definition.id);
  if (builtin !== undefined) {
    return overrides
      ? []
      : [`${quoted(definition.id)} is a built-in target; set "overrides": true to replace it.`];
  }
  const named = BUILTIN_TARGETS.find((each) => each.aliases?.includes(definition.id));
  return named === undefined
    ? []
    : [
        `${quoted(definition.id)} is another name for the built-in target ${quoted(named.id)}; name the file ${named.id}.json and its id ${quoted(named.id)} to replace it.`,
      ];
}

/** What only another definition shows: a read of a target that is not there, for one. */
function crossProblems(file: TargetFile, others: readonly TargetDefinition[]): string[] {
  const { id } = file.definition;
  const known = others.filter((each) => each.id !== id);
  return targetProblems([file.definition], known).map((problem) =>
    problem.startsWith(`${id}: `) ? problem.slice(id.length + 2) : problem,
  );
}

/**
 * A file anyone can check, whatever folder it is in, against the built-in targets and the
 * ones your other files define.
 */
export function checkTargetText(
  path: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetFile | SkippedFile {
  const read = readOne(path, text);
  if ("problems" in read) return read;
  const yours = loadTargetFiles(env).files.map((file) => file.definition);
  const problems = crossProblems(read, [...BUILTIN_TARGETS, ...yours]);
  return problems.length > 0 ? { path, problems } : read;
}

const cache = new Map<string, { stamp: string; read: TargetFile | SkippedFile }>();

/**
 * Read once per change, since every command resolves the targets more than once. The stamp
 * and the text come from one open file, so neither can describe a file the other did not.
 */
function cachedRead(path: string, folder: Folder): TargetFile | SkippedFile {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { path, problems: ["It could not be read."] };
  }
  try {
    const info = fstatSync(fd);
    const stamp = `${info.mtimeMs}:${info.size}`;
    const held = cache.get(path);
    if (held?.stamp === stamp) return held.read;
    const read = readOne(path, readFileSync(fd, "utf8"), folder);
    cache.set(path, { stamp, read });
    return read;
  } catch {
    return { path, problems: ["It could not be read."] };
  } finally {
    closeSync(fd);
  }
}

/**
 * Only your user scope defines a target: a project may select one by id but never define
 * one, so a cloned repository cannot point aireg at paths of its choosing.
 */
export function loadTargetFiles(env: NodeJS.ProcessEnv = process.env): {
  files: TargetFile[];
  skipped: SkippedFile[];
} {
  const read: TargetFile[] = [];
  const skipped: SkippedFile[] = [];
  readFolder(targetsDir(env), read, skipped);
  readFolder(legacyTargetsDir(env), read, skipped, targetsDir(env));
  const unique = withoutTwins(read, skipped);
  // Each is checked against the rest, so one may read from another.
  const known = [...BUILTIN_TARGETS, ...unique.map((each) => each.definition)];
  const files: TargetFile[] = [];
  for (const each of unique) {
    const problems = crossProblems(each, known);
    if (problems.length > 0) skipped.push({ path: each.path, problems });
    else files.push(each);
  }
  return { files, skipped };
}

function readFolder(
  dir: string,
  read: TargetFile[],
  skipped: SkippedFile[],
  /** Set for the folder aireg 0.1 used: where its files belong now. */
  moveTo?: string,
): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return;
  }
  const real = canonical(dir);
  for (const name of names) {
    const path = join(dir, name);
    if (!isWithin(real, dirname(canonical(path))) || canonical(path) === real) {
      skipped.push({ path, problems: ["It links to a file outside your targets folder."] });
      continue;
    }
    const one = cachedRead(path, moveTo === undefined ? "current" : "earlier");
    if ("problems" in one) skipped.push(one);
    else if (moveTo === undefined) read.push(one);
    else {
      const moved = `It is in ${dir}, the targets folder's earlier name; move it to ${moveTo}.`;
      read.push({ ...one, warnings: [...one.warnings, moved] });
    }
  }
}

/** An id defined in both folders is ambiguous, so neither file is used. */
function withoutTwins(read: readonly TargetFile[], skipped: SkippedFile[]): TargetFile[] {
  const unique: TargetFile[] = [];
  for (const each of read) {
    const twin = read.find((other) => other !== each && other.definition.id === each.definition.id);
    if (twin === undefined) {
      unique.push(each);
      continue;
    }
    skipped.push({
      path: each.path,
      problems: [
        `It defines ${quoted(each.definition.id)}, as ${twin.path} does too; keep one of them.`,
      ],
    });
  }
  return unique;
}
