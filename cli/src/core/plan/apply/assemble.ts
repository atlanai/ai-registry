import { copyFile, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertUnredirected, readRegular } from "#adapter/files.ts";
import { isRecord } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { exists } from "#core/fs/tree.ts";
import type { PluginDocument } from "#core/plan/model.ts";
import { resolveTargets } from "#core/target/table.ts";
import { expandValue } from "#core/target/template.ts";

/** Folders a target reads under another name; one folder serves every target, as it ignores the rest. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  commands: ["prompts"],
};

/** Where targets read a plugin's manifest: written into the projection, never linked from content. */
const MANIFESTS = new Set([".claude-plugin", ".codex-plugin", "plugin.json"]);

/** The manifest Claude Code reads, which a plugin's own document fills when it has none of its own. */
const CLAUDE_MANIFEST = ".claude-plugin/plugin.json";

/**
 * Every entry of the content is linked in, and every link is recreated rather than patched:
 * what stopped existing upstream has to stop being projected, and comparing costs more.
 */
export async function assemble(
  projection: string,
  content: string,
  targets: Iterable<string>,
  document?: PluginDocument,
): Promise<void> {
  await mkdir(projection, { recursive: true });
  const own = (await names(content)).filter((entry) => !MANIFESTS.has(entry));
  const linked = new Set(own.flatMap((entry) => [entry, ...(ALIASES[entry] ?? [])]));
  for (const entry of await names(projection)) {
    if (!MANIFESTS.has(entry) && !linked.has(entry)) {
      await rm(join(projection, entry), { recursive: true, force: true });
    }
  }
  for (const entry of own) {
    for (const at of [entry, ...(ALIASES[entry] ?? [])]) {
      await pointAt(join(projection, at), join(content, entry));
    }
  }
  await writePluginManifest(projection, content, targets, document);
}

/** What every target's plugin manifest says, before any keys of its own. */
const DOCUMENT = { name: "{name}", description: "{description}" };

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

/**
 * Relative, so moving the artifacts tree does not strand a projection. Windows gets an absolute
 * junction, as a symlink needs Developer Mode, and a file is copied, as a junction cannot reach it.
 */
async function pointAt(from: string, to: string): Promise<void> {
  await rm(from, { recursive: true, force: true });
  if (process.platform !== "win32") await symlink(relative(join(from, ".."), to), from);
  else if ((await stat(to)).isDirectory()) await symlink(resolve(to), from, "junction");
  else await copyFile(to, from);
}

/**
 * Copies a plugin's own manifest (Claude Code's under the projection's name), writes Claude Code's
 * from the document when it has none, and only ever creates the rest.
 */
async function writePluginManifest(
  dir: string,
  content: string,
  targets: Iterable<string>,
  document: PluginDocument | undefined,
): Promise<void> {
  const table = resolveTargets();
  const name = basename(dir);
  const description = document?.description ?? `Artifacts the ${name} namespace publishes.`;
  for (const target of targets) {
    for (const manifest of table[target]?.kinds.plugin?.manifest ?? []) {
      const file = join(dir, manifest.path);
      await assertUnredirected(dir, file);
      const own = await readRegular(content, manifest.path);
      if (own.kind === "file") {
        await writeAtomic(
          file,
          manifest.path === CLAUDE_MANIFEST ? named(own.bytes, name) : own.bytes,
        );
        continue;
      }
      if (manifest.path === CLAUDE_MANIFEST && document?.manifest !== undefined) {
        await writeAtomic(file, `${JSON.stringify({ ...document.manifest, name }, null, 2)}\n`);
        continue;
      }
      if (await exists(file)) continue;
      const body = manifest.body ?? {};
      // `$schema` leads, where a reader of the document looks for it.
      const schema = body.$schema === undefined ? {} : { $schema: body.$schema };
      const value = expandValue({ ...schema, ...DOCUMENT, ...body }, { name, description });
      await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  }
}

/**
 * Claude Code keys plugins by the name in their manifest, so a copied one takes the projection's,
 * which no other registry's plugin holds. One that is not a JSON object is copied as it is.
 */
function named(bytes: Buffer, name: string): Buffer | string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return bytes;
  }
  return isRecord(manifest) ? `${JSON.stringify({ ...manifest, name }, null, 2)}\n` : bytes;
}
