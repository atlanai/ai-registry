import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { redirection } from "#adapter/files.ts";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import {
  ENVELOPE,
  isArtifactName,
  isDeviceName,
  isNamespace,
  isVersion,
} from "#adapter/filespec/names.ts";
import { isWithin } from "#adapter/paths.ts";
import { bumpVersion, compareVersion, parseVersion } from "#adapter/semver.ts";
import { list, plural, quoted, sanitizeName } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { cancel, type Interaction, interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, defaultIo, select, text } from "#cli/prompt/index.ts";
import { withName } from "#core/catalog/frontmatter.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord, RESERVED_KEYS } from "#core/fields.ts";
import { inBlobStore } from "#core/filespec/write/indexer.ts";
import { findRegistry, requireRegistry } from "#core/filespec/write/init.ts";
import {
  check,
  fileProblems,
  type KindManifest,
  primaryFiles,
  type SchemaNode,
  specFile,
  specOf,
} from "#core/filespec/write/kinds.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { authored, type Irregular, present, refusal } from "#core/fs/tree.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import { type CommandContext, type CommandSpec, runAction } from "./index.ts";

interface Own extends Record<string, unknown> {
  namespace?: string;
  file?: string;
  set?: string[];
  name?: string;
  from?: string[];
}

/** Written for a required field the command cannot know; `aireg registry validate` refuses it. */
const PLACEHOLDER = "TODO";

/** Copies that never write over anything, so a file already there is a conflict, not lost. */
const FRESH = { recursive: true, errorOnExist: true, force: false } as const;

/**
 * Every write here lands under `root`, and a registry ships its own folders: a link
 * anywhere from `root` down to `path` would put the new files somewhere else.
 */
function refuseRedirect(root: string, path: string): void {
  const found = redirection(root, path);
  if (found === undefined) return;
  const what = found.problem === "symlink" ? "a symlink" : "not a folder";
  throw new AiregError(`${found.at} is ${what}, so nothing was written through it.`, {
    code: ErrorCode.Invalid,
    hint: "Replace it with a real folder, then run it again.",
  });
}

// Exclusive create: a file that appeared after the checks is reported, never replaced.
async function writeFresh(path: string, content: string, shown: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new AiregError(`${shown} already exists.`, {
      code: ErrorCode.Conflict,
      hint: "Move it aside, or name a new artifact.",
    });
  }
}

/** `aireg <kind> <action>`: one set of verbs for every kind a registry holds. */
export async function runKind(
  spec: CommandSpec,
  manifest: KindManifest,
  context: CommandContext,
): Promise<void> {
  const kind = spec.name;
  const { positionals, own, common } = parse<Own>(context.argv, spec);
  const [action, argument, extra] = positionals;
  if (action === undefined) {
    const actions = (spec.actions ?? []).map((a) => a.name);
    throw new AiregError(`\`aireg ${kind}\` needs an action.`, {
      code: ErrorCode.Usage,
      hint: `Use ${list(actions, "or")}.`,
    });
  }
  return runAction(spec, action, {
    // A shell glob after --from lands as more positionals, so they are more paths.
    new: () =>
      own.from === undefined
        ? init(kind, manifest, context, argument, own, common.yes)
        : newFrom(kind, manifest, context, [...own.from, ...positionals.slice(1)], own, common.yes),
    bump: () => version(kind, context, argument, extra, own),
  });
}

/** The namespace a folder inside `artifacts/<namespace>/` belongs to. */
function namespaceHere(root: string, cwd: string): string | undefined {
  const artifacts = join(root, "artifacts");
  if (!isWithin(artifacts, cwd)) return undefined;
  const inside = relative(artifacts, cwd).split(sep)[0];
  return inside !== undefined && isNamespace(inside) ? inside : undefined;
}

