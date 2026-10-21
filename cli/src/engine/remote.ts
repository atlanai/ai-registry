import { credentialFor } from "#accounts/credentials.ts";
import { AccountService } from "#accounts/service.ts";
import type { PublishInput, SourceHandle, UnpublishInput } from "#adapter/index.ts";
import { bumpVersion } from "#adapter/semver.ts";
import { declaredLayout } from "#core/adapter/registry.ts";
import { connectSource } from "#core/adapter/source.ts";
import { readOnlyLayout } from "#core/adapter/writable.ts";
import type { Account } from "#core/config/model.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { offerFrom } from "#core/filespec/write/offer.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { artifactPath, copyLeaf, type Roots } from "#core/store/paths.ts";
import type { SyncOperation } from "#core/sync/policy.ts";
import type { Scan } from "./scan.ts";

/** Sync sends the next version of what the lock pinned, or a first one. */
async function publishInput(
  path: string,
  name: string,
  kind: PublishInput["kind"],
  previous?: { id: string; name: string; namespace?: string; version?: string },
  description?: string,
): Promise<PublishInput> {
  const { input } = await offerFrom(path, {
    name: previous?.name ?? name,
    kind,
    namespace: previous?.namespace,
    version: bumpVersion(previous?.version),
    id: previous?.id,
    description,
  });
  return input;
}

export interface RemoteMutationHooks {
  event(step: string, artifact?: string): void;
  /** One artifact the source refused while the rest of the batch landed. */
  failed?(artifact: string, error: unknown): void;
  /** One artifact the source already holds but does not serve yet. */
  held?(artifact: string, reason: string): void;
  /** One artifact about to be handed to the adapter, so a refusal can only land on what was sent. */
  sent?(artifact: string): void;
}

export interface RemoteMutationResult {
  published: Set<string>;
  archived: Set<string>;
}

const partials = new WeakMap<object, RemoteMutationResult>();

/**
 * What a mutation had already completed when it threw. A caller that writes to
 * disk needs this: an archive can land before the publish that follows it fails.
 */
export function partialMutation(error: unknown): RemoteMutationResult | undefined {
  return typeof error === "object" && error !== null ? partials.get(error) : undefined;
}

async function openForMutation(
  roots: Pick<Roots, "scope" | "cwd">,
  source: RegistrySource,
  account: Account,
  signal: AbortSignal,
) {
  const resolved = await new AccountService().resolve(account, roots.scope, roots.cwd);
  const credential = await credentialFor(
    account.registry,
    resolved.source,
    resolved.location,
    signal,
  );
  return connectSource(
    {
      alias: account.registry,
      location: resolved.location,
      declared: resolved.source.location,
      adapter: resolved.source.adapter,
      config: source.config,
      layout: declaredLayout(source.config),
    },
    { signal, credential },
  );
}

interface StagedMutations {
  archiving: UnpublishInput[];
  publishing: PublishInput[];
  /** Kept apart from the result, which must describe only what landed. */
  archivingNames: Set<string>;
  publishingNames: Set<string>;
}

async function stageMutations(
  scan: Scan,
  operations: ReadonlyMap<string, SyncOperation>,
  hooks: RemoteMutationHooks,
  /** Where the account publishes new work. */
  namespace: string | undefined,
): Promise<StagedMutations> {
  const staged: StagedMutations = {
    archiving: [],
    publishing: [],
    archivingNames: new Set<string>(),
    publishingNames: new Set<string>(),
  };

  for (const item of scan.items) {
    const next = operations.get(item.name);
    const previous = scan.pinned.artifacts[item.name];
    if (next === "archive" && previous !== undefined) {
      hooks.event("archiving", item.name);
      if (previous.id !== undefined) staged.archiving.push({ id: previous.id, kind: item.kind });
      staged.archivingNames.add(item.name);
    }
    if (next === "publish") {
      // Installed or authored alike: a policy that publishes was opted into, and
      // whether the edit may land is the registry's call, not this client's.
      if (previous === undefined) continue;
      hooks.event("publishing", item.name);
      const path = artifactPath(
        scan.roots,
        previous.registry,
        previous.namespace,
        item.kind,
        copyLeaf(item.name, previous.name),
        previous.address ?? "",
      );
      staged.publishing.push(
        await publishInput(path, item.name, item.kind, {
          id: previous.id ?? "",
          name: previous.name,
          ...(previous.namespace === undefined ? {} : { namespace: previous.namespace }),
          ...(previous.version === undefined ? {} : { version: previous.version }),
        }),
      );
      staged.publishingNames.add(item.name);
    }
  }

  for (const candidate of scan.local) {
    if (operations.get(candidate.name) !== "publish") continue;
    hooks.event("publishing", candidate.name);
    staged.publishing.push(
      await publishInput(
        candidate.from,
        candidate.name,
        candidate.kind,
        // New local work has no row yet, so the account's own corner of the
        // registry is where it goes.
        namespace === undefined ? undefined : { id: "", name: candidate.name, namespace },
        candidate.description,
      ),
    );
    staged.publishingNames.add(candidate.name);
  }

  return staged;
}

