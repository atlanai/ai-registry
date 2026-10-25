import {
  Ajv2020,
  type CodeOptions,
  type ErrorObject,
  type SchemaObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { RE2JS, RE2JSSyntaxException } from "re2js";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { quoted } from "#adapter/text.ts";
import { isRecord } from "#core/fields.ts";
import manifestSchema from "#schema/kind-manifest.schema.json" with { type: "json" };

/** Validators follow the lifetime of the manifest objects loaded for an operation. */
const compiled = new WeakMap<object, ValidateFunction>();

/** `translateRegExp` would turn `\k<name>` into the literal text `k<name>`. */
const NAMED_BACKREFERENCE = /(?:^|[^\\])(?:\\\\)*\\k</;

/**
 * Registries serve their own kind schemas, so patterns run on RE2, which matches in linear
 * time; a lookaround or backreference fails to compile.
 */
const re2: NonNullable<CodeOptions["regExp"]> = Object.assign(
  // RE2 always matches by code point, as the "u" flag Ajv passes asks.
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
          : (error as Error).message;
      throw new Error(`pattern ${quoted(pattern)} uses syntax aireg does not support: ${reason}`);
    }
  },
  // Ajv names the engine only in standalone code, which aireg never generates.
  { code: "re2" },
);

function compiler(): Ajv2020 {
  // Extensions are annotations. Validation must never rewrite the native document.
  return new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    code: { regExp: re2 },
  });
}

const manifestShape = compiler().compile(manifestSchema);

/** Validate both the manifest vocabulary and its Draft 2020-12 schema, resolving local refs only. */
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
    return document === true ? {} : document === false ? { not: {} } : document;
  };
  const validate = await ajv.compileAsync(schema);
  compiled.set(schema, validate);
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

function message(error: ErrorObject, value: unknown): string {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const field = (extra?: string) =>
    `\`${[...path, ...(extra === undefined ? [] : [extra])].join(".")}\``;
  const where = path.length === 0 ? "the front matter" : field();
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

/** Problems with a value, without coercion, default insertion, or removal of fields. */
export function check(schema: SchemaObject, value: unknown): string[] {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    try {
      validate = compiler().compile(schema);
      if (schema.$async !== undefined)
        return ["kind schema uses unsupported asynchronous validation"];
      compiled.set(schema, validate);
    } catch (error) {
      return [`kind schema is invalid: ${(error as Error).message}`];
    }
  }
  return validate(value) ? [] : (validate.errors ?? []).map((error) => message(error, value));
}
