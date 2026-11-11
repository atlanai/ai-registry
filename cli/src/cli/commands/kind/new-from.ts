import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { ARTIFACTS_DIR, ENVELOPE } from "#adapter/filespec/names.ts";
import { list, sanitizeName } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { STREAMED } from "#cli/commands/define.ts";
import type { KindNewFrom } from "#cli/commands/kind/result.ts";
import type { Own } from "#cli/commands/kind.ts";
import { needsInput } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { inBlobStore } from "#core/filespec/indexer.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import {
  entryName,
  fileProblems,
  type KindManifest,
  SPEC_TEXT,
  specFile,
  specOf,
} from "#core/filespec/kind-manifests.ts";
import { check } from "#core/filespec/schema.ts";
import { fractionProblems } from "#core/filespec/validate/folders.ts";
import { withName } from "#core/frontmatter.ts";
import { refuseRedirect } from "#core/fs/fresh.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { authored, type Irregular, refusal } from "#core/fs/tree.ts";
import type { Printer } from "#core/term/printer.ts";
import { nameOf } from "./fields.ts";
import { FRESH } from "./files.ts";
import { namespaceFor } from "./place.ts";

interface Incoming {
  input: string;
  dir: string;
  /** Each file to copy, and the path it takes in the version folder when that differs. */
  entries: string[];
  stored: ReadonlyMap<string, string>;
  name: string;
  front: { file: string; name: string } | undefined;
}

export interface Copied extends KindNewFrom {
  shown: { name: string; at: string }[];
}

export async function newFrom(
  kind: string,
  manifest: KindManifest,
  context: CommandContext,
  paths: readonly string[],
  own: Own,
  yes: boolean,
): Promise<Copied | typeof STREAMED> {
  if (paths.length === 0) {
    throw needsInput(
      `${kind} new --from`,
      "a folder",
      `Name the folder: \`aireg ${kind} new --from <path>\`.`,
    );
  }
  if (own.name !== undefined && paths.length > 1) {
    throw new AiregError("--name renames one folder, and more than one was given.", {
      code: ErrorCode.Usage,
      hint: "Leave out `--name`, and each takes the name its own files give it.",
    });
  }
  const root = requireRegistry(context.cwd);
  // Check every folder first, so a bad one in a batch leaves nothing half copied.
  const found: Incoming[] = [];
  for (const input of paths)
    found.push(await incoming(kind, manifest, context.cwd, input, own.name));
  const names = found.map((item) => item.name);
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  if (twice.length > 0) {
    throw new AiregError(`More than one folder is named ${list([...new Set(twice)])}.`, {
      code: ErrorCode.Usage,
      hint: "Copy them in one at a time, with `--name` to rename one.",
    });
  }

  const namespace = await namespaceFor(root, context.cwd, own, context, yes);
  if (namespace === undefined) return STREAMED;
  for (const item of found) {
    refuseRedirect(root, join(root, ARTIFACTS_DIR, namespace, kind, item.name, "0.1.0"));
    if (existsSync(join(root, ARTIFACTS_DIR, namespace, kind, item.name))) {
      throw new AiregError(`${namespace}/${kind}/${item.name} already exists.`, {
        code: ErrorCode.Conflict,
        hint: `Start its next version with \`aireg ${kind} bump ${item.name}\`.`,
      });
    }
  }

  const copied: { name: string; at: string }[] = [];
  for (const item of found) {
    const at = join(root, ARTIFACTS_DIR, namespace, kind, item.name, "0.1.0");
    await mkdir(at, { recursive: true });
    for (const path of item.entries) {
      await cp(join(item.dir, path), join(at, item.stored.get(path) ?? path), FRESH);
    }
    await rm(join(at, ENVELOPE), { force: true });
    // Rename in the front matter too, since index checks the folder against it.
    if (item.front !== undefined && item.front.name !== item.name) {
      const file = join(at, item.front.file);
      await writeFile(file, withName(await readFile(file, "utf8"), item.name), "utf8");
    }
    copied.push({ name: item.name, at });
  }

  return {
    kind,
    namespace,
    created: copied.map((item) => ({ name: item.name, at: relative(root, item.at) })),
    shown: copied.map((item) => ({ name: item.name, at: relative(context.cwd, item.at) || "." })),
  };
}

