import {
  Ajv2020,
  type CodeOptions,
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { RE2JS, RE2JSSyntaxException } from "re2js";
import { messageOf } from "#adapter/errors.ts";
import { isRecord } from "#adapter/fields.ts";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { quoted } from "#adapter/text.ts";
import manifestSchema from "#schema/kind-manifest.schema.json" with { type: "json" };
import ossie011 from "#schema/kinds/vendor/ossie/0.1.1/osi-schema.json" with { type: "json" };
import ossie020 from "#schema/kinds/vendor/ossie/0.2.0.dev0/ossie-schema.json" with {
  type: "json",
};

/**
 * The schemas a bundled kind manifest refers to, under the path its `$ref` resolves to. A
 * registry that serves its own manifest serves these beside it, and `prepareManifest` reads them
 * from there.
 */
const BUNDLED_REFS: Readonly<Record<string, SchemaObject>> = {
  "kinds/vendor/ossie/0.1.1/osi-schema.json": ossie011,
  "kinds/vendor/ossie/0.2.0.dev0/ossie-schema.json": ossie020,
};

/** Validators follow the lifetime of the manifest objects loaded for an operation. */
const compiled = new WeakMap<object, ValidateFunction>();

/** Each file rule's schema, as `fileSchema` scopes it to its manifest. */
const scoped = new WeakMap<object, SchemaObject>();

/** `translateRegExp` would turn `\k<name>` into the literal text `k<name>`. */
const NAMED_BACKREFERENCE = /(?:^|[^\\])(?:\\\\)*\\k</;

/**
 * Registries serve their own kind schemas, so patterns run on RE2: linear time, by code point as
 * Ajv's "u" flag asks, and a lookaround or backreference fails to compile.
 */
const re2: NonNullable<CodeOptions["regExp"]> = Object.assign(
  (pattern: string) => {
    if (NAMED_BACKREFERENCE.test(pattern)) {
      throw new Error(
        `pattern ${quoted(pattern)} uses syntax aireg does not support: a named backreference`,
      );
    }
    try {
      return RE2JS.compile(RE2JS.translateRegExp(pattern));
    } catch (error) {
      const reason =
        error instanceof RE2JSSyntaxException
          ? [error.getDescription(), error.getPattern()].filter(Boolean).join(" at ")
          : messageOf(error);
      throw new Error(`pattern ${quoted(pattern)} uses syntax aireg does not support: ${reason}`);
    }
  },
  { code: "re2" },
);

const manifestShape = compiler().compile(manifestSchema);

/** Resolves local refs only, and caches the compiled validator `check` uses. */
export async function prepareManifest(
  root: string,
  schema: Record<string, unknown>,
): Promise<void> {
  if (!manifestShape(schema)) {
    throw new Error(
      `is not a kind manifest: ${manifestShape.errors?.map((e) => e.message).join("; ")}`,
    );
  }
  if (schema.$async !== undefined) throw new Error("uses unsupported asynchronous validation");
  const ajv = compiler();
  const read = rootReader(root);
  ajv.opts.loadSchema = async (uri) => {
    // Relative identifiers are rooted at the registry, just like the bundled schemas.
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/")) {
      throw new Error(
        `cannot resolve external schema ${quoted(uri)}; serve its schema inside the registry`,
      );
    }
    const document = await readJson(read, decodeURIComponent(uri));
    if (typeof document !== "boolean" && !isRecord(document)) {
      throw new Error(`referenced schema ${quoted(uri)} is missing or is not a schema`);
    }
    if (isRecord(document) && document.$async !== undefined) {
      throw new Error(`referenced schema ${quoted(uri)} uses unsupported asynchronous validation`);
    }
    // Ajv's asynchronous loader accepts objects; these are equivalent boolean schemas.
    if (document === true) return {};
    if (document === false) return { not: {} };
    return document;
  };
  compiled.set(schema, await ajv.compileAsync(schema));
  for (const rule of fileRules(schema)) {
    const own = fileSchema(schema, rule);
    // Each in its own compiler: it takes the manifest's `$id`, which `ajv` already holds.
    if (own !== undefined) {
      const separate = compiler();
      separate.opts.loadSchema = ajv.opts.loadSchema;
      compiled.set(own, await separate.compileAsync(own));
    }
  }
}

/** Every rule in a manifest's `x-registry-files`, whatever list it sits in. */
export function fileRules(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const files = manifest["x-registry-files"];
  if (!isRecord(files)) return [];
  const sets = [
    files.required,
    files.optional,
    ...(Array.isArray(files.one_of) ? files.one_of : []),
  ];
  return sets.flatMap((set) => (Array.isArray(set) ? set.filter(isRecord) : []));
}

/**
 * The schema a file rule gives its file, with the manifest's `$id` and `$defs`, so that
 * `#/$defs/…` and relative references resolve as they would inside the manifest.
 */
export function fileSchema(
  manifest: Record<string, unknown>,
  rule: Record<string, unknown>,
): SchemaObject | undefined {
  const own = rule.schema;
  if (typeof own !== "boolean" && !isRecord(own)) return undefined;
  let schema = scoped.get(rule);
  if (schema === undefined) {
    let body: SchemaObject = {};
    if (own === false) body = { not: {} };
    else if (own !== true) body = own;
    const defs = { ...(isRecord(manifest.$defs) ? manifest.$defs : {}), ...body.$defs };
    schema = { ...body, $defs: defs };
    for (const key of ["$schema", "$id"] as const) {
      if (typeof manifest[key] === "string") schema[key] = manifest[key];
    }
    scoped.set(rule, schema);
  }
  return schema;
}

function compiler(): Ajv2020 {
  // Extensions are annotations. Validation must never rewrite the native document.
  return new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    code: { regExp: re2 },
  });
}

/** Problems with a value, without coercion, default insertion, or removal of fields. */
export function check(schema: SchemaObject, value: unknown, whole = "the front matter"): string[] {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    try {
      const ajv = compiler();
      for (const [path, referenced] of Object.entries(BUNDLED_REFS))
        ajv.addSchema(referenced, path);
      validate = ajv.compile(schema);
      if (schema.$async !== undefined)
        return ["kind schema uses unsupported asynchronous validation"];
      compiled.set(schema, validate);
    } catch (error) {
      return [`kind schema is invalid: ${messageOf(error)}`];
    }
  }
  if (validate(value)) return [];
  // A failed `if`/`then` repeats, as "must match then schema", what the branch's own errors say.
  const errors = (validate.errors ?? []).filter((error) => error.keyword !== "if");
  return errors.map((error) => message(error, value, whole));
}

function message(error: ErrorObject, value: unknown, whole: string): string {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const field = (extra?: string) =>
    `\`${[...path, ...(extra === undefined ? [] : [extra])].join(".")}\``;
  const where = path.length === 0 ? whole : field();
  const actual = valueAt(value, error.instancePath);
  switch (error.keyword) {
    case "required":
      return `${field(error.params.missingProperty)} is required`;
    case "additionalProperties":
      return `${field(error.params.additionalProperty)} is not a field this kind takes`;
    case "minLength":
      return actual === ""
        ? `${where} is empty`
        : `${where} is shorter than ${error.params.limit} characters`;
    case "maxLength":
      return `${where} is longer than ${error.params.limit} characters`;
    case "pattern":
      return `${where} ${quoted(String(actual))} does not match ${error.params.pattern}`;
    default:
      return `${where} ${error.message}`;
  }
}

function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.split("/").slice(1)) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
