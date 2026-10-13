import { roots } from "#core/store/paths.ts";
import { readLock } from "./lock.ts";
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

/** What gives your agents the aireg skills: the same two steps as any registry. */
export function ownSkillsCommand(aireg = "aireg", version = VERSION): string {
  const ref = ownSkillsRef(version);
  const pinned = ref === undefined ? "" : ` --ref ${ref}`;
  return `${aireg} registry add ${OWN_SKILLS_SOURCE} --path ${OWN_SKILLS_PATH}${pinned} --as ${OWN_SKILLS_ALIAS} -g && ${aireg} add ${OWN_SKILLS_ALIAS}/${OWN_SKILLS_NAMESPACE} -g`;
}

/** Whether your user scope already holds them. */
export async function ownSkillsInstalled(cwd: string): Promise<boolean> {
  const lock = await readLock(roots("user", cwd));
  return Object.values(lock.artifacts).some(
    (entry) => entry.registry === OWN_SKILLS_ALIAS && entry.namespace === OWN_SKILLS_NAMESPACE,
  );
}
