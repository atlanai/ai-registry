import type { Stats } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { withName } from "#core/frontmatter.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { digest } from "#core/fs/digest.ts";
import { fanOut, inspect, link } from "#core/fs/link.ts";
import { exists, pruneEmptyParent, remove } from "#core/fs/tree.ts";
import type { LinkMode } from "#core/lock.ts";
import type { Plan } from "#core/plan/model.ts";
import { assertRemovable, removal, removeContained } from "#core/plan/removable.ts";
import { assertManagedPath } from "#core/store/managed-paths.ts";
import type { Roots } from "#core/store/paths.ts";
import { applyCodec, type Rendered } from "#core/target/codecs/index.ts";
import type { KeyFile } from "#core/target/contract.ts";
import { assemble } from "./assemble.ts";
import { commandSkill } from "./command-skill.ts";
import { keyNeeds, writeKeyFiles } from "./keys.ts";
import { backUp, type GuardScope, guardLink, type LinkGuard } from "./link-guard.ts";
import type {
  ActionOf,
  BackedUp,
  Linked,
  PluginSource,
  Run,
  RunInputs,
  Unrendered,
} from "./run.ts";

/** Refuses the entire plan before journaling or starting any fetch. */
export async function preflight(
  plan: Plan,
  roots: Roots,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, LinkGuard>> {
  await assertManagedPath(roots.lock, roots, { env });
  // Each folder is checked once here; every write checks its own path again as it happens.
  const checked = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind !== "record")
      await assertManagedPath(action.to, roots, {
        leaf: action.kind !== "unlink",
        verified: checked,
        env,
      });
    if (action.kind === "link")
      await assertManagedPath(action.from, roots, { verified: checked, env });
  }
  return guardsOf(plan, { roots, env });
}

/** Taken before the journal so recovery never removes a person's folder; read-only for dry runs. */
export async function guardsOf(plan: Plan, scope: GuardScope): Promise<Map<string, LinkGuard>> {
  const guards = new Map<string, LinkGuard>();
  for (const action of plan.actions) {
    if (action.kind === "record" || guards.has(action.to)) continue;
    if (action.kind === "link") {
      const rendered = await rendering(action);
      const text =
        rendered !== undefined && "text" in rendered
          ? { file: writtenFile(action), text: rendered.text }
          : undefined;
      guards.set(action.to, await guardLink(action.to, action.recorded, scope, text));
    } else if (action.kind === "unlink" && action.link !== undefined) {
      guards.set(action.to, await guardLink(action.to, action.link.mode, scope));
    }
  }
  return guards;
}

/** A written placement's text; undefined for a link, or before its source is copied. */
async function rendering(action: ActionOf<"link">): Promise<Rendered | undefined> {
  if (!writes(action)) return undefined;
  const read = await readFile(action.from, "utf8").catch(() => undefined);
  if (read === undefined) return undefined;
  const source = action.rename === undefined ? read : withName(read, action.rename);
  if (action.command !== undefined) return commandSkill(action.command, source);
  if (action.codec === undefined) return { text: source };
  return applyCodec(action.codec, source);
}

/** Whether aireg writes this placement's file itself, rather than linking or copying a tree. */
function writes(action: ActionOf<"link">): boolean {
  return action.codec !== undefined || action.entry !== undefined;
}

/** Where a written placement's file sits: inside its folder, for an `entry`. */
function writtenFile(action: ActionOf<"link">): string {
  return action.entry === undefined ? action.to : join(action.to, action.entry);
}

/** Pointing a target at a whole namespace is what makes that directory a plugin. */
export async function assemblePlugin(
  { roots, env }: Pick<RunInputs, "roots" | "env">,
  action: ActionOf<"link">,
  found: PluginSource | undefined,
): Promise<PluginSource | undefined> {
  if (action.plugin !== true || action.content === undefined) return undefined;
  if (!(await exists(action.content))) return undefined;
  const plugin: PluginSource = {
    content: found?.content ?? action.content,
    targets: new Set([...(found?.targets ?? []), action.target]),
    document: found === undefined ? action.document : found.document,
  };
  await assertManagedPath(action.from, roots, { env });
  await assemble(action.from, action.content, plugin.targets, plugin.document);
  return plugin;
}

export async function linkInto(run: Run, action: ActionOf<"link">): Promise<Linked> {
  const rendered = await rendering(action);
  const guard = await settledGuard(run, action, rendered);
  if (guard === "keep") {
    if (action.adopt === true) return adoptOrKeep(action);
    return { kept: { name: action.name, path: action.to } };
  }
  // Assembled here, before the link that will read it.
  const plugin = await assemblePlugin(run.inputs, action, run.results.plugins.get(action.from));
  const linked = await placeLink(run.inputs, action, rendered, guard);
  return plugin === undefined ? linked : { ...linked, plugin };
}

/** Its source may have been copied in by this run, after the guard was taken. */
async function settledGuard(
  run: Run,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
): Promise<LinkGuard> {
  const guard = run.results.guards.get(action.to) ?? "replace";
  if (guard !== "keep" || rendered === undefined || !("text" in rendered)) return guard;
  return guardLink(action.to, action.recorded, run.inputs, {
    file: writtenFile(action),
    text: rendered.text,
  });
}

