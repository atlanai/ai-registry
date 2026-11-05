import { readLock } from "#core/lock.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { NAME, REPOSITORY, REPOSITORY_NAME, releaseTag } from "#core/product.ts";
import { roots } from "#core/store/paths.ts";
import { shellWord } from "#core/term/format.ts";
import { VERSION } from "#core/version.ts";

export const OWN_SKILLS_SOURCE = REPOSITORY;
export const OWN_SKILLS_PATH = `examples/${NAME}`;

export const OWN_SKILLS_ALIAS = REPOSITORY_NAME;
export const OWN_SKILLS_NAMESPACE = NAME;

/** The release tag, so the skills match this build; undefined for a development build. */
export function ownSkillsRef(version = VERSION): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version) ? releaseTag(version) : undefined;
}

interface OwnSkillsSource {
  location: string;
  path: string | undefined;
}

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

export async function ownSkillsInstalled(cwd: string): Promise<boolean> {
  const lock = await readLock(roots("user", cwd));
  return Object.values(lock.artifacts).some(
    (entry) => entry.registry === OWN_SKILLS_ALIAS && entry.namespace === OWN_SKILLS_NAMESPACE,
  );
}

export interface StalePin {
  pinned: string;
  fix: string;
}

/** Reads the lockfile, which is what is installed; a ref naming no release is left alone. */
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
