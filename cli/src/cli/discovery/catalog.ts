import { type CatalogReader, THIS_MACHINE } from "#cli/catalog/state.ts";
import { DiscoveryError } from "#core/discovery/gemini.ts";
import type { Skill } from "#core/discovery/retrieval.ts";

/** The same catalog and identity rules for CLI and UI; no view or server dependency. */
export async function discoverySkills(reader: CatalogReader): Promise<Skill[]> {
  const page = await reader.read();
  if (page.registries.some((registry) => registry.loading)) {
    throw new DiscoveryError("Registries are still loading. Retry when the catalog is ready.");
  }
  return [
    ...new Map(
      page.artifacts
        .filter((s) => s.kind === "skill")
        .map((s) => [
          s.key,
          {
            key: s.key,
            name: s.name,
            registry: s.registry || THIS_MACHINE,
            namespace: s.namespace,
            description: s.description ?? "",
            version: s.version ?? "",
            digest: s.digest || s.diskDigest || "",
          },
        ]),
    ).values(),
  ];
}
