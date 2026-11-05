import { type KindManifest, kindsOf, primaryFiles } from "#core/filespec/kind-manifests.ts";
import type { Git } from "#test/kit/fixtures.ts";
import {
  type SpecArtifact,
  type SpecVersion,
  skillBody,
  writeSpecRoot,
} from "#test/kit/spec-root.ts";

interface VersionOptions {
  description?: string;
  /** Replaces the default entry file. */
  files?: Record<string, string>;
  /** What follows the default entry file's front matter. */
  body?: string;
  /** Fully qualified refs this version's `depends_on` edges name. */
  dependsOn?: readonly string[];
  status?: string;
}

/** `acme/lint@1.0.0`: a namespace, a name and a version, as a test names one. */
function parse(ref: string): { namespace: string; name: string; version: string } {
  const match = /^([^/@]+)\/([^/@]+)@([^/@]+)$/.exec(ref);
  if (match === null) throw new Error(`Expected namespace/name@version, got "${ref}".`);
  const [, namespace, name, version] = match as unknown as [string, string, string, string];
  return { namespace, name, version };
}

/** A file spec registry, built up one published version at a time. */
class RegistryBuilder {
  readonly #root: string;
  readonly #options: { name?: string; slug?: string };
  readonly #artifacts: SpecArtifact[] = [];
  /** Versions given no files, filled with their kind's entry file when written. */
  readonly #bare = new Map<SpecVersion, string>();

  constructor(root: string, options: { name?: string; slug?: string }) {
    this.#root = root;
    this.#options = options;
  }

  skill(ref: string, options: VersionOptions = {}): this {
    return this.#publish("skill", ref, options);
  }

  agent(ref: string, options: VersionOptions = {}): this {
    return this.#publish("agent", ref, options);
  }

  /** Withdraws a version already published here: skipped for `latest`, still resolvable by pin. */
  yank(ref: string, reason?: string): this {
    const version = this.#version(ref);
    version.yanked = true;
    if (reason !== undefined) version.reason = reason;
    return this;
  }

  /** Blocks a version already published here, which nothing then installs. */
  block(ref: string, reason?: string): this {
    return this.status(ref, "blocked", reason);
  }

  /** Sets a version's status in `versions.json`, as a status change in a pull request does. */
  status(ref: string, status: string, reason?: string): this {
    const version = this.#version(ref);
    version.status = status;
    if (reason !== undefined) version.reason = reason;
    return this;
  }

  /** Writes registry.json, index.json and every version, returning the registry's root. */
  async write(): Promise<string> {
    const kinds = await kindsOf(undefined);
    for (const artifact of this.#artifacts) {
      for (const version of artifact.versions) {
        const body = this.#bare.get(version);
        if (body === undefined) continue;
        const entry = primaryFiles(kinds[artifact.kind] as KindManifest)[0] as string;
        version.files = { [entry]: skillBody(artifact.name, version.description, body) };
      }
    }
    await writeSpecRoot(this.#root, this.#artifacts, this.#options);
    return this.#root;
  }

  #publish(kind: SpecArtifact["kind"], ref: string, options: VersionOptions): this {
    const { namespace, name, version } = parse(ref);
    const description = options.description ?? name;
    const entry: SpecVersion = {
      version,
      description,
      files: options.files ?? {},
      ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
      ...(options.status === undefined ? {} : { status: options.status }),
    };
    if (options.files === undefined) this.#bare.set(entry, options.body ?? `\n# ${name}\n`);
    const existing = this.#artifacts.find(
      (artifact) =>
        artifact.namespace === namespace && artifact.name === name && artifact.kind === kind,
    );
    if (existing === undefined) {
      this.#artifacts.push({ namespace, kind, name, versions: [entry] });
    } else {
      existing.versions = [...existing.versions, entry];
    }
    return this;
  }

  #version(ref: string): SpecVersion {
    const { namespace, name, version } = parse(ref);
    const found = this.#artifacts
      .find((artifact) => artifact.namespace === namespace && artifact.name === name)
      ?.versions.find((entry) => entry.version === version);
    if (found === undefined) throw new Error(`${ref} is not published in this registry.`);
    return found;
  }
}

export function registry(root: string, options: { name?: string; slug?: string } = {}) {
  return new RegistryBuilder(root, options);
}

/** A git registry holding `acme/lint` and `acme/triage`, committed and tagged `v1`. */
export async function gitRegistry(git: Git, dir: string): Promise<string> {
  await registry(dir)
    .skill("acme/lint@1.0.0", { body: "run\n" })
    .agent("acme/triage@1.0.0", { body: "" })
    .write();
  await git.init(dir);
  await git.commit(dir, "initial");
  await git.tag(dir, "v1");
  return dir;
}
