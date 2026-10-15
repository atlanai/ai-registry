import { mkdir, rm, symlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { assertUnredirected } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { exists } from "#core/fs/tree.ts";
import { resolveHarnesses } from "#core/harness/index.ts";
import { expandValue } from "#core/harness/template.ts";
import { KINDS, kindDir } from "#core/kinds.ts";

/**
 * Kind directories a harness reads under another name. One directory serves every harness,
 * since a harness ignores kind directories it does not declare.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  commands: ["prompts"],
};

/**
 * Relative, so moving the artifacts tree does not strand a projection. On Windows a junction:
 * a symlink needs Developer Mode, and a relative one inside a junction resolves the wrong way.
 */
async function pointAt(from: string, to: string): Promise<void> {
  await rm(from, { recursive: true, force: true });
  if (process.platform === "win32") await symlink(resolve(to), from, "junction");
  else await symlink(relative(join(from, ".."), to), from);
}

/** What every harness's plugin manifest says, before any keys of its own. */
const DOCUMENT = { name: "{name}", description: "{description}" };

/**
 * Named after the projection, which differs from the content's name when two registries share a
 * namespace. Only ever creates: a published plugin's own manifest says more than this one would.
 */
async function writePluginManifest(dir: string, harnesses: Iterable<string>): Promise<void> {
  const table = resolveHarnesses();
  const name = basename(dir);
  const vars = { name, description: `Artifacts the ${name} namespace publishes.` };
  for (const harness of harnesses) {
    for (const manifest of table[harness]?.kinds.plugin?.manifest ?? []) {
      const file = join(dir, manifest.path);
      await assertUnredirected(dir, file);
      if (await exists(file)) continue;
      const own = manifest.body ?? {};
      // `$schema` leads, where a reader of the document looks for it.
      const schema = own.$schema === undefined ? {} : { $schema: own.$schema };
      const body = expandValue({ ...schema, ...DOCUMENT, ...own }, vars);
      await writeAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
    }
  }
}

/**
 * Every link is recreated rather than patched: a kind directory that stopped
 * existing upstream has to stop being projected, and comparing costs more.
 */
export async function assemble(
  projection: string,
  content: string,
  harnesses: Iterable<string>,
): Promise<void> {
  await mkdir(projection, { recursive: true });
  for (const kind of KINDS) {
    if (kind === "plugin") continue;
    const dir = kindDir(kind);
    const target = join(content, dir);
    const names = [dir, ...(ALIASES[dir] ?? [])];
    for (const name of names) {
      const at = join(projection, name);
      if (await exists(target)) await pointAt(at, target);
      else await rm(at, { recursive: true, force: true });
    }
  }
  await writePluginManifest(projection, harnesses);
}
