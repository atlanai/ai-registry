import type {
  Artifact,
  PublishRelationship,
  SourceAdapter,
  SourceContext,
  SourceHandle,
} from "./contract.ts";
import { ADAPTER_ID, ADAPTER_PROTOCOL, advertisedCapabilities, canSignIn } from "./contract.ts";
import { canonicalize, contentDigest, sha256 } from "./spec/canonical.ts";
import { buildEnvelope, describeFile } from "./spec/envelope.ts";

/** What `assertAdapterCompliance` throws, naming the rule the adapter broke. */
export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

function checkCapabilities(adapter: SourceAdapter, handle: SourceHandle): void {
  const flags = advertisedCapabilities(adapter.capabilities);
  if (flags.publish && handle.publish === undefined) {
    throw new ComplianceError(`${adapter.id} declared publish but the handle has no publish.`);
  }
  if (flags.auth && !canSignIn(adapter)) {
    throw new ComplianceError(`${adapter.id} declared auth but exported no auth.login.`);
  }
  if (!flags.auth && canSignIn(adapter)) {
    throw new ComplianceError(`${adapter.id} exported auth.login but did not declare auth.`);
  }
}

async function checkListing(adapter: SourceAdapter, handle: SourceHandle): Promise<Artifact[]> {
  const listing = await handle.resolve([]);
  if (adapter.capabilities.pinsSource && typeof listing.sourceRevision !== "string") {
    throw new ComplianceError(`${adapter.id} declared pinsSource but resolve named no revision.`);
  }
  for (const artifact of listing.artifacts) {
    if (!adapter.artifactKinds.includes(artifact.kind)) {
      throw new ComplianceError(`${adapter.id} resolved kind ${artifact.kind} it did not declare.`);
    }
    for (const file of artifact.files) {
      const descriptor = artifact.envelope.files.find((entry) => entry.path === file.path);
      if (descriptor === undefined) {
        throw new ComplianceError(`${artifact.id} has no envelope row for ${file.path}.`);
      }
      const bytes = await handle.fetch(artifact, file);
      if (sha256(bytes) !== descriptor.digest) {
        throw new ComplianceError(`${file.path} bytes do not match the envelope digest.`);
      }
    }
  }
  return [...listing.artifacts];
}

/** What the relationships check publishes, named so a person can tell it from their own work. */
const PROBE = "aireg-compliance";
const PROBE_DESCRIPTION = "Checks that a published version keeps its relationships.";

/** An edge to something the registry lists, so a registry that checks edges still takes it. */
function probeEdge(listed: readonly Artifact[]): { namespace: string; edge: PublishRelationship } {
  const target = listed.find(
    (artifact) =>
      artifact.envelope.metadata.name !== PROBE &&
      artifact.envelope.metadata.namespace !== undefined &&
      artifact.envelope.metadata.version !== undefined,
  );
  if (target === undefined) {
    return {
      namespace: "compliance",
      edge: { rel_type: "depends_on", to: "compliance/skill/absent@1.0.0" },
    };
  }
  const { namespace, name, version } = target.envelope.metadata as {
    namespace: string;
    name: string;
    version: string;
  };
  return {
    namespace,
    edge: { rel_type: "depends_on", to: `${namespace}/${target.kind}/${name}@${version}` },
  };
}

/** Publishes a skill, or an agent, with one edge, and reads it back with the edge intact. */
async function checkRelationships(
  adapter: SourceAdapter,
  handle: SourceHandle,
  listed: readonly Artifact[],
): Promise<void> {
  const flags = advertisedCapabilities(adapter.capabilities);
  if (!flags.relationships) return;
  if (!flags.publish || handle.publish === undefined) {
    throw new ComplianceError(`${adapter.id} declared relationships but does not publish.`);
  }
  const kinds = adapter.publishKinds ?? adapter.artifactKinds;
  const kind = (["skill", "agent"] as const).find((each) => kinds.includes(each));
  if (kind === undefined) {
    throw new ComplianceError(
      `${adapter.id} declared relationships but publishes no skill or agent to check them with.`,
    );
  }
  const path = kind === "skill" ? "SKILL.md" : flags.fileSpec ? "AGENT.md" : `${PROBE}.md`;
  const content = new TextEncoder().encode(
    `---\nname: ${PROBE}\ndescription: ${PROBE_DESCRIPTION}\n---\n`,
  );
  const { namespace, edge } = probeEdge(listed);
  const relationships = [edge];
  const metadata = { name: PROBE, description: PROBE_DESCRIPTION };
  const contentId = contentDigest(
    buildEnvelope({
      kind,
      metadata,
      files: [describeFile(path, sha256(content), content.byteLength)],
      relationships,
    }),
  );
  await handle.publish(
    [
      {
        ...metadata,
        kind,
        namespace,
        version: "1.0.0",
        contentId,
        files: [{ path, content, executable: false }],
        relationships,
      },
    ],
    {},
  );
  const found = await handle.resolve([{ name: PROBE, namespace, kind }]);
  const [published] = found.artifacts;
  if (published === undefined) {
    throw new ComplianceError(`${adapter.id} published ${PROBE} but resolve did not return it.`);
  }
  if (canonicalize(published.envelope.relationships ?? []) !== canonicalize(relationships)) {
    throw new ComplianceError(
      `${adapter.id} declared relationships but ${PROBE} came back without the edge it was published with.`,
    );
  }
}