/**
 * Records what landed and reports each refusal on its artifact, then rethrows the first.
 * An adapter that ignores `partial` throws instead, and the batch fails as a whole.
 */
export async function publishPartial(
  publish: NonNullable<SourceHandle["publish"]>,
  inputs: readonly PublishInput[],
  names: readonly string[],
  result: RemoteMutationResult,
  hooks: RemoteMutationHooks,
): Promise<void> {
  for (const [at, input] of inputs.entries()) hooks.sent?.(names[at] ?? input.name);
  const published = await publish(inputs, { partial: true });
  const refused = new Map((published.refused ?? []).map((item) => [item.index, item.error]));
  const held = new Map((published.held ?? []).map((item) => [item.index, item.reason]));
  for (const [at, input] of inputs.entries()) {
    const name = names[at] ?? input.name;
    const error = refused.get(at);
    if (error !== undefined) {
      hooks.failed?.(name, error);
      continue;
    }
    const reason = held.get(at);
    if (reason !== undefined) {
      hooks.held?.(name, reason);
      continue;
    }
    result.published.add(name);
    hooks.event("published", name);
  }
  const first = published.refused?.[0]?.error;
  if (first !== undefined) throw first;
}

/** A registry whose adapter reads but never publishes. */
export function readOnly(alias: string, displayName: string): AiregError {
  return new AiregError(`${alias} does not accept published artifacts.`, {
    code: ErrorCode.Usage,
    hint: `aireg can read a ${displayName} registry but cannot publish to one.`,
  });
}

/** Archives in one call; the error is returned so the publishes still go out. */
async function archive(
  { adapter, handle }: Awaited<ReturnType<typeof openForMutation>>,
  registry: string,
  archiving: StagedMutations["archiving"],
  names: Iterable<string>,
  result: RemoteMutationResult,
  hooks: RemoteMutationHooks,
): Promise<unknown> {
  if (handle.unpublish === undefined) {
    throw new AiregError(`${registry} does not archive artifacts.`, {
      code: ErrorCode.Usage,
      hint: `aireg can read a ${adapter.displayName} registry but cannot archive in one.`,
    });
  }
  const sent = [...names];
  for (const name of sent) hooks.sent?.(name);
  try {
    await handle.unpublish(archiving);
  } catch (error) {
    for (const name of sent) hooks.failed?.(name, error);
    return error;
  }
  for (const name of sent) result.archived.add(name);
  for (const name of result.archived) hooks.event("archived", name);
  return undefined;
}

export async function mutateRemote(
  scan: Scan,
  /** The run's own scope, whose manifest declares the registry it sends to. */
  roots: Pick<Roots, "scope" | "cwd">,
  source: RegistrySource,
  account: Account,
  operations: ReadonlyMap<string, SyncOperation>,
  signal: AbortSignal,
  hooks: RemoteMutationHooks,
): Promise<RemoteMutationResult> {
  const result = { published: new Set<string>(), archived: new Set<string>() };
  if (![...operations.values()].some((item) => item === "publish" || item === "archive")) {
    return result;
  }

  const opened = await openForMutation(roots, source, account, signal);
  const { adapter, handle } = opened;
  try {
    const { archiving, publishing, archivingNames, publishingNames } = await stageMutations(
      scan,
      operations,
      hooks,
      account.defaultNamespace,
    );

    // A refused archive is reported on its artifacts and must not hold back the publishes.
    let refused =
      archiving.length === 0
        ? undefined
        : await archive(opened, account.registry, archiving, archivingNames, result, hooks);
    if (publishing.length > 0) {
      const laidOut = readOnlyLayout(account.registry, source.config);
      if (laidOut !== undefined) throw laidOut;
      if (handle.publish === undefined) {
        throw readOnly(account.registry, adapter.displayName);
      }
      try {
        await publishPartial(handle.publish, publishing, [...publishingNames], result, hooks);
      } catch (error) {
        refused ??= error;
      }
    }
    if (refused !== undefined) throw refused;
    return result;
  } catch (error) {
    if (typeof error === "object" && error !== null) partials.set(error, result);
    throw error;
  } finally {
    await handle.close();
  }
}
