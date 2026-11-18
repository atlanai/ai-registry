import { isAbsolute } from "node:path";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { Catalogs } from "#cli/catalog/registries.ts";
import { CatalogReader, THIS_MACHINE } from "#cli/catalog/state.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { DISCOVER_COMMAND } from "#cli/commands/discover/spec.ts";
import { parse } from "#cli/options/parse.ts";
import type { Entry } from "#core/catalog/catalog.ts";
import { readConfig } from "#core/config/repository.ts";
import type { DiscoveryCatalog } from "#core/discovery/actions.ts";
import { DiscoveryError } from "#core/discovery/gemini.ts";
import type { Skill } from "#core/discovery/retrieval.ts";
import { frontmatter } from "#core/frontmatter.ts";
import { authoredDigest } from "#core/fs/digest.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { scopeFor } from "#core/store/paths.ts";
import { type Probed, probeAddress, throughManifest, wantOf } from "#engine/address/probe.ts";
import { knownRegistries } from "#engine/address/registries.ts";

/** Discovery reads sources only on refresh, or when verifying one selected skill. */
export function discoveryCatalog(context: CommandContext): DiscoveryCatalog {
  async function scope() {
    const config = await readConfig();
    const root = config.jobs
      .flatMap((job) => job.steps)
      .find((step) => step.root !== undefined)?.root;
    const common = parse([], DISCOVER_COMMAND).common;
    common.scope = root === undefined ? "user" : scopeFor(root);
    const cwd = root ?? context.cwd;
    return { cwd, known: await knownRegistries(common, cwd) };
  }
  async function open(registry: string, skill?: Skill) {
    const { known, cwd } = await scope();
    if (!Object.hasOwn(known, registry))
      throw new DiscoveryError(
        "A selected registry is no longer configured. Review discovery setup.",
      );
    const address = skill
      ? [registry, skill.namespace, "skill", skill.name].filter(Boolean).join("/")
      : registry;
    const resolved = throughManifest(address, known, {});
    return probeAddress(resolved, cwd, wantOf(resolved));
  }
  return {
    async available() {
      return [...Object.keys((await scope()).known), THIS_MACHINE].sort();
    },
    async list(registries) {
      const skills: Skill[] = [];
      // A local-only refresh must never open any remote registry.
      if (registries.includes(THIS_MACHINE)) skills.push(...(await localSkills(context)));
      for (const registry of registries.filter((r) => r !== THIS_MACHINE)) {
        const source = await open(registry);
        try {
          if (skills.length + source.catalog.entries.filter((e) => e.kind === "skill").length > 500)
            throw new DiscoveryError(
              "This preview supports up to 500 skills. Select fewer registries.",
            );
          for (const entry of source.catalog.entries) {
            if (entry.kind === "skill") skills.push(await remoteSkill(source, registry, entry));
          }
        } finally {
          await source.close();
        }
      }
      return skills;
    },
    async resolve(skill) {
      if (skill.registry === THIS_MACHINE) return localSkill(skill);
      const source = await open(skill.registry, skill);
      try {
        const entry = source.catalog.entries.find(
          (e) => e.kind === "skill" && e.name === skill.name && (e.group ?? "") === skill.namespace,
        );
        return entry ? await remoteSkill(source, skill.registry, entry) : undefined;
      } finally {
        await source.close();
      }
    },
  };
}

async function localSkills(context: CommandContext): Promise<Skill[]> {
  const skills: Skill[] = [];
  const page = await new CatalogReader(context, new Catalogs(context, true, [])).read();
  for (const artifact of page.artifacts) {
    if (artifact.kind !== "skill" || artifact.registry !== THIS_MACHINE) continue;
    const skill = await localSkill({
      key: artifact.key,
      name: artifact.name,
      registry: THIS_MACHINE,
      namespace: "",
      version: "",
      digest: "",
      description: "",
    });
    if (!skill)
      throw new DiscoveryError(
        "A local skill could not be read. Check it before refreshing the index.",
      );
    skills.push(skill);
  }
  return skills;
}

async function localSkill(skill: Skill): Promise<Skill | undefined> {
  const prefix = `${THIS_MACHINE}/${skill.name}/`;
  if (!skill.key.startsWith(prefix)) return undefined;
  const path = skill.key.slice(prefix.length);
  if (!path.startsWith("~/") && !isAbsolute(path)) return undefined;
  const root = expandUserPath(path);
  const read = await readRegular(root, SKILL_ENTRY);
  if (read.kind !== "file") return undefined;
  return {
    ...skill,
    description: (frontmatter(read.bytes.toString("utf8", 0, 16_384)).description ?? "").slice(
      0,
      4000,
    ),
    digest: await authoredDigest(root),
  };
}

async function remoteSkill(source: Probed, registry: string, entry: Entry): Promise<Skill> {
  const version = source.versionOf(entry);
  const digest = await source.digestOf({
    name: entry.name,
    namespace: entry.group,
    kind: "skill",
    version,
  });
  return {
    key: [registry, entry.group, "skill", entry.name].filter(Boolean).join("/"),
    registry,
    namespace: entry.group ?? "",
    name: entry.name,
    version: version ?? "",
    description: (entry.description ?? "").slice(0, 4000),
    digest: digest ?? (await authoredDigest(await source.stage(entry))),
  };
}
