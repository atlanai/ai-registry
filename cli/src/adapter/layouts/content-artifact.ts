import type { Artifact, FileRef } from "../contract.ts";
import { SpecError } from "../filespec/documents.ts";
import type { ArtifactKind } from "../kinds.ts";
import { sha256 } from "../spec/canonical.ts";
import { buildEnvelope, describeFile } from "../spec/envelope.ts";
import type { Tree } from "./tree.ts";

export interface ContentFile {
  /** POSIX, relative to the artifact. */
  path: string;
  /** POSIX, relative to the tree's root. */
  locator: string;
  executable: boolean;
}

export interface ContentInput {
  /** Stable while the artifact sits where it does, such as its folder in the source. */
  id: string;
  kind: ArtifactKind;
  name: string;
  description?: string | undefined;
  /** Kept outside the envelope, so it never changes the digest. */
  group?: string | undefined;
  files: readonly ContentFile[];
  /** Built from the files alone. */
  spec?: Record<string, unknown> | undefined;
}

/**
 * Nothing that varies by commit, clock, machine or path enters the envelope, so the same bytes
 * have the same digest wherever they are read.
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
