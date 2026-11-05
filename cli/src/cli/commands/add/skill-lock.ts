import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { isArtifactName } from "#adapter/filespec/names.ts";
import { isSafePath } from "#adapter/paths.ts";
import { quoted, sanitizeText } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isRecord } from "#core/fields.ts";

/** One skill another installer recorded, as aireg reads it again. */
export interface LockedSkill {
  /** The name it was installed under, which is the key it is recorded by. */
  name: string;
  /** Where aireg reads it from: a repository's address, or a site's. */
  address: string;
  ref: string | undefined;
  /** Its folder in the source, from the path the file gives its SKILL.md. */
  folder: string;
}

/** What a lock file of another installer asks for, and what aireg could not read of it. */
export interface SkillLock {
  skills: LockedSkill[];
  /** One sentence for each entry left out. */
  skipped: string[];
  /** The file describes a user's own skills, which go into the user scope. */
  user: boolean;
}

/** `owner/repo` on a code host, as these files write a repository there. */
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

const HOSTS: Readonly<Record<string, string>> = { github: "github.com", gitlab: "gitlab.com" };

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Reads a project's `skills-lock.json` or a user's `.skill-lock.json`: a version and a map of skill
 * name to where it came from. Fields aireg does not know are passed over, never copied anywhere.
 */
export async function readSkillLock(path: string): Promise<SkillLock> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    throw new AiregError(missing ? `${path} does not exist.` : `${path} is not valid JSON.`, {
      code: missing ? ErrorCode.NotFound : ErrorCode.Invalid,
      cause,
    });
  }
  if (!isRecord(document) || typeof document.version !== "number" || !isRecord(document.skills)) {
    throw new AiregError(
      `${path} is not a skills lock file: it needs a \`version\` and a \`skills\` map.`,
      {
        code: ErrorCode.Invalid,
      },
    );
  }
  const skills: LockedSkill[] = [];
  const skipped: string[] = [];
  let user = false;
  for (const [name, raw] of Object.entries(document.skills)) {
    const shown = quoted(sanitizeText(name, 64));
    if (!isArtifactName(name) || !isRecord(raw)) {
      skipped.push(`Skipped ${shown} in ${path}: it is not a skill aireg can name.`);
      continue;
    }
    // A user's file records each skill's folder hash and its full URL; a project's does not.
    if (raw.skillFolderHash !== undefined || raw.sourceUrl !== undefined) user = true;
    const address = addressOf(raw);
    const folder = folderOf(text(raw.skillPath));
    if (typeof address !== "string" || folder === undefined) {
      const why =
        typeof address === "string"
          ? "its skillPath is not a path inside its source"
          : address.skip;
      skipped.push(`Skipped ${shown} in ${path}: ${why}.`);
      continue;
    }
    skills.push({ name, address, ref: text(raw.ref), folder });
  }
  return { skills, skipped, user };
}

/** The address an entry's source names, or why aireg does not read it. Nothing else is taken from it. */
function addressOf(entry: Record<string, unknown>): string | { skip: string } {
  const type = text(entry.sourceType);
  const source = text(entry.sourceUrl) ?? text(entry.source);
  if (type === undefined || source === undefined) return { skip: "it names no source" };
  const host = HOSTS[type];
  if (host !== undefined) {
    if (SHORTHAND.test(source)) return `${host}/${source}`;
    return /^https:\/\//.test(source) ? source : { skip: "its source is not owner/repo" };
  }
  if (type === "git" || type === "well-known") {
    return /^(https|ssh|file):\/\/|^git@/.test(source)
      ? source
      : { skip: "its source is not an address aireg reads" };
  }
  return { skip: `its source type, ${quoted(sanitizeText(type, 40))}, is not one aireg reads` };
}

/** `skills/pdf/SKILL.md` is the folder `skills/pdf`; the root's SKILL.md is the whole source. */
function folderOf(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const folder = path.endsWith("SKILL.md") ? posix.dirname(path) : path.replace(/\/+$/, "");
  if (folder === "." || folder === "") return ".";
  return isSafePath(folder) ? folder : undefined;
}
