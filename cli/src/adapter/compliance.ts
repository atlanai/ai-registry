import type { Artifact, SourceAdapter, SourceContext, SourceHandle } from "./contract.ts";
import { ADAPTER_ID, ADAPTER_PROTOCOL, advertisedCapabilities, canSignIn } from "./contract.ts";
import { sha256 } from "./spec/canonical.ts";

/** What `assertAdapterCompliance` throws, naming the rule the adapter broke. */
export class ComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceError";
  }
}

/** For an adapter's own tests: its declaration, then a live handle against a real registry. */
export async function assertAdapterCompliance(
  adapter: SourceAdapter,
  context: SourceContext,
): Promise<void> {
  checkDeclaration(adapter);
  const handle = await adapter.connect(context);
  try {
    checkCapabilities(adapter, handle);
    await checkListing(adapter, handle);
  } finally {
    await handle.close();
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

function checkCapabilities(adapter: SourceAdapter, handle: SourceHandle): void {
  const flags = advertisedCapabilities(adapter.capabilities);
  if (flags.publish && handle.publish === undefined) {
    throw new ComplianceError(`${adapter.id} declared publish but the handle has no publish.`);
  }
  for (const capability of ["relationships", "agentFolders"] as const) {
    if (flags[capability] && !flags.publish) {
      throw new ComplianceError(`${adapter.id} declared ${capability} but does not publish.`);
    }
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
