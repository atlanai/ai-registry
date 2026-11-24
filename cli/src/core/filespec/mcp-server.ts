import type { KindManifest, SchemaNode } from "./kind-manifests.ts";

/**
 * What `new` fills in for an MCP server: the fields `server.json` requires, under the newest
 * schema version the kind takes, rather than the envelope's `spec`, which wraps the file.
 */
export function serverSkeleton(manifest: KindManifest): SchemaNode {
  const versions = manifest.properties?.server?.properties?.$schema?.enum;
  const newest = Array.isArray(versions)
    ? versions
        .filter((url): url is string => typeof url === "string")
        .sort()
        .at(-1)
    : undefined;
  return {
    type: "object",
    required: ["$schema", "name", "description", "version"],
    properties: {
      $schema: newest === undefined ? { type: "string" } : { type: "string", default: newest },
      name: { type: "string" },
      description: { type: "string" },
      version: { type: "string", default: "0.1.0" },
    },
  };
}
