import { roots } from "#core/store/paths.ts";
import { shellWord } from "#core/term/format.ts";
import { readLock } from "./lock.ts";
import { readManifest } from "./manifest.ts";
import { NAME, REPOSITORY, REPOSITORY_NAME, releaseTag } from "./product.ts";
import { VERSION } from "./version.ts";

/** The repository holding the skills that teach an agent to install from and publish to registries. */
export const OWN_SKILLS_SOURCE = REPOSITORY;
/** The folder in that repository that is the registry. */
export const OWN_SKILLS_PATH = `examples/${NAME}`;

/** Its alias once added, and the namespace that holds the skills. */
export const OWN_SKILLS_ALIAS = REPOSITORY_NAME;
export const OWN_SKILLS_NAMESPACE = NAME;

/** The release this build was made from, so its skills match it; a development build has none. */
export function ownSkillsRef(version = VERSION): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version) ? releaseTag(version) : undefined;
}

/** Where the skills registry is read from: this repository, or wherever your user scope has it. */
interface OwnSkillsSource {
  location: string;
  path: string | undefined;
}

/** What gives your agents the aireg skills: the same two steps as any registry. */
export function ownSkillsCommand(
  aireg = "aireg",
  version = VERSION,
  source: OwnSkillsSource = { location: OWN_SKILLS_SOURCE, path: OWN_SKILLS_PATH },
): string {
  const ref = ownSkillsRef(version);
  const pinned = ref === undefined ? "" : ` --ref ${ref}`;
  const path = source.path === undefined ? "" : ` --path ${shellWord(source.path)}`;
  return `${aireg} registry add ${shellWord(source.location)}${path}${pinned} --as ${OWN_SKILLS_ALIAS} -g && ${aireg} add ${OWN_SKILLS_ALIAS}/${OWN_SKILLS_NAMESPACE} -g`;
}

/** Whether your user scope already holds them. */
export async function ownSkillsInstalled(cwd: string): Promise<boolean> {
  const lock = await readLock(roots("user", cwd));
  return Object.values(lock.artifacts).some(
    (entry) => entry.registry === OWN_SKILLS_ALIAS && entry.namespace === OWN_SKILLS_NAMESPACE,
  );
}

/** The skills installed from another release than this aireg's, and what pins them to this one. */
export interface StalePin {
  pinned: string;
  fix: string;
}

/**
 * Read from the lockfile, which is what is installed: a ref declared anew reaches it only on
 * `add`. A ref that names no release, such as a branch someone chose, stays theirs.
 */
export async function staleOwnSkillsPin(
  cwd: string,
  version = VERSION,
): Promise<StalePin | undefined> {
  const wanted = ownSkillsRef(version);
  if (wanted === undefined) return undefined;
  const user = roots("user", cwd);
  const pinned = (await readLock(user)).registries[OWN_SKILLS_ALIAS]?.config.ref;
  if (pinned === undefined || pinned === wanted) return undefined;
  const prefix = releaseTag("");
  if (!pinned.startsWith(prefix) || ownSkillsRef(pinned.slice(prefix.length)) !== pinned) {
    return undefined;
  }
  // `registry add` refuses a new address under a name it has, so the fix keeps the one declared.
  const declared = (await readManifest(user.manifest)).registries[OWN_SKILLS_ALIAS];
  const source = declared && { location: declared.location, path: declared.config.path };
  return { pinned, fix: ownSkillsCommand("aireg", version, source) };
}
