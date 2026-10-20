import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isWithin } from "#adapter/paths.ts";
import { list, quoted } from "#adapter/text.ts";
import { canonical } from "#core/fs/canonical.ts";
import { harnessesDir } from "#core/store/paths.ts";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";
import schema from "#schema/harness.schema.json" with { type: "json" };
import { harnessProblems } from "./check.ts";
import type { HarnessDefinition } from "./contract.ts";

/** Where a harness that no file defines comes from. */
export const BUILT_IN = "built-in";

export interface HarnessFile {
  path: string;
  definition: HarnessDefinition;
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

/** A file's own problems, before it is compared with any other definition. */
function readOne(path: string, text: string): HarnessFile | SkippedFile {
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
    ...definition
  } = document as HarnessDefinition & {
    $schema?: string;
    overrides?: boolean;
  };
  const builtin = BUILTIN_HARNESSES.some((each) => each.id === definition.id);
  if (builtin && overrides !== true) {
    problems.push(
      `${quoted(definition.id)} is a built-in harness; set "overrides": true to replace it.`,
    );
  }
  return problems.length > 0 ? { path, problems } : { path, definition };
}

/** What only another definition shows: a read of a harness that is not there, for one. */
function crossProblems(file: HarnessFile, others: readonly HarnessDefinition[]): string[] {
  const { id } = file.definition;
  const known = others.filter((each) => each.id !== id);
  return harnessProblems([file.definition], known).map((problem) =>
    problem.startsWith(`${id}: `) ? problem.slice(id.length + 2) : problem,
  );
}

/**
 * A file anyone can check, whatever folder it is in, against the built-in harnesses and the
 * ones your other files define.
 */
export function checkHarnessText(
  path: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessFile | SkippedFile {
  const read = readOne(path, text);
  if ("problems" in read) return read;
  const yours = loadHarnessFiles(env).files.map((file) => file.definition);
  const problems = crossProblems(read, [...BUILTIN_HARNESSES, ...yours]);
  return problems.length > 0 ? { path, problems } : read;
}

const cache = new Map<string, { stamp: string; read: HarnessFile | SkippedFile }>();

/** Read once per change, since every command resolves the harnesses more than once. */
function cachedRead(path: string): HarnessFile | SkippedFile {
  let stamp: string;
  try {
    const info = statSync(path);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return { path, problems: ["It could not be read."] };
  }
  const held = cache.get(path);
  if (held?.stamp === stamp) return held.read;
  let read: HarnessFile | SkippedFile;
  try {
    read = readOne(path, readFileSync(path, "utf8"));
  } catch {
    read = { path, problems: ["It could not be read."] };
  }
  cache.set(path, { stamp, read });
  return read;
}

/**
 * Only your user scope defines a harness: a project may select one by id but never define
 * one, so a cloned repository cannot point aireg at paths of its choosing.
 */
export function loadHarnessFiles(env: NodeJS.ProcessEnv = process.env): {
  files: HarnessFile[];
  skipped: SkippedFile[];
} {
  const dir = harnessesDir(env);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return { files: [], skipped: [] };
  }
  const real = canonical(dir);
  const read: HarnessFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!isWithin(real, dirname(canonical(path))) || canonical(path) === real) {
      skipped.push({ path, problems: ["It links to a file outside your harnesses folder."] });
      continue;
    }
    const one = cachedRead(path);
    if ("problems" in one) skipped.push(one);
    else if (`${one.definition.id}.json` !== basename(path)) {
      skipped.push({
        path,
        problems: [`It defines ${quoted(one.definition.id)}, not its own name.`],
      });
    } else read.push(one);
  }
  // Each is checked against the rest, so one may read from another.
  const known = [...BUILTIN_HARNESSES, ...read.map((each) => each.definition)];
  const files: HarnessFile[] = [];
  for (const each of read) {
    const problems = crossProblems(each, known);
    if (problems.length > 0) skipped.push({ path: each.path, problems });
    else files.push(each);
  }
  return { files, skipped };
}