export function printCopied(result: Copied, printer: Printer): void {
  for (const item of result.shown) printer.success(`Copied ${item.name} into ${item.at}/.`);
  printer.note("next", "aireg registry index");
}

async function incoming(
  kind: string,
  manifest: KindManifest,
  cwd: string,
  input: string,
  named: string | undefined,
): Promise<Incoming> {
  const source = resolve(cwd, expandUserPath(input));
  if (!existsSync(source)) {
    throw new AiregError(`Nothing exists at ${input}.`, {
      code: ErrorCode.NotFound,
      hint: `Name an existing ${kind} folder or file: \`aireg ${kind} new --from <path>\`.`,
    });
  }
  const isDirectory = (await stat(source)).isDirectory();
  const dir = isDirectory ? source : dirname(source);
  const visible = (path: string) => !path.split("/").some((part) => part.startsWith("."));
  const found = isDirectory ? await authored(dir) : { files: [], irregular: await linked(source) };
  const entries = isDirectory
    ? found.files.map((record) => record.path).filter(visible)
    : [basename(source)];

  // A lone document, such as a semantic model saved as `retail.yaml`, takes the kind's file name.
  const stored = new Map(
    isDirectory ? [] : entries.map((path) => [path, entryName(manifest, path)] as const),
  );
  const texts = new Map<string, string>();
  for (const path of entries.filter((item) => SPEC_TEXT.test(item))) {
    texts.set(stored.get(path) ?? path, await readFile(join(dir, path), "utf8"));
  }
  const spec = specOf(manifest, texts, named);
  const problems = [
    ...found.irregular
      .filter((entry) => visible(entry.path))
      .map((entry) => `${entry.path} ${refusal(entry)}`),
    ...fileProblems(manifest, new Set(entries.map((path) => stored.get(path) ?? path))),
    ...(spec === undefined
      ? ["has no front matter"]
      : [...check(manifest, spec), ...fractionProblems(spec)]),
  ];
  const fallback =
    typeof spec?.name === "string"
      ? spec.name
      : sanitizeName(basename(isDirectory ? source : dirname(source)));
  const name = nameOf(named, fallback);
  if (problems.length > 0) {
    throw new AiregError(`${input} is not a valid ${kind}: ${problems.join("; ")}.`, {
      code: ErrorCode.Invalid,
      hint: `Fix it where it is, then run \`aireg ${kind} new --from ${input}\` again.`,
    });
  }
  const file = specFile(manifest, texts);
  const front =
    file !== undefined && typeof spec?.name === "string" ? { file, name: spec.name } : undefined;
  return { input, dir, entries, stored, name, front };
}

/** One file named by `--from`, refused as a link the way a folder's entries are. */
async function linked(source: string): Promise<Irregular[]> {
  if (!(await lstat(source)).isSymbolicLink()) return [];
  return [{ path: basename(source), reason: "is a symlink" }];
}

/** Carries over the last version's edges and blob-store files, which only the envelope holds. */
export async function keepFromEnvelope(
  from: string,
  to: string,
): Promise<{ relationships: number; blobs: number }> {
  const envelope = await readJson(rootReader(from), ENVELOPE).catch(() => undefined);
  const edges =
    isRecord(envelope) && Array.isArray(envelope.relationships) ? envelope.relationships : [];
  const blobs =
    isRecord(envelope) && Array.isArray(envelope.files) ? envelope.files.filter(inBlobStore) : [];
  if (edges.length === 0 && blobs.length === 0) return { relationships: 0, blobs: 0 };
  const stub = {
    ...(blobs.length === 0 ? {} : { files: blobs }),
    ...(edges.length === 0 ? {} : { relationships: edges }),
  };
  await writeFile(join(to, ENVELOPE), `${JSON.stringify(stub, null, 2)}\n`);
  return { relationships: edges.length, blobs: blobs.length };
}
