import type { Artifact, FileRef } from "../contract.ts";
import { SpecError } from "../filespec/documents.ts";
import type { ArtifactKind } from "../kinds.ts";
import { sha256 } from "../spec/canonical.ts";
import { buildEnvelope, describeFile } from "../spec/envelope.ts";
import type { Tree } from "./tree.ts";

/** One file an artifact is made of: where it sits in the artifact, and where in the source. */
export interface ContentFile {
  /** POSIX, relative to the artifact. */
  path: string;
  /** POSIX, relative to the tree's root. */
  locator: string;
  executable: boolean;
}

/** What a layout knows about an artifact before its files are read. */
export interface ContentInput {
  /** Stable for as long as the artifact sits where it does, such as its folder in the source. */
  id: string;
  kind: ArtifactKind;
  name: string;
  description?: string | undefined;
  /** The namespace it is listed under, outside the envelope so it never changes the digest. */
  group?: string | undefined;
  files: readonly ContentFile[];
  /** The kind's own document, built from the files alone. */
  spec?: Record<string, unknown> | undefined;
}

/**
 * An artifact whose identity is its content alone: kind, name, description, files and spec.
 * Nothing that varies by commit, clock, machine or path enters the envelope, so the same
 * bytes have the same digest wherever and whenever they are read.
 */
export async function contentArtifact(tree: Tree, input: ContentInput): Promise<Artifact> {
  const described = [];
  for (const file of input.files) {
    const bytes = await tree.read(file.locator);
    if (bytes === undefined) {
      throw new SpecError(`${file.locator} is missing.`, { path: file.locator, missing: true });
    }
    described.push(describeFile(file.path, sha256(bytes), bytes.byteLength));
  }
  const envelope = buildEnvelope({
    kind: input.kind,
    metadata: {
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    files: described,
    ...(input.spec === undefined ? {} : { spec: input.spec }),
  });
  const files: FileRef[] = input.files.map(({ path, locator, executable }) => ({
    path,
    locator,
    executable,
  }));
  return {
    id: input.id,
    kind: input.kind,
    envelope,
    ...(input.group === undefined ? {} : { group: input.group }),
    files,
  };
}
