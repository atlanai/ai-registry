import { isAbsolute } from "node:path";
import { type ArtifactKind, KINDS } from "#adapter/kinds.ts";
import { quoted } from "#adapter/text.ts";
import { KIND_SPECS } from "#core/kinds.ts";
import type { ConfigValue, KindMapping, RegisterEntry, TargetDefinition } from "./contract.ts";
import { templateVars } from "./template.ts";

/** Every `{var}` a definition may use, by where it is used. */
const TEMPLATE_VARS = {
  placement: ["name", "source"],
  manifest: ["name", "description"],
  register: ["name", "source", "root"],
} as const;

type Report = (problem: string) => void;

/**
 * What types cannot say: ids that resolve, templates that use only the variables their
 * place fills, and paths that stay inside their root. `known` are ids defined elsewhere.
 */
export function targetProblems(
  definitions: readonly TargetDefinition[],
  known: readonly TargetDefinition[] = [],
): string[] {
  const problems: string[] = [];
  const byId = new Map<string, TargetDefinition>(known.map((each) => [each.id, each]));
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) problems.push(`${definition.id} is defined twice.`);
    seen.add(definition.id);
    byId.set(definition.id, definition);
  }
  const owners = ownersOf([...byId.values()]);
  for (const definition of definitions) {
    const report = (problem: string) => problems.push(`${definition.id}: ${problem}`);
    if (!ID.test(definition.id)) report("the id is not a lowercase name.");
    aliasProblems(definition, owners, report);
    rootProblems(definition, report);
    if (
      definition.category === "shared-folder" &&
      definition.detect !== undefined &&
      definition.detect !== "never"
    ) {
      report('a shared folder is never detected, so detect must be "never".');
    }
    const profiles = definition.profiles?.root;
    if (profiles !== undefined) profileProblems(profiles, report);
    for (const kind of KINDS) {
      const mapping = definition.kinds[kind];
      if (mapping !== undefined) mappingProblems(kind, mapping, report);
      for (const read of definition.reads?.[kind] ?? [])
        readProblem(kind, owners.get(read)?.[0], read, report);
    }
  }
  return problems;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Every id and alias, with each definition that answers to it. */
function ownersOf(definitions: readonly TargetDefinition[]): Map<string, TargetDefinition[]> {
  const owners = new Map<string, TargetDefinition[]>();
  for (const definition of definitions) {
    for (const name of new Set([definition.id, ...(definition.aliases ?? [])])) {
      owners.set(name, [...(owners.get(name) ?? []), definition]);
    }
  }
  return owners;
}

/** An alias is read wherever an id is, so it must name this definition alone. */
function aliasProblems(
  definition: TargetDefinition,
  owners: ReadonlyMap<string, TargetDefinition[]>,
  report: Report,
) {
  for (const alias of definition.aliases ?? []) {
    if (!ID.test(alias)) report(`the alias ${quoted(alias)} is not a lowercase name.`);
    if (alias === definition.id) report(`the alias ${quoted(alias)} is its own id.`);
    const other = owners.get(alias)?.find((each) => each !== definition);
    if (other !== undefined) {
      report(`the alias ${quoted(alias)} already names the target ${quoted(other.id)}.`);
    }
  }
}

function rootProblems(definition: TargetDefinition, report: Report) {
  if (!definition.roots.user.default.startsWith("~/")) report("the user root is not under ~/.");
  for (const path of [definition.roots.project, definition.roots.user.default.slice(2)]) {
    pathProblem(path, [], report);
  }
  const within = definition.roots.user.within;
  if (within !== undefined) {
    pathProblem(within, [], report);
    if (definition.roots.user.env === undefined) report("roots.user.within needs an env.");
  }
}

function pathProblem(path: string, vars: readonly string[], report: Report) {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    report(`${quoted(path)} is not a path inside its root.`);
  }
  templateProblems(path, vars, report);
}

function templateProblems(text: string, vars: readonly string[], report: Report) {
  for (const name of templateVars(text)) {
    if (!vars.includes(name)) report(`${text} uses {${name}}, which nothing fills there.`);
  }
}

function profileProblems(root: string, report: Report) {
  if (!root.startsWith("~/")) report("the profiles root is not under ~/.");
  pathProblem(root.slice(2), ["profile"], report);
  const segments = root.split("/");
  if (!segments.at(-1)?.includes("{profile}") || segments.slice(0, -1).join("/").includes("{")) {
    report("the profiles root names {profile} only in its last segment.");
  }
  if (segments.length === 2 && segments[1] === "{profile}") {
    report("the profiles root would make every folder in your home folder a profile.");
  }
}

