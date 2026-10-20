import { copyFile, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertUnredirected, readRegular } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { exists } from "#core/fs/tree.ts";
import { resolveHarnesses } from "#core/harness/index.ts";
import { expandValue } from "#core/harness/template.ts";
import type { PluginDocument } from "./model.ts";

/** Folders a harness reads under another name; one folder serves every harness, as it ignores the rest. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  commands: ["prompts"],
};

/** Where harnesses read a plugin's manifest: written into the projection, never linked from content. */
const MANIFESTS = new Set([".claude-plugin", ".codex-plugin", "plugin.json"]);

/** The manifest Claude Code reads, which a plugin's own document fills when it has none of its own. */
const CLAUDE_MANIFEST = ".claude-plugin/plugin.json";

/**
 * Relative, so moving the artifacts tree does not strand a projection. On Windows a junction:
 * a symlink needs Developer Mode, and a relative one inside a junction resolves the wrong way.
 * A junction reaches only a folder, so there a file, such as `.mcp.json`, is copied.
 */
async function pointAt(from: string, to: string): Promise<void> {
  await rm(from, { recursive: true, force: true });
  if (process.platform !== "win32") await symlink(relative(join(from, ".."), to), from);
  else if ((await stat(to)).isDirectory()) await symlink(resolve(to), from, "junction");
  else await copyFile(to, from);
}

/** What every harness's plugin manifest says, before any keys of its own. */
const DOCUMENT = { name: "{name}", description: "{description}" };

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

/**
 * A plugin's own manifest is copied, and Claude Code's is written from its document when it has
 * none. Any other is named after the projection, and only ever created.
 */
async function writePluginManifest(
  dir: string,
  content: string,
  harnesses: Iterable<string>,
  document: PluginDocument | undefined,
): Promise<void> {
  const table = resolveHarnesses();
  const name = basename(dir);
  const description = document?.description ?? `Artifacts the ${name} namespace publishes.`;
  for (const harness of harnesses) {
    for (const manifest of table[harness]?.kinds.plugin?.manifest ?? []) {
      const file = join(dir, manifest.path);
      await assertUnredirected(dir, file);
      const own = await readRegular(content, manifest.path);
      if (own.kind === "file") {
        await writeAtomic(file, own.bytes);
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
 * Every entry of the content is linked in, and every link is recreated rather than patched:
 * what stopped existing upstream has to stop being projected, and comparing costs more.
 */
export async function assemble(
  projection: string,
  content: string,
  harnesses: Iterable<string>,
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
  await writePluginManifest(projection, content, harnesses, document);
}
