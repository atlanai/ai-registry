import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";
import type { ConfigValue } from "#core/harness/contract.ts";
import { NAME } from "#core/product.ts";
import { dropTable, readTable, setKeys, type TomlScalar, unsetKeys } from "./toml.ts";

type Table = Record<string, unknown>;

/** The comment on a list item aireg added, so one a person wrote is never taken out. */
const MARK = NAME;

/** The operations a register entry needs, over one config file in either format. */
export interface ConfigDocument {
  /** The table at `at`, or undefined when there is none. */
  table(at: readonly string[]): Table | undefined;
  set(at: readonly string[], values: Readonly<Record<string, ConfigValue>>): void;
  unset(at: readonly string[], keys: readonly string[]): void;
  drop(at: readonly string[]): void;
  list(at: readonly string[]): unknown[] | undefined;
  setList(at: readonly string[], items: unknown[]): void;
  /** Adds `value` to the list at `at`, marked as aireg's, unless the list holds it already. */
  addMarked(at: readonly string[], value: string): void;
  /** Removes `value` from the list at `at` only when aireg marked it; true when it did. */
  dropMarked(at: readonly string[], value: string): boolean;
  render(): string;
  /** The parsed document, for comparing with what a file started as. */
  value(): unknown;
}

function scalars(values: Readonly<Record<string, ConfigValue>>, file: string) {
  const out: Record<string, TomlScalar> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "object") {
      throw new AiregError(`Only plain values can be written to ${file}.`, {
        code: ErrorCode.Invalid,
      });
    }
    out[key] = value;
  }
  return out;
}

export function tomlDocument(text: string, file: string): ConfigDocument {
  let current = text;
  const unsupported = (): never => {
    throw new AiregError(`${file} holds no list aireg can edit.`, { code: ErrorCode.Invalid });
  };
  return {
    table: (at) => readTable(current, at),
    set: (at, values) => {
      current = setKeys(current, at, scalars(values, file));
    },
    unset: (at, keys) => {
      current = unsetKeys(current, at, keys);
    },
    drop: (at) => {
      current = dropTable(current, at);
    },
    list: unsupported,
    setList: unsupported,
    addMarked: unsupported,
    dropMarked: unsupported,
    render: () => current,
    // A blank file is an empty table; one holding only comments is still someone's text.
    value: () => (current.trim() === "" ? {} : current),
  };
}

export function jsonDocument(text: string | undefined, start: Table, file: string): ConfigDocument {
  let root: Table;
  if (text === undefined) root = structuredClone(start);
  else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AiregError(`${file} is not valid JSON.`, { code: ErrorCode.Invalid, cause: error });
    }
    if (!isRecord(parsed)) {
      throw new AiregError(`${file} does not hold a JSON object.`, { code: ErrorCode.Invalid });
    }
    root = parsed;
  }

  /** The object holding the last key of `at`, made on the way when `create` is set. */
  const parent = (at: readonly string[], create: boolean): Table | undefined => {
    let node = root;
    for (const key of at.slice(0, -1)) {
      const next = node[key];
      if (next === undefined && create) node[key] = {};
      else if (!isRecord(next)) {
        if (next === undefined) return undefined;
        throw new AiregError(`${file} has a ${quoted(key)} that is not an object.`, {
          code: ErrorCode.Invalid,
        });
      }
      node = node[key] as Table;
    }
    return node;
  };
  const get = (at: readonly string[]): unknown =>
    at.length === 0 ? root : parent(at, false)?.[at.at(-1) as string];

  return {
    table: (at) => {
      const found = get(at);
      return isRecord(found) ? found : undefined;
    },
    set: (at, values) => {
      const found = get(at);
      if (found !== undefined && !isRecord(found)) {
        throw new AiregError(`${file} has a ${quoted(at.join("."))} that is not an object.`, {
          code: ErrorCode.Invalid,
        });
      }
      const table = found ?? {};
      Object.assign(table, structuredClone(values));
      if (at.length > 0) (parent(at, true) as Table)[at.at(-1) as string] = table;
    },
    unset: (at, keys) => {
      const table = get(at);
      if (isRecord(table)) for (const key of keys) delete table[key];
    },
    drop: (at) => {
      if (at.length === 0) root = {};
      else delete parent(at, false)?.[at.at(-1) as string];
    },
    list: (at) => {
      const found = get(at);
      if (found === undefined) return undefined;
      if (!Array.isArray(found)) {
        throw new AiregError(`${file} has a ${quoted(at.join("."))} that is not a list.`, {
          code: ErrorCode.Invalid,
        });
      }
      return found;
    },
    setList: (at, items) => {
      if (at.length === 0) return;
      (parent(at, true) as Table)[at.at(-1) as string] = items;
    },
    addMarked: () => {
      throw new AiregError(`${file} cannot mark what aireg adds to a list.`, {
        code: ErrorCode.Invalid,
      });
    },
    dropMarked: () => false,
    render: () => `${JSON.stringify(root, null, 2)}\n`,
    value: () => root,
  };
}