/** Where a new version goes: the namespace you are in, the one named, or the one picked. */
async function namespaceFor(
  root: string,
  cwd: string,
  own: Own,
  context: CommandContext,
  yes: boolean,
): Promise<string | undefined> {
  if (own.namespace !== undefined) return valid(own.namespace);
  const inside = namespaceHere(root, cwd);
  if (inside !== undefined) return inside;
  const existing = (await readdir(join(root, "artifacts"), { withFileTypes: true }).catch(() => []))
    .filter((item) => item.isDirectory() && isNamespace(item.name))
    .map((item) => item.name)
    .sort();
  const step = interaction(context.printer, defaultIo(), yes);
  if (!interactive(step) || existing.length === 0) {
    throw new AiregError("No namespace was given.", {
      code: ErrorCode.Usage,
      hint:
        existing.length === 0
          ? "Pass `--namespace <namespace>`, or run it inside artifacts/<namespace>."
          : `Pass \`--namespace\` with ${list(existing, "or")}, or run it inside artifacts/<namespace>.`,
    });
  }
  const picked = await select<string>(
    {
      message: "Which namespace?",
      style: context.printer.errStyle,
      initial: existing[0] as string,
      options: existing.map((item) => ({ value: item, label: item })),
    },
    step.io,
  );
  if (canceled(picked)) {
    cancel(step);
    return undefined;
  }
  return picked;
}

/** Accepted by the grammar, but no Windows checkout of the registry could hold it. */
function refuseDevice(name: string): void {
  if (!isDeviceName(name)) return;
  throw new AiregError(`${quoted(name)} is a device name on Windows.`, {
    code: ErrorCode.Usage,
    hint: "Choose another name; con, prn, aux, nul, com1 to com9 and lpt1 to lpt9 cannot be folder names on Windows.",
  });
}

function valid(namespace: string): string {
  refuseDevice(namespace);
  if (!isNamespace(namespace)) {
    throw new AiregError(`${quoted(namespace)} is not a namespace.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, such as platform.",
    });
  }
  return namespace;
}

function nameOf(input: string | undefined, fallback: string): string {
  const name = input ?? fallback;
  refuseDevice(name);
  if (!isArtifactName(name)) {
    throw new AiregError(`${quoted(name)} is not a valid artifact name.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, such as deploy.",
    });
  }
  return name;
}

/** `a.b=c` pairs, applied over whatever the manifest asks for. */
function settings(pairs: readonly string[] | undefined): [string[], string][] {
  return (pairs ?? []).map((pair) => {
    const at = pair.indexOf("=");
    const path = pair.slice(0, Math.max(at, 0)).split(".");
    if (at < 1 || path.some((key) => key === "" || RESERVED_KEYS.has(key))) {
      throw new AiregError(`--set takes <key>=<value>, not ${quoted(pair)}.`, {
        code: ErrorCode.Usage,
        hint: "Name a field, with dots for nested ones: `--set metadata.category=engineering`.",
      });
    }
    return [path, pair.slice(at + 1)];
  });
}

/** The fields a new artifact needs, filled from the name, defaults, `--set`, then placeholders. */
function scaffold(
  schema: SchemaNode,
  name: string,
  sets: readonly [string[], string][],
): { fields: Record<string, unknown>; todo: string[] } {
  const todo: string[] = [];
  function fill(node: SchemaNode, path: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of node.required ?? []) {
      const child = node.properties?.[key] ?? {};
      const at = [...path, key];
      if (at.join(".") === "name") out[key] = name;
      else if (child.default !== undefined) out[key] = child.default;
      else if ([child.type].flat().includes("object") && child.required !== undefined)
        out[key] = fill(child, at);
      else {
        out[key] = PLACEHOLDER;
        todo.push(at.join("."));
      }
    }
    return out;
  }
  const fields = fill(schema, []);
  for (const [path, value] of sets) assign(fields, todo, path, value);
  return { fields, todo };
}

function assign(fields: Record<string, unknown>, todo: string[], path: string[], value: string) {
  let node = fields;
  for (const key of path.slice(0, -1)) {
    node[key] = typeof node[key] === "object" && node[key] !== null ? node[key] : {};
    node = node[key] as Record<string, unknown>;
  }
  node[path.at(-1) as string] = value;
  const index = todo.indexOf(path.join("."));
  if (index !== -1) todo.splice(index, 1);
}

/** Asked on a terminal; an empty answer leaves the field to fill in later. */
async function askFields(step: Interaction, fields: Record<string, unknown>, todo: string[]) {
  for (const path of [...todo]) {
    const label = path.replaceAll(".", " ");
    const message = label.charAt(0).toUpperCase() + label.slice(1);
    const answer = await text(
      {
        message,
        style: step.printer.errStyle,
        hint: "Type a value, or press Enter to leave it as TODO for now.",
      },
      step.io,
    );
    if (canceled(answer)) return false;
    if (answer !== "") assign(fields, todo, path.split("."), answer);
  }
  return true;
}

