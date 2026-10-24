// A filesystem-backed provider used to develop clients without a real backend.
// Registered through `adapters:` in ~/.aireg/config.yml; never bundled.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, relative, sep } from "node:path";

const KINDS = ["skill", "agent"];
const ARCHIVE = "_archived";
const UNPRINTABLE = /\p{Cc}/u;

function remoteRoot() {
  const override = process.env.AIREG_DEV_REMOTE?.trim();
  if (override !== undefined && override !== "") return override;
  const home = process.env.AIREG_HOME?.trim();
  return join(home === undefined || home === "" ? join(homedir(), ".aireg") : home, "dev-remote");
}

/**
 * The registry's config, a manifest and the host's ids all reach the paths below, so
 * each name is one plain folder, as `isSafePath` in src/adapter/paths.ts keeps a path.
 */
function segment(value, what) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value === ".." ||
    value === ARCHIVE ||
    /[/\\:]/.test(value) ||
    UNPRINTABLE.test(value)
  ) {
    throw new Error(`The dev adapter refuses the ${what} ${JSON.stringify(value)}.`);
  }
  return value;
}

function kindOf(kind) {
  if (!KINDS.includes(kind)) {
    throw new Error(`The dev adapter refuses the kind ${JSON.stringify(kind)}.`);
  }
  return kind;
}

function segments(path) {
  const safe =
    typeof path === "string" &&
    path !== "" &&
    !posix.isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !UNPRINTABLE.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (!safe) throw new Error(`The dev adapter refuses the file path ${JSON.stringify(path)}.`);
  return path.split("/");
}

/** `target`, once it is inside the remote and nothing on the way there is a link. */
async function contained(target) {
  const root = remoteRoot();
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`The dev adapter refuses ${target}, which is outside ${root}.`);
  }
  let path = root;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    const found = await lstat(path).catch((cause) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (found === undefined) break;
    if (found.isSymbolicLink()) {
      throw new Error(`The dev adapter refuses ${target}, which goes through the link ${path}.`);
    }
  }
  return target;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function directories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE);
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
    else if (entry.isFile() && entry.name !== "meta.json") found.push(next);
  }
  return found.sort();
}

async function metadata(path) {
  try {
    return JSON.parse(await readFile(join(path, "meta.json"), "utf8"));
  } catch {
    return {};
  }
}

function namespaceDir(context) {
  const namespace = context.source.config.namespace;
  if (typeof namespace !== "string" || namespace === "") {
    throw new Error("The dev adapter needs `namespace` in its registry's config.");
  }
  return join(remoteRoot(), segment(namespace, "namespace"));
}

/**
 * No digest is computed here: the client derives the one content identity from
 * the envelope itself.
 */
async function describe(kind, name, path) {
  const files = [];
  const described = [];
  for (const file of await walk(path)) {
    const bytes = await readFile(join(path, file));
    const mode = (await stat(join(path, file))).mode;
    files.push({ path: file, locator: file, executable: (mode & 0o111) !== 0 });
    described.push({
      path: file,
      digest: `sha256:${sha256(bytes)}`,
      size: bytes.byteLength,
      urls: [file],
    });
  }
  const meta = await metadata(path);
  return {
    id: meta.id ?? `${kind}_${name}`,
    kind,
    envelope: {
      apiVersion: "aireg.sh/v1",
      kind,
      metadata: {
        name,
        ...(meta.version === undefined ? {} : { version: meta.version }),
        ...(meta.description === undefined ? {} : { description: meta.description }),
      },
      files: described,
    },
    files,
  };
}

async function list(context, names) {
  const wanted = new Set(names);
  const root = await contained(namespaceDir(context));
  const artifacts = [];
  for (const kindDir of await directories(root)) {
    if (!KINDS.includes(kindDir.name)) continue;
    for (const entry of await directories(join(root, kindDir.name))) {
      if (wanted.size > 0 && !wanted.has(entry.name)) continue;
      artifacts.push(
        await describe(kindDir.name, entry.name, join(root, kindDir.name, entry.name)),
      );
    }
  }
  return artifacts.sort((left, right) =>
    left.envelope.metadata.name.localeCompare(right.envelope.metadata.name),
  );
}

async function read(context, artifact, file) {
  const name = segment(artifact.envelope.metadata.name, "name");
  const path = join(namespaceDir(context), kindOf(artifact.kind), name, ...segments(file.locator));
  return readFile(await contained(path));
}

async function publish(context, input) {
  const path = join(namespaceDir(context), kindOf(input.kind), segment(input.name, "name"));
  // Every path is checked before the old copy goes, so a refused publish leaves it whole.
  const targets = input.files.map((file) => [file, join(path, ...segments(file.path))]);
  await rm(await contained(path), { recursive: true, force: true });
  for (const [file, joined] of targets) {
    const target = await contained(joined);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
  }
  const meta = {
    id: input.id ?? `${input.kind}_${input.name}`,
    description: input.description,
    version: new Date().toISOString(),
  };
  await writeFile(await contained(join(path, "meta.json")), `${JSON.stringify(meta, null, 2)}\n`);
  return { id: meta.id };
}

async function archive(context, input) {
  const kind = kindOf(input.kind);
  const name = segment(
    input.id.startsWith(`${kind}_`) ? input.id.slice(kind.length + 1) : input.id,
    "name in the id",
  );
  const from = await contained(join(namespaceDir(context), kind, name));
  const to = await contained(join(namespaceDir(context), ARCHIVE, kind, `${name}-${Date.now()}`));
  await mkdir(join(to, ".."), { recursive: true });
  await rename(from, to);
}

function identityFor(endpoint) {
  return { name: `dev-${sha256(endpoint).slice(0, 8)}`, account: "Dev registry" };
}

async function runProbe() {
  return {
    state: "succeeded",
    counts: { examined: 0, changed: 0, skipped: 0, attention: 0, failed: 0 },
  };
}

export default {
  id: "dev",
  displayName: "Dev registry",
  protocol: 1,
  artifactKinds: KINDS,
  dispatch: { hosts: ["dev.registry.localhost"] },
  capabilities: { pinsSource: false, auth: true },
  auth: {
    async login({ endpoint }) {
      return {
        credential: { type: "apiKey", header: "x-dev-key", value: "development" },
        identity: identityFor(endpoint),
      };
    },
  },
  async connect(context) {
    return {
      resolve: async (want) => ({ artifacts: await list(context, want) }),
      fetch: (artifact, file) => read(context, artifact, file),
      publish: async (changes) => {
        for (const change of changes) await publish(context, change);
        return {};
      },
      unpublish: async (changes) => {
        for (const change of changes) await archive(context, change);
      },
      close: async () => {},
    };
  },
  extend: {
    steps: [
      {
        kind: "probe",
        flag: "probe",
        run: runProbe,
      },
    ],
  },
};
