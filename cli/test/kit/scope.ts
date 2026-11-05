import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function manifestPath(dir: string): string {
  return join(dir, ".registry", "manifest.yml");
}

export function lockPath(dir: string): string {
  return join(dir, ".registry", "manifest.lock.yml");
}

/** Writes a project scope's manifest, creating `.registry/` first. */
export async function writeManifestIn(dir: string, text: string): Promise<void> {
  await mkdir(join(dir, ".registry"), { recursive: true });
  await writeFile(manifestPath(dir), text);
}

/** A manifest without its comment lines, whose examples name artifacts too. */
export function declared(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}