/** A registry folder's name is never the artifact's, so there the name is asked for. */
async function askName(kind: string, step: Interaction): Promise<string | undefined> {
  if (!interactive(step))
    throw new AiregError(`\`aireg ${kind} new\` needs a name in a registry.`, {
      code: ErrorCode.Usage,
      hint: `Run \`aireg ${kind} new <name>\`.`,
    });
  const answer = await text(
    {
      message: "Name",
      style: step.printer.errStyle,
      hint: "Type a name: lowercase letters, digits and hyphens, such as pr-review.",
    },
    step.io,
  );
  return canceled(answer) ? undefined : nameOf(answer, answer);
}

function render(path: string, fields: Record<string, unknown>): string {
  if (path.endsWith(".json")) return `${JSON.stringify(fields, undefined, 2)}\n`;
  return `---\n${stringify(fields, { lineWidth: 0 })}---\n`;
}

/** `artifacts/<namespace>/<kind>/<name>/0.1.0`, with the namespace and name asked for when missing. */
async function registryPlace(
  kind: string,
  root: string,
  context: CommandContext,
  own: Own,
  yes: boolean,
  given: string | undefined,
  step: Interaction,
): Promise<{ name: string; at: string } | undefined> {
  const namespace = await namespaceFor(root, context.cwd, own, context, yes);
  if (namespace === undefined) return undefined;
  const name = given ?? (await askName(kind, step));
  if (name === undefined) {
    cancel(step);
    return undefined;
  }
  const home = join(root, "artifacts", namespace, kind, name);
  if (existsSync(home)) {
    throw new AiregError(`${namespace}/${kind}/${name} already exists.`, {
      code: ErrorCode.Conflict,
      hint: `Start its next version with \`aireg ${kind} bump ${name}\`.`,
    });
  }
  return { name, at: join(home, "0.1.0") };
}

/** `./<name>`, or this folder named after itself when no name is given. */
function outsidePlace(
  kind: string,
  files: readonly string[],
  context: CommandContext,
  given: string | undefined,
): { name: string; at: string } {
  const name = given ?? nameOf(undefined, sanitizeName(basename(context.cwd)));
  const at = given === undefined ? context.cwd : join(context.cwd, name);
  const shown = relative(context.cwd, at) || ".";
  for (const file of files) {
    if (existsSync(join(at, file)))
      throw new AiregError(`${join(shown, file)} already exists.`, {
        code: ErrorCode.Conflict,
        hint: `Run it in an empty folder, or name a new one: \`aireg ${kind} new <name>\`.`,
      });
  }
  return { name, at };
}

async function init(
  kind: string,
  manifest: KindManifest,
  context: CommandContext,
  input: string | undefined,
  own: Own,
  yes: boolean,
): Promise<void> {
  const root = findRegistry(context.cwd);
  const inRegistry = root !== undefined;
  const given = input === undefined ? undefined : nameOf(input, input);
  const files = primaryFiles(manifest, own.file);
  if (files.length === 0)
    throw new AiregError(`The ${kind} kind names no files to create.`, {
      code: ErrorCode.Invalid,
      hint: `List the ${kind} kind's files in the registry's \`kinds/\`, then run it again.`,
    });
  const sets = settings(own.set);
  const step = interaction(context.printer, defaultIo(), yes);

  const place = inRegistry
    ? await registryPlace(kind, root, context, own, yes, given, step)
    : outsidePlace(kind, files, context, given);
  if (place === undefined) return;
  const { name, at } = place;
  const shown = relative(context.cwd, at) || ".";

  const { fields, todo } = scaffold(manifest, name, sets);
  if (interactive(step) && !(await askFields(step, fields, todo))) return cancel(step);

  const created = files.map((file) => (shown === "." ? file : `${shown}/${file}`));
  for (const file of files) refuseRedirect(inRegistry ? root : context.cwd, join(at, file));
  await mkdir(at, { recursive: true });
  for (const [index, file] of files.entries()) {
    await writeFresh(join(at, file), render(file, fields), created[index] as string);
  }

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { kind, name, created, todo } });
    return;
  }
  context.printer.success(`Created ${list(created)}.`);
  if (todo.length > 0) context.printer.note("todo", list(todo));
  if (inRegistry) context.printer.note("edit", shown);
  // Publish takes a skill's folder, and any other kind's Markdown file.
  const publishable = files.includes(SKILL_ENTRY)
    ? shown
    : (created.find((file) => file.endsWith(".md")) ?? shown);
  context.printer.note(
    "next",
    inRegistry
      ? "aireg registry index"
      : `aireg publish ${publishable} --to <registry>/<namespace>`,
  );
}

