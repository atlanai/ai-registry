import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isArtifactName, isKindSegment, isNamespace, isVersion } from "#adapter/filespec/names.ts";
import {
  type ArtifactKind,
  buildEnvelope,
  contentDigest,
  type PublishInput,
  type PublishRelationship,
  sha256,
  type UploadFile,
} from "#adapter/index.ts";
import { describeFile } from "#adapter/spec/envelope.ts";
import { quoted } from "#adapter/text.ts";
import { frontmatterRecord, ownDescription } from "#core/catalog/frontmatter.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { authored, isDirectory, refusal } from "#core/fs/tree.ts";
import { AGENT_ENTRY, SKILL_ENTRY } from "#core/kinds.ts";
import { CONCURRENCY, limiter } from "#core/limit.ts";
import { envelopeSpec } from "./kinds.ts";

const reading = limiter(CONCURRENCY);

/** Where one artifact goes: the caller decides the name, namespace and version. */
export interface OfferTarget {
  name: string;
  kind: ArtifactKind;
  namespace?: string | undefined;
  version: string;
  /** The source's own address for it, when it already holds it. */
  id?: string | undefined;
  description?: string | undefined;
  /** Send an agent file as the `AGENT.md` a registry folder holds, rather than as `<name>.md`. */
  asAgentDocument?: boolean | undefined;
  /** The edges the version carries, such as its `depends_on`. Absent, it carries none. */
  relationships?: readonly PublishRelationship[] | undefined;
  /** Selected files in publication order, mapped to their destination paths. */
  files?: readonly { from: string; as: string }[] | undefined;
}

const REL_TYPE = /^[a-z][a-z0-9_]*$/;

function edgeProblem(edge: PublishRelationship): string | undefined {
  const { rel_type: type, to } = edge;
  if (!REL_TYPE.test(type)) {
    return `has a relationship of type ${quoted(type)}, which is not lowercase letters, digits and underscores`;
  }
  const at = to.lastIndexOf("@");
  const [namespace, kind, name, ...rest] = to.slice(0, Math.max(0, at)).split("/");
  if (
    at < 1 ||
    rest.length > 0 ||
    !isNamespace(namespace ?? "") ||
    !isKindSegment(kind ?? "") ||
    !isArtifactName(name ?? "") ||
    !isVersion(to.slice(at + 1))
  ) {
    return `has a ${type} edge to ${quoted(to)}, which is not a namespace/kind/name@version`;
  }
  return undefined;
}

function edgesOf(target: OfferTarget): PublishRelationship[] {
  return (target.relationships ?? []).map((edge) => {
    const problem = edgeProblem(edge);
    if (problem !== undefined) {
      throw new AiregError(`${target.name} ${problem}.`, { code: ErrorCode.Invalid });
    }
    return {
      rel_type: edge.rel_type,
      to: edge.to,
    };
  });
}

/** A harness's agent file may omit the name a registry agent requires; the artifact's name supplies it. */
function agentDocument(content: Buffer, target: OfferTarget): UploadFile {
  const text = content.toString("utf8");
  const record = frontmatterRecord(text);
  const fence = /^---\r?\n[\s\S]*?\r?\n(?=---\r?(?:\n|$))/.exec(text);
  if (record === undefined || fence === null || record.name !== undefined) {
    return { path: AGENT_ENTRY, content, executable: false };
  }
  const filled = `${fence[0]}name: ${target.name}\n${text.slice(fence[0].length)}`;
  return { path: AGENT_ENTRY, content: Buffer.from(filled, "utf8"), executable: false };
}

function firstOf<T extends { path: string }>(kind: ArtifactKind, files: readonly T[]): T[] {
  const entry = kind === "agent" ? AGENT_ENTRY : SKILL_ENTRY;
  return [
    ...files.filter((file) => file.path === entry),
    ...files.filter((file) => file.path !== entry),
  ];
}

async function uploadFiles(path: string, target: OfferTarget): Promise<UploadFile[]> {
  if (!(await isDirectory(path))) {
    const content = await readFile(path);
    if (target.kind === "agent" && target.asAgentDocument === true) {
      return [agentDocument(content, target)];
    }
    return [{ path: basename(path), content, executable: false }];
  }
  const all = await authored(path);

  const only =
    target.files === undefined
      ? undefined
      : new Map(target.files.map((file) => [file.from, file.as]));
  const [refused] = all.irregular.filter((entry) => only === undefined || only.has(entry.path));
  if (refused !== undefined) {
    throw new AiregError(`${basename(path)}/${refused.path} ${refusal(refused)}.`, {
      code: ErrorCode.Invalid,
    });
  }
  const byPath = new Map(all.files.map((entry) => [entry.path, entry]));
  const files =
    target.files === undefined
      ? firstOf(target.kind, all.files).map((entry) => ({ entry, as: entry.path }))
      : target.files.flatMap(({ from, as }) => {
          const entry = byPath.get(from);
          return entry === undefined ? [] : [{ entry, as }];
        });
  // Bounded, so a tree of thousands of files neither runs out of descriptors nor
  // has every read in flight at once.
  return Promise.all(
    files.map(({ entry, as }) =>
      reading(async () => ({
        path: as,
        content: await readFile(join(path, entry.path)),
        executable: entry.executable,
      })),
    ),
  );
}

/** One artifact on disk as an adapter takes it, described the way an adapter reads one. */
export async function offerFrom(
  path: string,
  target: OfferTarget,
): Promise<{
  input: PublishInput;
  digests: string[];
  /** Each file by the path it is stored at, with its digest, in the order it is sent. */
  files: { path: string; digest: string }[];
}> {
  const relationships = edgesOf(target);
  const files = await uploadFiles(path, target);
  const bytes = new Map(files.map((file) => [file.path, file.content]));
  // Described exactly as a registry describes what it holds, so publishing a
  // tree and then resolving it again yield the one content identity.
  const descriptors = files.map((file) =>
    describeFile(file.path, sha256(file.content), file.content.byteLength),
  );
  const description = target.description ?? ownDescription(bytes, target.name);
  // An explicitly supplied native agent file is its entry, even when the harness
  // names it reviewer.md. Registry directories still use only declared entries.
  const [entry] = files;
  const nativeAgent = target.kind === "agent" && path.endsWith(".md") && !(await isDirectory(path));
  const spec =
    nativeAgent && entry !== undefined
      ? (frontmatterRecord(Buffer.from(entry.content).toString("utf8")) ?? {})
      : envelopeSpec(target.kind, bytes, undefined, target.name);
  const input: PublishInput = {
    ...(target.id === undefined || target.id === "" ? {} : { id: target.id }),
    name: target.name,
    kind: target.kind,
    ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
    version: target.version,
    ...(description === undefined ? {} : { description }),
    contentId: contentDigest(
      buildEnvelope({
        kind: target.kind,
        metadata: { name: target.name, ...(description === undefined ? {} : { description }) },
        files: descriptors,
        spec,
        // Part of the content identity: a version whose only change is an edge is a new one.
        relationships,
      }),
    ),
    spec,
    files,
    ...(relationships.length === 0 ? {} : { relationships }),
  };
  return {
    input,
    digests: descriptors.map((file) => file.digest).sort(),
    files: descriptors.map(({ path, digest }) => ({ path, digest })),
  };
}
