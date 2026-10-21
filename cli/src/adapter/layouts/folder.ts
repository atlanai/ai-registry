import { posix } from "node:path";
import type { Artifact } from "../contract.ts";
import { isArtifactName, isNamespace } from "../filespec/names.ts";
import { quoted } from "../text.ts";
import { type ContentFile, contentArtifact } from "./envelope.ts";
import { type Frontmatter, readFrontmatter, textField } from "./frontmatter.ts";
import type { Found, Layout, LayoutContext } from "./layout.ts";
import { type Skip, type Tree, walksInto } from "./tree.ts";

/** The file that makes a folder a skill. */
export const SKILL_FILE = "SKILL.md";

/** The id of a source that is one skill, since an id is never empty. */
export const ROOT_ID = ".";

/** The file an agent travels as, as the file spec names it. */
const AGENT_FILE = "AGENT.md";

/** How far below the root a skill's folder may sit: `skills/<group>/<name>` is three. */
const SKILL_DEPTH = 3;

/** Folders whose `*.md` files are agents, each one file. */
const AGENT_FOLDERS = ["agents", ".claude/agents"];

/** Folders that hold only skills, where a link left out is worth saying. */
const SKILL_FOLDERS = ["skills", ".claude/skills", ".agents/skills"];

const holdsSkills = (dir: string) =>
  SKILL_FOLDERS.some((folder) => dir === folder || dir.startsWith(`${folder}/`));

export interface Candidate {
  kind: "skill" | "agent";
  /** The skill's folder, or the agent's file. */
  at: string;
  name: string;
  namespace: string;
}

export function skipped(skip: Skip): string {
  return `Skipped ${skip.path}, which ${skip.reason}.`;
}

/** Skill folders up to `SKILL_DEPTH` below the root, never looking inside one it found. */
async function skillFolders(tree: Tree, warnings: string[]): Promise<string[]> {
  if (await tree.isFile(SKILL_FILE)) return [""];
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await tree.list(dir)) {
      if (entry.type === "link" && holdsSkills(dir)) {
        warnings.push(skipped({ path: entry.path, reason: "is a symlink" }));
      }
      if (entry.type !== "folder" || !walksInto(entry.name)) continue;
      if (await tree.isFile(`${entry.path}/${SKILL_FILE}`)) found.push(entry.path);
      else if (depth < SKILL_DEPTH) await visit(entry.path, depth + 1);
    }
  };
  await visit("", 1);
  return found;
}

async function agentFiles(tree: Tree, warnings: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of AGENT_FOLDERS) {
    for (const entry of await tree.list(dir)) {
      if (!entry.name.endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
      if (entry.type === "link")
        warnings.push(skipped({ path: entry.path, reason: "is a symlink" }));
      if (entry.type === "file") found.push(entry.path);
    }
  }
  return found;
}

/** `skills/<group>/<name>` files a skill under `<group>`; anything else under the registry's name. */
function namespaceOf(folder: string, context: LayoutContext): string {
  const parts = folder.split("/");
  const group = parts.length === 3 && parts[0] === "skills" ? parts[1] : undefined;
  return group !== undefined && isNamespace(group) ? group : context.namespace;
}

async function candidates(tree: Tree, context: LayoutContext, warnings: string[]) {
  const found: Candidate[] = [];
  const folders = await skillFolders(tree, warnings);
  // A SKILL.md at the root makes the whole source one skill, agents folder and all.
  if (folders[0] === "") {
    return [
      { kind: "skill", at: ROOT_ID, name: context.rootName, namespace: context.namespace },
    ] as const;
  }
  for (const folder of folders) {
    const name = posix.basename(folder);
    found.push({ kind: "skill", at: folder, name, namespace: namespaceOf(folder, context) });
  }
  for (const file of await agentFiles(tree, warnings)) {
    const name = posix.basename(file, ".md");
    found.push({ kind: "agent", at: file, name, namespace: context.namespace });
  }
  return found;
}