/** A matching copy another tool left is taken over as aireg's; one that differs stays as edited. */
async function adoptOrKeep(action: ActionOf<"link">): Promise<Linked> {
  const state = await inspect(action.to);
  const same =
    state.exists &&
    !state.isLink &&
    (await exists(action.from)) &&
    (await digest(action.to)) === (await digest(action.from));
  if (!same) {
    return {
      kept: {
        name: action.name,
        path: action.to,
        reason:
          "it holds other bytes than aireg installs, so it reads as edited and was left as it is",
      },
    };
  }
  return {
    made: { mode: "copy", digest: await digest(action.to) },
    adopted: { name: action.name, path: action.to },
  };
}

async function placeLink(
  inputs: RunInputs,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  guard: Exclude<LinkGuard, "keep">,
): Promise<Linked> {
  const { roots, env } = inputs;
  // The source is inside our own tree, so a missing one was never staged.
  if (!(await exists(action.from))) return {};
  const needs = await keyFiles(action, rendered);
  if ("unrendered" in needs) return needs;
  // A committed symlink can appear on the way after planning; the write would follow it.
  const verdict = removal(action.to, roots, env);
  if (roots.scope === "project" && verdict.how === "refuse") {
    return { kept: { name: action.name, path: action.to, reason: verdict.reason } };
  }
  // Whatever is there is about to go, so it is checked again now.
  await assertRemovable(action.to, roots, env);
  const backedUp =
    guard === "backup" ? await moveAside(inputs, action.to, action.target) : undefined;
  const made = await makeLink(action, rendered, needs.files);
  return backedUp === undefined ? made : { ...made, backedUp };
}

async function keyFiles(
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
): Promise<{ files: KeyFile[] } | Required<Pick<Linked, "unrendered">>> {
  const needs = await keyNeeds(
    action,
    rendered !== undefined && "text" in rendered ? rendered.text : undefined,
  );
  if ("files" in needs) return needs;
  return {
    unrendered: {
      name: action.command ?? action.name,
      target: action.target,
      reason: needs.refused,
    },
  };
}

/** A person's own file at a recorded link goes to backups, never away. */
async function moveAside(inputs: RunInputs, path: string, target: string): Promise<BackedUp> {
  const { roots, env } = inputs;
  const info = await lstat(path);
  const stamp = inputs.stamp();
  await assertManagedPath(roots.artifacts, roots, { env });
  return { path, to: await backUp(path, target, inputs, stamp), what: whatIs(info) };
}

function whatIs(info: Stats): BackedUp["what"] {
  if (info.isSymbolicLink()) return "link";
  return info.isDirectory() ? "folder" : "file";
}

async function makeLink(
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  files: readonly KeyFile[],
): Promise<Linked> {
  // A target that will not load a linked plugin gets a real directory of links instead.
  const fan = action.fan === true && !action.copy;
  // A file a key adds goes into a copy, never into the store a link would lead to.
  const copy = action.copy || files.length > 0;
  const mode = await place(action, rendered, { fan, copy, files });
  if (typeof mode !== "string") return { unrendered: mode };
  if (action.rename !== undefined && !writes(action) && mode === "copy") {
    await renameCopy(action.to, action.rename);
  }
  const copied = mode === "copy";
  return {
    made: {
      mode,
      ...(copied ? { digest: await digest(action.to) } : {}),
      ...(fan ? { fanned: true } : {}),
      ...(action.plugin === true && copied ? { copiedPlugin: true } : {}),
      ...(!copy && copied ? { degraded: true } : {}),
    },
  };
}

async function place(
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  how: { fan: boolean; copy: boolean; files: readonly KeyFile[] },
): Promise<LinkMode | Unrendered> {
  const mode = await placed(action, rendered, how);
  if (mode === "copy") await writeKeyFiles(action.to, how.files);
  return mode;
}

function placed(
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  how: { fan: boolean; copy: boolean },
): Promise<LinkMode | Unrendered> {
  if (writes(action)) return writeRendered(action, rendered);
  if (how.fan) return fanOut(action.from, action.to);
  return link(action.from, action.to, how.copy);
}

/** Never linked: a target reading its own format may refuse a link. */
async function writeRendered(
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
): Promise<LinkMode | Unrendered> {
  if (rendered === undefined || "problem" in rendered) {
    const reason = rendered?.problem ?? "its file could not be read";
    return { name: action.name, target: action.target, reason };
  }
  await remove(action.to);
  await mkdir(dirname(writtenFile(action)), { recursive: true });
  await writeAtomic(writtenFile(action), rendered.text);
  return "copy";
}

/**
 * A copy under a name not its own says that name, so the target shows it as installed.
 * Read, not stat-then-read: a skill folder's entry fails as ENOTDIR on a single-file copy.
 */
async function renameCopy(to: string, name: string): Promise<void> {
  for (const file of [join(to, SKILL_ENTRY), to]) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text !== undefined) return writeAtomic(file, withName(text, name));
  }
}

export async function unlink(run: Run, action: ActionOf<"unlink">): Promise<BackedUp | undefined> {
  const { inputs } = run;
  let backedUp: BackedUp | undefined;
  if (run.results.guards.get(action.to) === "backup" && action.link !== undefined) {
    await assertRemovable(action.to, inputs.roots, inputs.env);
    backedUp = await moveAside(inputs, action.to, action.link.target);
  } else {
    await removeContained(action.to, inputs.roots, inputs.env);
  }
  // The kind subdir is ours to tidy; the namespace above it is not, outside the store.
  await pruneEmptyParent(action.to, inputs.roots.artifacts);
  return backedUp;
}
