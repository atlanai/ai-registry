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
import { backupStamp } from "#core/store/backups.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import type { Roots } from "#core/store/paths.ts";
import { applyCodec, type Rendered } from "#core/target/codecs/index.ts";
import type { KeyFile } from "#core/target/contract.ts";
import { assemble } from "./assemble.ts";
import { commandSkill } from "./command-skill.ts";
import { keyNeeds, writeKeyFiles } from "./keys.ts";
import { backUp, guardLink, type LinkGuard } from "./link-guard.ts";
import { type ActionOf, linkKey, type Run } from "./run.ts";

/** Refuses the entire plan before journaling or starting any fetch. */
export async function preflight(plan: Plan, roots: Roots): Promise<Map<string, LinkGuard>> {
  await guardManagedPath(roots.lock, roots);
  // Each folder is checked once here; every write checks its own path again as it happens.
  const checked = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind !== "record")
      await guardManagedPath(action.to, roots, action.kind !== "unlink", process.env, checked);
    if (action.kind === "link")
      await guardManagedPath(action.from, roots, true, process.env, checked);
  }
  return guardsOf(plan, roots);
}

/**
 * Decided before the journal, so recovery never counts a person's folder as ours to remove.
 * Read-only, so a dry run shows the same verdicts.
 */
export async function guardsOf(plan: Plan, roots: Roots): Promise<Map<string, LinkGuard>> {
  const guards = new Map<string, LinkGuard>();
  for (const action of plan.actions) {
    if (action.kind === "record" || guards.has(action.to)) continue;
    if (action.kind === "link") {
      const rendered = await rendering(action);
      const text =
        rendered !== undefined && "text" in rendered
          ? { file: writtenFile(action), text: rendered.text }
          : undefined;
      guards.set(action.to, await guardLink(action.to, action.recorded, roots, text));
    } else if (action.kind === "unlink" && action.link !== undefined) {
      guards.set(action.to, await guardLink(action.to, action.link.mode, roots));
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
export async function assemblePlugin(run: Run, action: ActionOf<"link">): Promise<void> {
  if (action.plugin !== true || action.content === undefined) return;
  if (!(await exists(action.content))) return;
  const found = run.plugins.get(action.from) ?? {
    content: action.content,
    targets: new Set<string>(),
    document: action.document,
  };
  found.targets.add(action.target);
  run.plugins.set(action.from, found);
  await guardManagedPath(action.from, run.roots);
  await assemble(action.from, action.content, found.targets, found.document);
}

export async function linkInto(run: Run, action: ActionOf<"link">): Promise<void> {
  const { roots } = run;
  const key = linkKey(action.name, action.to);
  let guard = run.guards.get(action.to) ?? "replace";
  // Its source may have been copied in by this run, after the guard was taken.
  const rendered = await rendering(action);
  if (guard === "keep" && rendered !== undefined && "text" in rendered) {
    guard = await guardLink(action.to, action.recorded, roots, {
      file: writtenFile(action),
      text: rendered.text,
    });
  }
  if (guard === "keep") {
    if (action.adopt === true) {
      await adoptOrKeep(run, action, key);
      return;
    }
    run.kept.push({ name: action.name, path: action.to });
    run.skipped.add(key);
    return;
  }
  // Assembled here, before the link that will read it.
  await assemblePlugin(run, action);
  // The source is inside our own tree, so a missing one was never staged.
  if (!(await exists(action.from))) {
    run.skipped.add(key);
    return;
  }
  const files = await keyFiles(run, action, rendered, key);
  if (files === undefined) return;
  // A committed symlink can appear on the way after planning; the write would follow it.
  const verdict = removal(action.to, roots);
  if (roots.scope === "project" && verdict.how === "refuse") {
    run.kept.push({ name: action.name, path: action.to, reason: verdict.reason });
    run.skipped.add(key);
    return;
  }
  // Whatever is there is about to go, so it is checked again now.
  await assertRemovable(action.to, roots);
  if (guard === "backup") {
    await moveAside(run, action.to, action.target);
    run.guards.set(action.to, "replace");
  }
  // A target that will not load a linked plugin gets a real directory of links instead.
  const fan = action.fan === true && !action.copy;
  // A file a key adds goes into a copy, never into the store a link would lead to.
  const copy = action.copy || files.length > 0;
  const mode = await place(run, action, rendered, { fan, copy, files });
  if (mode === undefined) {
    run.skipped.add(key);
    return;
  }
  if (action.rename !== undefined && !writes(action) && mode === "copy") {
    await renameCopy(action.to, action.rename);
  }
  if (fan) run.fanned.set(action.to, action.from);
  if (action.plugin === true && mode === "copy") run.copiedPlugins.set(action.to, action);
  run.modes.set(key, mode);
  run.pathModes.set(action.to, mode);
  if (mode === "copy") run.copies.set(action.to, await digest(action.to));
  if (!copy && mode === "copy") run.degraded.add(action.target);
  run.performed.link += 1;
  run.installed.add(action.name);
}

/**
 * A copy another tool left where this link goes is taken over as aireg's own when it holds exactly
 * what this run installs, and is never rewritten; one that differs reads as edited and stays.
 */
async function adoptOrKeep(run: Run, action: ActionOf<"link">, key: string): Promise<void> {
  const state = await inspect(action.to);
  const same =
    state.exists &&
    !state.isLink &&
    (await exists(action.from)) &&
    (await digest(action.to)) === (await digest(action.from));
  if (!same) {
    run.kept.push({
      name: action.name,
      path: action.to,
      reason:
        "it holds other bytes than aireg installs, so it reads as edited and was left as it is",
    });
    run.skipped.add(key);
    return;
  }
  run.modes.set(key, "copy");
  run.pathModes.set(action.to, "copy");
  run.copies.set(action.to, await digest(action.to));
  run.adopted.push({ name: action.name, path: action.to });
  run.performed.link += 1;
  run.installed.add(action.name);
}

/** The files its keys add; undefined once it is left out for a target that cannot keep one. */
async function keyFiles(
  run: Run,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  key: string,
): Promise<KeyFile[] | undefined> {
  const needs = await keyNeeds(
    action,
    rendered !== undefined && "text" in rendered ? rendered.text : undefined,
  );
  if ("files" in needs) return needs.files;
  run.unrendered.push({
    name: action.command ?? action.name,
    target: action.target,
    reason: needs.refused,
  });
  run.skipped.add(key);
  return undefined;
}

/** A person's own file or folder where the lockfile recorded a link goes to backups, never away. */
async function moveAside(run: Run, path: string, target: string): Promise<void> {
  const { roots } = run;
  const info = await lstat(path);
  run.stamp ??= backupStamp();
  await guardManagedPath(roots.artifacts, roots);
  run.backedUp.push({
    path,
    to: await backUp(path, target, roots, run.stamp),
    what: info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : "file",
  });
}

async function place(
  run: Run,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
  how: { fan: boolean; copy: boolean; files: readonly KeyFile[] },
): Promise<LinkMode | undefined> {
  const mode = writes(action)
    ? await writeRendered(run, action, rendered)
    : how.fan
      ? await fanOut(action.from, action.to)
      : await link(action.from, action.to, how.copy);
  if (mode === "copy") await writeKeyFiles(action.to, how.files);
  return mode;
}

/** Never linked: a target reading its own format may refuse a link. */
async function writeRendered(
  run: Run,
  action: ActionOf<"link">,
  rendered: Rendered | undefined,
): Promise<LinkMode | undefined> {
  if (rendered === undefined || "problem" in rendered) {
    const reason = rendered?.problem ?? "its file could not be read";
    run.unrendered.push({ name: action.name, target: action.target, reason });
    return undefined;
  }
  await remove(action.to);
  await mkdir(dirname(writtenFile(action)), { recursive: true });
  await writeAtomic(writtenFile(action), rendered.text);
  return "copy";
}

/** A copy under a name not its own says that name, so the target shows it as installed. */
async function renameCopy(to: string, name: string): Promise<void> {
  const file = (await lstat(to)).isDirectory() ? join(to, SKILL_ENTRY) : to;
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text !== undefined) await writeAtomic(file, withName(text, name));
}

export async function unlink(run: Run, action: ActionOf<"unlink">): Promise<void> {
  if (run.guards.get(action.to) === "backup" && action.link !== undefined) {
    await assertRemovable(action.to, run.roots);
    await moveAside(run, action.to, action.link.target);
  } else {
    await removeContained(action.to, run.roots);
  }
  // The kind subdir is ours to tidy; the namespace above it is not, outside the store.
  await pruneEmptyParent(action.to, run.roots.artifacts);
  run.performed.unlink += 1;
}