const shown = (candidate: Candidate) => candidate.at;

/** Duplicates of one namespace, kind and name keep the first in path order, loudly. */
function deduplicated(found: readonly Candidate[], warnings: string[]): Candidate[] {
  const kept = new Map<string, Candidate>();
  for (const candidate of [...found].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (!isArtifactName(candidate.name)) {
      warnings.push(
        `Skipped ${shown(candidate)}: ${quoted(candidate.name)} is not a name aireg installs, which takes lowercase letters, digits and hyphens.`,
      );
      continue;
    }
    const key = `${candidate.namespace}/${candidate.kind}/${candidate.name}`;
    const first = kept.get(key);
    if (first !== undefined) {
      warnings.push(
        `Skipped ${shown(candidate)}: ${shown(first)} is also ${candidate.kind === "skill" ? "a skill" : "an agent"} named ${quoted(candidate.name)}.`,
      );
      continue;
    }
    kept.set(key, candidate);
  }
  return [...kept.values()];
}

function entryOf(candidate: Candidate): string {
  if (candidate.kind === "agent") return candidate.at;
  return candidate.at === ROOT_ID ? SKILL_FILE : `${candidate.at}/${SKILL_FILE}`;
}

async function frontOf(tree: Tree, path: string): Promise<Frontmatter | undefined> {
  const bytes = await tree.read(path);
  return bytes === undefined ? undefined : readFrontmatter(new TextDecoder().decode(bytes));
}

/** Front matter names the artifact as well; the folder wins, since the folder is what is installed. */
function checkName(candidate: Candidate, front: Frontmatter | undefined, warnings: string[]): void {
  const named = textField(front, "name");
  if (named === undefined || named === candidate.name) return;
  const entry = entryOf(candidate);
  warnings.push(
    `${entry} names the ${candidate.kind} ${quoted(named)}, but aireg installs it as ${quoted(candidate.name)}, the name of its ${candidate.kind === "skill" ? "folder" : "file"}.`,
  );
}

/** One skill folder or agent file as an artifact with a content-only envelope. */
export async function artifactOf(
  tree: Tree,
  candidate: Candidate,
  warnings: string[],
): Promise<Artifact> {
  const entry = entryOf(candidate);
  const front = await frontOf(tree, entry);
  checkName(candidate, front, warnings);
  let files: ContentFile[];
  if (candidate.kind === "skill") {
    const root = candidate.at === ROOT_ID ? "" : candidate.at;
    const walked = await tree.walk(root);
    for (const skip of walked.skipped) warnings.push(skipped(skip));
    const prefix = root === "" ? "" : `${root}/`;
    files = walked.files.map((file) => ({
      path: file.path.slice(prefix.length),
      locator: file.path,
      executable: file.executable,
    }));
  } else {
    files = [{ path: AGENT_FILE, locator: candidate.at, executable: false }];
  }
  const description = textField(front, "description");
  return contentArtifact(tree, {
    id: candidate.at,
    kind: candidate.kind,
    name: candidate.name,
    description,
    group: candidate.namespace,
    files,
    spec: { name: candidate.name, ...(description === undefined ? {} : { description }) },
  });
}

/** A plain folder of skills: `SKILL.md` folders and `agents/*.md` files, as a repository holds them. */
export const folderLayout: Layout = {
  id: "folder",
  looksFor: [SKILL_FILE, "agents/*.md"],
  async match(tree) {
    const found = await candidates(tree, { namespace: "", rootName: "" }, []);
    return found.length > 0 ? "yes" : "no";
  },
  async enumerate(tree, context): Promise<Found> {
    const warnings: string[] = [];
    const kept = deduplicated(await candidates(tree, context, warnings), warnings);
    const artifacts: Artifact[] = [];
    for (const candidate of kept) artifacts.push(await artifactOf(tree, candidate, warnings));
    return { artifacts, warnings };
  },
};