/** What the folder agent check publishes, beside its `AGENT.md`. */
const FOLDER_PROBE = `${PROBE}-folder`;
const FOLDER_FILE = "notes/probe.md";

/** Publishes an agent with a file beyond its `AGENT.md`, and reads both back, byte for byte. */
async function checkAgentFolders(adapter: SourceAdapter, handle: SourceHandle): Promise<void> {
  const flags = advertisedCapabilities(adapter.capabilities);
  if (!flags.agentFolders) return;
  if (!flags.publish || handle.publish === undefined) {
    throw new ComplianceError(`${adapter.id} declared agentFolders but does not publish.`);
  }
  if (!(adapter.publishKinds ?? adapter.artifactKinds).includes("agent")) {
    throw new ComplianceError(`${adapter.id} declared agentFolders but publishes no agent.`);
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  const files = [
    {
      path: "AGENT.md",
      content: encode(
        `---\nname: ${FOLDER_PROBE}\ndescription: ${PROBE_DESCRIPTION}\n---\nCheck.\n`,
      ),
      executable: false,
    },
    { path: FOLDER_FILE, content: encode("Kept beside AGENT.md.\n"), executable: false },
  ];
  const metadata = { name: FOLDER_PROBE, description: PROBE_DESCRIPTION };
  const contentId = contentDigest(
    buildEnvelope({
      kind: "agent",
      metadata,
      files: files.map((file) =>
        describeFile(file.path, sha256(file.content), file.content.byteLength),
      ),
    }),
  );
  const namespace = "compliance";
  await handle.publish(
    [{ ...metadata, kind: "agent", namespace, version: "1.0.0", contentId, files }],
    {},
  );
  const found = await handle.resolve([{ name: FOLDER_PROBE, namespace, kind: "agent" }]);
  const published = found.artifacts.find(
    (artifact) => artifact.envelope.metadata.name === FOLDER_PROBE,
  );
  const served = published?.files.find((file) => file.path === FOLDER_FILE);
  if (published === undefined || served === undefined) {
    throw new ComplianceError(
      `${adapter.id} declared agentFolders but ${FOLDER_PROBE} came back without ${FOLDER_FILE}.`,
    );
  }
  const bytes = await handle.fetch(published, served);
  if (sha256(bytes) !== sha256(files[1]?.content ?? new Uint8Array())) {
    throw new ComplianceError(
      `${adapter.id} served ${FOLDER_PROBE}'s ${FOLDER_FILE} with other bytes.`,
    );
  }
}

function checkDeclaration(adapter: SourceAdapter): void {
  if (!ADAPTER_ID.test(adapter.id)) {
    throw new ComplianceError(`Adapter id ${JSON.stringify(adapter.id)} is not ${ADAPTER_ID}.`);
  }
  if (adapter.protocol !== ADAPTER_PROTOCOL) {
    throw new ComplianceError(`${adapter.id} implements protocol ${adapter.protocol}.`);
  }
  const unserved = (adapter.publishKinds ?? []).filter(
    (kind) => !adapter.artifactKinds.includes(kind),
  );
  if (unserved.length > 0) {
    throw new ComplianceError(`${adapter.id} publishes ${unserved.join(", ")} it does not serve.`);
  }
}

/**
 * The checks an adapter's own test runs: its declaration, then a live handle against a real
 * registry. An adapter that declares `relationships` also publishes `aireg-compliance` there, and
 * one that declares `agentFolders` publishes the agent `aireg-compliance-folder`.
 */
export async function assertAdapterCompliance(
  adapter: SourceAdapter,
  context: SourceContext,
): Promise<void> {
  checkDeclaration(adapter);
  const handle = await adapter.connect(context);
  try {
    checkCapabilities(adapter, handle);
    const listed = await checkListing(adapter, handle);
    await checkRelationships(adapter, handle, listed);
    await checkAgentFolders(adapter, handle);
  } finally {
    await handle.close();
  }
}
