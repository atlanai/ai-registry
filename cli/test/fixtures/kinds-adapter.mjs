// A filesystem-backed adapter that declares kinds of its own through `extend.kinds`.
// Registered through `adapters:` in ~/.aireg/config.yml by the tests that use it.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

const KIND = /^[a-z][a-z0-9_]{0,31}$/;
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

function remoteRoot() {
  return join(process.env.AIREG_HOME ?? "", "kinds-remote");
}

function safe(value, pattern, what) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`The kinds adapter refuses the ${what} ${JSON.stringify(value)}.`);
  }
  return value;
}

function safePath(path) {
  const parts = typeof path === "string" ? path.split("/") : [];
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`The kinds adapter refuses the file path ${JSON.stringify(path)}.`);
  }
  return parts;
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (cause) {
    if (cause.code === "ENOENT") return [];
    throw cause;
  }
}

async function walk(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const next = prefix === "" ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, next)));
    else if (next !== "meta.json") found.push(next);
  }
  return found.sort();
}

async function describe(namespace, kind, name, path) {
  const meta = JSON.parse(await readFile(join(path, "meta.json"), "utf8"));
  const described = [];
  for (const file of await walk(path)) {
    const bytes = await readFile(join(path, file));
    described.push({
      path: file,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
      urls: [file],
    });
  }
  return {
    id: `${namespace}/${kind}/${name}`,
    kind,
    group: namespace,
    envelope: {
      apiVersion: "aireg.sh/v1",
      kind,
      metadata: {
        name,
        namespace,
        version: meta.version,
        ...(meta.description === undefined ? {} : { description: meta.description }),
      },
      files: described,
    },
    files: described.map((file) => ({ path: file.path, locator: file.path, executable: false })),
  };
}

async function list() {
  const root = remoteRoot();
  const found = [];
  for (const namespace of await directories(root)) {
    for (const kind of await directories(join(root, namespace.name))) {
      for (const name of await directories(join(root, namespace.name, kind.name))) {
        const path = join(root, namespace.name, kind.name, name.name);
        found.push(await describe(namespace.name, kind.name, name.name, path));
      }
    }
  }
  return found;
}

async function publish(input) {
  const path = join(
    remoteRoot(),
    safe(input.namespace, SEGMENT, "namespace"),
    safe(input.kind, KIND, "kind"),
    safe(input.name, SEGMENT, "name"),
  );
  const targets = input.files.map((file) => [file, join(path, ...safePath(file.path))]);
  await rm(path, { recursive: true, force: true });
  for (const [file, target] of targets) {
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.content);
  }
  const meta = { version: input.version, description: input.description, spec: input.spec };
  await writeFile(join(path, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { id: `${input.namespace}/${input.kind}/${input.name}` };
}

/** Claude Code reads servers from the project's .mcp.json, outside its target root, so it is placed only. */
const MCP_SERVER = {
  name: "mcp_server",
  dir: "mcp_servers",
  shape: "directory",
  entry: "server.json",
  description: "A Model Context Protocol server.",
  targets: {
    "claude-code": { shape: "directory", subdir: "mcp" },
    codex: {
      shape: "directory",
      subdir: "mcp",
      register: [
        {
          file: "config.toml",
          format: "toml",
          at: ["mcp_servers", "{name}"],
          // A TOML register entry writes plain values only, so the server is its own executable.
          value: { command: "{root}/mcp/{name}/server.js" },
          init: {},
          remove: "entry",
        },
      ],
    },
  },
};

export default {
  id: "kinds",
  displayName: "Kinds registry",
  protocol: 1,
  artifactKinds: ["skill", "knowledge", "prompt", "mcp_server"],
  dispatch: { hosts: ["kinds.registry.localhost"] },
  capabilities: { pinsSource: false, publish: true, namespacePlugins: true },
  async connect() {
    return {
      resolve: async (want, options) => {
        const names = new Set(want.map((each) => each.name));
        const found = await list();
        const every = options?.all === true || names.size === 0;
        return {
          artifacts: found.filter((each) => every || names.has(each.envelope.metadata.name)),
          complete: every,
        };
      },
      fetch: async (artifact, file) => {
        const [namespace, kind, name] = artifact.id.split("/");
        const path = join(remoteRoot(), namespace, kind, name, ...safePath(file.locator));
        return readFile(path);
      },
      publish: async (inputs) => {
        for (const input of inputs) await publish(input);
        return {};
      },
      close: async () => {},
    };
  },
  extend: {
    kinds: [
      {
        name: "knowledge",
        dir: "knowledge",
        shape: "directory",
        description: "Documents an agent reads, published and never installed.",
      },
      {
        name: "prompt",
        dir: "prompt_files",
        shape: "file",
        extensions: [".md"],
        description: "A prompt a person runs.",
        targets: { universal: { shape: "file", subdir: "prompts", extension: ".md" } },
      },
      MCP_SERVER,
    ],
  },
};
