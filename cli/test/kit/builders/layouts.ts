import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

/** A skill's front matter and body, as a folder of skills writes it. */
export function skillFile(name: string, description = `${name}.`, body = `Use ${name}.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

/** A folder of skills and agents with no registry.json, built one file at a time. */
class FolderBuilder {
  readonly #root: string;
  readonly #files = new Map<string, { body: string; executable: boolean }>();
  readonly #links = new Map<string, string>();

  constructor(root: string) {
    this.#root = root;
  }

  /** A skill folder at `at`, such as `skills/pdf`, named after its last segment. */
  skill(at: string, options: { description?: string; body?: string; name?: string } = {}): this {
    const name = options.name ?? posix.basename(at);
    return this.file(
      posix.join(at, "SKILL.md"),
      skillFile(name, options.description, options.body),
    );
  }

  /** An agent file at `at`, such as `agents/reviewer.md`. */
  agent(at: string, options: { description?: string; body?: string } = {}): this {
    return this.file(at, skillFile(posix.basename(at, ".md"), options.description, options.body));
  }

  file(at: string, body: string, executable = false): this {
    this.#files.set(at, { body, executable });
    return this;
  }

  /** A symlink at `at` pointing at `target`, which a reader must never follow. */
  link(at: string, target: string): this {
    this.#links.set(at, target);
    return this;
  }

  async write(): Promise<string> {
    for (const [at, { body, executable }] of this.#files) {
      const path = join(this.#root, ...at.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      if (executable) await chmod(path, 0o755);
    }
    for (const [at, target] of this.#links) {
      const path = join(this.#root, ...at.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await symlink(target, path);
    }
    return this.#root;
  }
}

export function skillsFolder(root: string): FolderBuilder {
  return new FolderBuilder(root);
}