/** Edited through the document, so the comments and key order a person wrote survive. */
export function yamlDocument(text: string | undefined, start: Table, file: string): ConfigDocument {
  const invalid = (what: string) => new AiregError(`${file} ${what}.`, { code: ErrorCode.Invalid });
  const doc =
    text === undefined || text.trim() === ""
      ? new Document(structuredClone(start))
      : parseDocument(text, { logLevel: "error" });
  if (doc.errors.length > 0) throw invalid("is not valid YAML");
  // A file of comments alone holds no mapping yet; the comments stay above the one made.
  if (doc.contents === null) doc.contents = doc.createNode(structuredClone(start));
  if (!isMap(doc.contents)) throw invalid("does not hold a YAML mapping");
  const isOurs = (item: unknown, value: string) =>
    isScalar(item) && item.value === value && item.comment?.trim() === MARK;

  const get = (at: readonly string[]): unknown =>
    at.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), doc.toJS());
  const table = (at: readonly string[]): Table | undefined => {
    const found = get(at);
    return isRecord(found) ? found : undefined;
  };

  return {
    table,
    set: (at, values) => {
      const found = get(at);
      if (found !== undefined && !isRecord(found)) {
        throw invalid(`has a ${quoted(at.join("."))} that is not a mapping`);
      }
      for (const [key, value] of Object.entries(values)) doc.setIn([...at, key], value);
    },
    unset: (at, keys) => {
      if (table(at) === undefined) return;
      for (const key of keys) doc.deleteIn([...at, key]);
    },
    drop: (at) => {
      doc.deleteIn(at);
    },
    list: (at) => {
      const found = get(at);
      if (found === undefined) return undefined;
      if (!Array.isArray(found)) throw invalid(`has a ${quoted(at.join("."))} that is not a list`);
      return found;
    },
    setList: (at, items) => {
      const node = doc.getIn(at, true);
      if (!isSeq(node)) {
        doc.setIn(at, items);
        return;
      }
      // Items already there keep their place and comments; only the difference changes.
      node.items = node.items.filter((item) =>
        items.some((want) => isDeepStrictEqual(want, (item as { toJSON(): unknown }).toJSON())),
      );
      for (const want of items) {
        const has = node.items.some((item) =>
          isDeepStrictEqual(want, (item as { toJSON(): unknown }).toJSON()),
        );
        if (!has) node.items.push(doc.createNode(want));
      }
    },
    addMarked: (at, value) => {
      const node = doc.getIn(at, true);
      if (node !== undefined && !isSeq(node)) {
        throw invalid(`has a ${quoted(at.join("."))} that is not a list`);
      }
      if (isSeq(node) && node.items.some((item) => isScalar(item) && item.value === value)) return;
      const item = doc.createNode(value);
      item.comment = ` ${MARK}`;
      if (isSeq(node)) {
        node.items.push(item);
        return;
      }
      const list = new YAMLSeq();
      list.items.push(item);
      doc.setIn(at, list);
    },
    dropMarked: (at, value) => {
      const node = doc.getIn(at, true);
      if (!isSeq(node)) return false;
      const index = node.items.findIndex((item) => isOurs(item, value));
      if (index < 0) return false;
      node.items.splice(index, 1);
      return true;
    },
    render: () => doc.toString(),
    value: () => doc.toJS(),
  };
}
