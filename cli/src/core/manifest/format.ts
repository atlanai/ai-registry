import { stringify } from "yaml";
import { isRecord } from "#adapter/fields.ts";
import { withoutUndefined } from "#core/fields.ts";
import { NAME } from "#core/product.ts";
import { formatAddress, formatRef } from "#core/ref.ts";
import { earlierId } from "#core/target/ids.ts";
import { resolveTargets } from "#core/target/table.ts";
import { type Export, LEGACY_TARGETS_KEY, type Manifest, type RegistrySource } from "./model.ts";

/** Block style only, so diffs stay line-oriented. */
export const FORMAT = {
  indent: 2,
  defaultStringType: "PLAIN",
  lineWidth: 0,
  flowCollectionPadding: false,
} as const;

/** The manifest as plain data, keyed in the order a new file is written in. */
export function manifestData(manifest: Manifest): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (manifest.schema !== undefined) doc.$schema = manifest.schema;
  if (manifest.name !== undefined) doc.name = manifest.name;
  if (manifest.description !== undefined) doc.description = manifest.description;
  if (manifest.engine !== undefined) doc.engines = { [NAME]: manifest.engine };
  if (manifest.targets.length > 0) doc.targets = manifest.targets;

  const registries: Record<string, unknown> = {};
  for (const alias of Object.keys(manifest.registries).sort()) {
    const source = manifest.registries[alias] as RegistrySource;
    const { ref, path, layout, ...rest } = source.config;
    const written = withoutUndefined({
      source: source.location,
      adapter: source.adapter,
      ref,
      path,
      layout,
      config: Object.keys(rest).length === 0 ? undefined : rest,
    });
    registries[alias] = Object.keys(written).length === 1 ? source.location : written;
  }
  doc.registries = registries;
  doc.artifacts = manifest.artifacts.map((ref) => {
    const written = withoutUndefined({
      ref: formatRef(ref),
      as: ref.localName,
      exclude: ref.exclude,
      targets: ref.targets,
      copy: ref.copy === true ? true : undefined,
      trust: ref.trust?.length ? [...ref.trust].sort() : undefined,
    });
    return Object.keys(written).length === 1 ? formatRef(ref) : written;
  });
  if (manifest.exports.length > 0) doc.exports = manifest.exports.map(exportData);
  if (manifest.publish !== undefined) doc.publish = { to: manifest.publish.to };
  return doc;
}

function exportData(entry: Export): unknown {
  const written = withoutUndefined({
    path: entry.path,
    kind: entry.kind,
    version: entry.version,
    depends_on:
      entry.dependsOn.length === 0
        ? undefined
        : entry.dependsOn.map((need) =>
            need.type === "local" ? `./${need.path}` : formatAddress(need.ref),
          ),
    publish: entry.publish,
    exclude: entry.exclude,
    ignore: entry.ignore,
    include: entry.include?.map((file) => (file.from === file.as ? file.from : { ...file })),
  });
  return Object.keys(written).length === 1 ? entry.path : written;
}

/** `targets:` under its earlier name, each id as aireg 0.1 knew it, so that version reads it. */
export function inEarlierNames(data: Record<string, unknown>): Record<string, unknown> {
  const table = resolveTargets();
  const rename = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(entry.targets)) return entry;
    const renamed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "targets") renamed[key] = value;
      else renamed[LEGACY_TARGETS_KEY] = entry.targets.map((id) => earlierId(table, String(id)));
    }
    return renamed;
  };
  const out = rename(data);
  if (Array.isArray(out.artifacts)) {
    out.artifacts = out.artifacts.map((ref) => (isRecord(ref) ? rename(ref) : ref));
  }
  return out;
}

export function formatManifest(manifest: Manifest): string {
  return stringify(inEarlierNames(manifestData(manifest)), FORMAT);
}
