import { isRecord, textOf } from "#adapter/fields.ts";
import { MCP_SERVER_ENTRY } from "#adapter/kinds.ts";
import type { KindManifest, SchemaNode } from "./kind-manifests.ts";

/**
 * What `new` fills in for an MCP server: the fields `server.json` requires, under the newest
 * schema version the kind takes, rather than the envelope's `spec`, which lifts two of them.
 */
export function serverSkeleton(manifest: KindManifest): SchemaNode {
  const versions = (manifest.$defs as Record<string, SchemaNode> | undefined)?.document?.properties
    ?.$schema?.enum;
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

/** The server's `title`, which a catalog shows as its display name. */
export function serverTitle(files: ReadonlyMap<string, Uint8Array>): string | undefined {
  const bytes = files.get(MCP_SERVER_ENTRY);
  const server = bytes === undefined ? undefined : parsed(new TextDecoder().decode(bytes));
  return isRecord(server) ? textOf(server.title) : undefined;
}

/** An MCP server's own `version`, which the artifact's version follows. */
export function serverVersion(
  manifest: KindManifest,
  files: ReadonlyMap<string, string>,
): string | undefined {
  if (manifest.title !== "mcp_server") return undefined;
  const server = parsed(files.get(MCP_SERVER_ENTRY) ?? "");
  return isRecord(server) ? textOf(server.version) : undefined;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