/** One existing folder, read and checked before anything is copied. */
interface Incoming {
  input: string;
  dir: string;
  entries: string[];
  name: string;
  /** The Markdown file holding the front matter, and the name it gives. */
  front: { file: string; name: string } | undefined;
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

  const texts = new Map<string, string>();
  for (const path of entries.filter((item) => /\.(md|json)$/.test(item))) {
    texts.set(path, await readFile(join(dir, path), "utf8"));
  }
  const spec = specOf(manifest, texts, named);
  const problems = [
    ...found.irregular
      .filter((entry) => visible(entry.path))
      .map((entry) => `${entry.path} ${refusal(entry)}`),
    ...fileProblems(manifest, new Set(entries)),
    ...(spec === undefined ? ["has no front matter"] : check(manifest, spec)),
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
  return { input, dir, entries, name, front };
}

/** One file named by `--from`, refused as a link the way a folder's entries are. */
async function linked(source: string): Promise<Irregular[]> {
  if (!(await lstat(source)).isSymbolicLink()) return [];
  return [{ path: basename(source), reason: "is a symlink" }];
}

/** Starts new artifacts from folders that already exist; the originals stay where they are. */
async function newFrom(
  kind: string,
  manifest: KindManifest,
  context: CommandContext,
  paths: readonly string[],
  own: Own,
  yes: boolean,
): Promise<void> {
  if (paths.length === 0) {
    throw new AiregError(`\`aireg ${kind} new --from\` needs a folder.`, {
      code: ErrorCode.Usage,
      hint: `Name the folder: \`aireg ${kind} new --from <path>\`.`,
    });
  }
  if (own.name !== undefined && paths.length > 1) {
    throw new AiregError("--name renames one folder, and more than one was given.", {
      code: ErrorCode.Usage,
      hint: "Leave out `--name`, and each takes the name its own files give it.",
    });
  }
  const root = requireRegistry(context.cwd);
  // Every folder is checked first, so a bad one in a batch leaves nothing half copied.
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
  if (namespace === undefined) return;
  for (const item of found) {
    refuseRedirect(root, join(root, "artifacts", namespace, kind, item.name, "0.1.0"));
    if (existsSync(join(root, "artifacts", namespace, kind, item.name))) {
      throw new AiregError(`${namespace}/${kind}/${item.name} already exists.`, {
        code: ErrorCode.Conflict,
        hint: `Start its next version with \`aireg ${kind} bump ${item.name}\`.`,
      });
    }
  }

  const copied: { name: string; at: string }[] = [];
  for (const item of found) {
    const at = join(root, "artifacts", namespace, kind, item.name, "0.1.0");
    await mkdir(at, { recursive: true });
    for (const path of item.entries) {
      await cp(join(item.dir, path), join(at, path), FRESH);
    }
    await rm(join(at, ENVELOPE), { force: true });
    // `--name` renames the copy, and index checks the folder against its front matter.
    if (item.front !== undefined && item.front.name !== item.name) {
      const file = join(at, item.front.file);
      await writeFile(file, withName(await readFile(file, "utf8"), item.name), "utf8");
    }
    copied.push({ name: item.name, at });
  }

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        kind,
        namespace,
        created: copied.map((item) => ({ name: item.name, at: relative(root, item.at) })),
      },
    });
    return;
  }
  for (const item of copied) {
    context.printer.success(`Copied ${item.name} into ${relative(context.cwd, item.at) || "."}/.`);
  }
  context.printer.note("next", "aireg registry index");
}