function mappingProblems(kind: ArtifactKind, mapping: KindMapping, report: Report) {
  if (mapping.shape === "contents") return;
  pathProblem(mapping.subdir, TEMPLATE_VARS.placement, report);
  for (const entry of mapping.manifest ?? []) {
    pathProblem(entry.path, [], report);
    valueProblems(entry.body ?? {}, TEMPLATE_VARS.manifest, report);
  }
  keyProblems(mapping, report);
  // A register entry can use only what its placement path carries, and the root.
  const carried = templateVars(mapping.subdir);
  if (!mapping.subdir.includes("{")) carried.push("name");
  const usable = TEMPLATE_VARS.register.filter((name) => name === "root" || carried.includes(name));
  for (const entry of mapping.register ?? []) {
    registerProblems(kind, entry, usable, report);
  }
  if (mapping.shape === "directory" && mapping.entry !== undefined) {
    pathProblem(mapping.entry, [], report);
    if (mapping.entry.includes("/")) report(`kinds.${kind}: entry is not a file name.`);
    if (KIND_SPECS[kind].shape !== "file")
      report(`kinds.${kind}: entry is for a kind that is one file.`);
  }
  if (mapping.shape === "directory" && mapping.codec !== undefined && mapping.entry === undefined) {
    report(`kinds.${kind}: a codec on a folder needs an entry file.`);
  }
  if (mapping.shape === "file" && mapping.render !== undefined && mapping.codec !== undefined) {
    report(`kinds.${kind}: render is the earlier name of a codec, so set codec alone.`);
  }
  // Written unquoted, so each key must be a bare one.
  const toml =
    mapping.codec?.id === "frontmatter-toml"
      ? mapping.codec
      : mapping.shape === "file"
        ? mapping.render
        : undefined;
  for (const key of [...(toml?.fields ?? []), toml?.body ?? "body"]) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) report(`${kind} renders ${key}, which is not a bare key.`);
  }
}

function valueProblems(value: ConfigValue, vars: readonly string[], report: Report) {
  if (typeof value === "string") templateProblems(value, vars, report);
  else if (Array.isArray(value)) for (const item of value) valueProblems(item, vars, report);
  else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      templateProblems(key, vars, report);
      valueProblems(item, vars, report);
    }
  }
}

function keyProblems(mapping: KindMapping, report: Report) {
  for (const file of Object.values(mapping.keys ?? {})) {
    if (file === false) continue;
    pathProblem(file.path, [], report);
    if (!/\.(json|ya?ml)$/.test(file.path)) {
      report(`${quoted(file.path)} is not a .json or .yaml file.`);
    }
  }
}

function registerProblems(
  kind: string,
  entry: RegisterEntry,
  vars: readonly string[],
  report: Report,
) {
  pathProblem(
    entry.file,
    vars.filter((name) => name !== "root"),
    report,
  );
  if (entry.at.length === 0) report(`kinds.${kind}: a register entry names no table.`);
  for (const key of entry.at) templateProblems(key, vars, report);
  for (const value of [entry.value, entry.off, entry.init])
    valueProblems(value ?? {}, vars, report);
  if (entry.upsert !== undefined) {
    if (entry.format === "toml") report(`kinds.${kind}: upsert needs a JSON or YAML file.`);
    if (entry.upsert.item[entry.upsert.key] === undefined) {
      report(`kinds.${kind}: an upsert item must set ${entry.upsert.key}.`);
    }
    valueProblems(entry.upsert.item, vars, report);
  }
  if (entry.append !== undefined) {
    if (entry.format !== "yaml") report(`kinds.${kind}: append needs a YAML file.`);
    templateProblems(entry.append, vars, report);
  }
  if (entry.init !== undefined && entry.format === "toml" && Object.keys(entry.init).length > 0) {
    report(`kinds.${kind}: a TOML file starts empty, so its init is {}.`);
  }
}

function readProblem(
  kind: ArtifactKind,
  found: TargetDefinition | undefined,
  read: string,
  report: Report,
) {
  if (found === undefined) report(`reads.${kind} names ${read}, which is not a target.`);
  else if (found.kinds[kind] === undefined) {
    report(`reads.${kind} names ${read}, which places no ${kind}.`);
  }
}
