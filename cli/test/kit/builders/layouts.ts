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

  /** A JSON document at `at`, such as a marketplace or a plugin manifest. */
  json(at: string, value: unknown): this {
    return this.file(at, `${JSON.stringify(value, null, 2)}\n`);
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

/**
 * A marketplace of two plugins: `docs-kit`, with its own manifest, two skills and a command, and
 * `deploy-kit`, which carries hooks and an MCP server and has only its entry for a manifest.
 */
export function marketplace(root: string): FolderBuilder {
  return skillsFolder(root)
    .json(".claude-plugin/marketplace.json", {
      name: "acme-tools",
      owner: { name: "Acme" },
      plugins: [
        { name: "docs-kit", source: "./plugins/docs-kit" },
        { name: "deploy-kit", source: "./plugins/deploy-kit", description: "Ships builds." },
      ],
    })
    .json("plugins/docs-kit/.claude-plugin/plugin.json", {
      name: "docs-kit",
      version: "1.0.0",
      description: "Works with documents.",
    })
    .skill("plugins/docs-kit/skills/pdf")
    .skill("plugins/docs-kit/skills/xlsx")
    .file(
      "plugins/docs-kit/commands/summarize.md",
      "---\ndescription: Summarize the open file.\n---\nSummarize $ARGUMENTS.\n",
    )
    .skill("plugins/deploy-kit/skills/ship")
    .json("plugins/deploy-kit/hooks/hooks.json", { hooks: {} })
    .json("plugins/deploy-kit/.mcp.json", { mcpServers: { deploy: { command: "deploy-mcp" } } });
}