async function version(
  kind: string,
  context: CommandContext,
  input: string | undefined,
  how: string | undefined,
  own: Own,
): Promise<void> {
  if (input === undefined) {
    throw new AiregError(`\`aireg ${kind} bump\` needs a name.`, {
      code: ErrorCode.Usage,
      hint: `Name the ${kind}: \`aireg ${kind} bump <name> [patch | minor | major | <version>]\`.`,
    });
  }
  const root = requireRegistry(context.cwd);
  const namespace = own.namespace === undefined ? undefined : valid(own.namespace);
  const home = await locate(root, context.cwd, kind, nameOf(input, input), namespace);
  // Folder names as written: `1.0.0+build` is copied from that folder, not `1.0.0`.
  const versions = (await readdir(home, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && isVersion(item.name))
    .flatMap((item) => {
      const parsed = parseVersion(item.name);
      return parsed === undefined ? [] : [{ name: item.name, parsed }];
    })
    .sort((left, right) => compareVersion(left.parsed, right.parsed));
  const latest = versions.at(-1)?.name;
  if (latest === undefined)
    throw new AiregError(`${input} has no version to start from.`, {
      code: ErrorCode.Invalid,
      hint: `Start one with \`aireg ${kind} new ${input}\`.`,
    });

  const bump = how ?? "patch";
  // `v1.2.0` names a tag; the folder is the bare version, as the file spec names it.
  const next =
    bump === "patch" || bump === "minor" || bump === "major"
      ? bumpVersion(latest, bump)
      : bump.replace(/^v(?=\d)/, "");
  const parsed = parseVersion(next);
  if (!isVersion(next) || parsed === undefined) {
    throw new AiregError(`${quoted(bump)} is not patch, minor, major or a version.`, {
      code: ErrorCode.Usage,
      hint: "Use patch, minor, major or a version such as 1.4.0.",
    });
  }
  if (versions.some((item) => compareVersion(item.parsed, parsed) === 0)) {
    throw new AiregError(`${input} ${next} already exists.`, {
      code: ErrorCode.Conflict,
      hint: "Edit it there, or name a newer version.",
    });
  }
  // Any entry at all where the version goes, such as a link a folder listing skips, is refused.
  refuseRedirect(root, join(home, next));
  if (await present(join(home, next))) {
    throw new AiregError(`${input} ${next} already exists.`, {
      code: ErrorCode.Conflict,
      hint: `Move ${relative(context.cwd, join(home, next)) || "."} aside, or name a newer version.`,
    });
  }
  await cp(join(home, latest), join(home, next), FRESH);
  await rm(join(home, next, ENVELOPE), { force: true });
  const kept = await keepFromEnvelope(join(home, latest), join(home, next));

  const from = relative(context.cwd, join(home, latest)) || ".";
  const to = relative(context.cwd, join(home, next)) || ".";
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { kind, name: input, from: latest, to: next } });
    return;
  }
  context.printer.success(`Copied ${from} to ${to}.`);
  if (kept.relationships > 0) {
    context.printer.note(
      "kept",
      `${plural(kept.relationships, "relationship")} from ${latest}, in ${ENVELOPE}`,
    );
  }
  if (kept.blobs > 0) {
    context.printer.note(
      "kept",
      `${plural(kept.blobs, "blob-backed file")} from ${latest}, in ${ENVELOPE}`,
    );
  }
  context.printer.note("edit", to);
  context.printer.note("next", "aireg registry index");
}

/**
 * The new version starts with the edges the last one declared and the files it keeps in
 * the blob store, since only the envelope holds them and the indexer keeps what it says.
 */
async function keepFromEnvelope(
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

/** The one `<namespace>/<kind>/<name>` folder a bare name means here. */
async function locate(
  root: string,
  cwd: string,
  kind: string,
  name: string,
  namespace: string | undefined,
): Promise<string> {
  const wanted = namespace ?? namespaceHere(root, cwd);
  const candidates = (
    await readdir(join(root, "artifacts"), { withFileTypes: true }).catch(() => [])
  )
    .filter((item) => item.isDirectory() && (wanted === undefined || item.name === wanted))
    .map((item) => join(root, "artifacts", item.name, kind, name))
    .filter((path) => existsSync(path));
  if (candidates.length === 1) return candidates[0] as string;
  if (candidates.length === 0) {
    // `new` infers only the namespace you are in, so any other has to be named.
    const flag =
      namespace !== undefined
        ? ` --namespace ${namespace}`
        : wanted === undefined
          ? " --namespace <namespace>"
          : "";
    throw new AiregError(
      `No ${kind} named ${quoted(name)}${wanted === undefined ? "" : ` in ${wanted}`}.`,
      {
        code: ErrorCode.NotFound,
        hint: `Create it with \`aireg ${kind} new ${name}${flag}\`.`,
      },
    );
  }
  throw new AiregError(`${name} is in more than one namespace.`, {
    code: ErrorCode.Usage,
    hint: "Pass `--namespace <namespace>`, or run it inside artifacts/<namespace>.",
  });
}
