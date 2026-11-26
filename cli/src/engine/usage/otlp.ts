import { createHash, createHmac } from "node:crypto";
import type { RegistryIdentity, RegistryUsage } from "#adapter/index.ts";
import { NAME } from "#core/product.ts";
import { VERSION } from "#core/version.ts";
import type { Run } from "./model.ts";
import type { KeyValue, Span, TraceRequest } from "./protobuf.ts";

/** File spec section 14.3. */
export const RUN_SPAN = "registry.artifact.run";
/** OTLP's `SPAN_KIND_INTERNAL`. */
const INTERNAL = 1;
const PRECISION_MS: Readonly<Record<RegistryUsage["timePrecision"], number>> = {
  second: 1000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** How a person is named to one registry: the name they chose, or a pseudonym only for it. */
export function reporterFor(
  usage: RegistryUsage,
  registryKey: string,
  chosen: string | undefined,
  key: Buffer,
): string {
  if (usage.reporter === "name" && chosen !== undefined) return chosen;
  // Keyed per registry, so two registries cannot match one person's pseudonyms.
  return `r-${createHmac("sha256", key).update(registryKey).digest("hex").slice(0, 16)}`;
}

/** One OTLP `ExportTraceServiceRequest`: a span per run, as section 14.3 describes it. */
export function traceRequest(
  runs: readonly Run[],
  identity: RegistryIdentity & { usage: RegistryUsage },
  reporter: string,
): TraceRequest {
  const resource: KeyValue[] = [
    text("registry.usage.reporter", reporter),
    text("registry.name", identity.name),
    ...(identity.url === undefined ? [] : [text("registry.url", identity.url)]),
    text("service.name", NAME),
    text("service.version", VERSION),
  ];
  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            scope: { name: NAME, version: VERSION },
            spans: runs.map((run) => span(run, identity.usage.timePrecision)),
          },
        ],
      },
    ],
  };
}

function span(run: Run, precision: RegistryUsage["timePrecision"]): Span {
  const step = PRECISION_MS[precision];
  const at = `${BigInt(Math.floor(Date.parse(run.at) / step) * step) * 1_000_000n}`;
  // Derived from the run id, so a run sent twice is the same span.
  const ids = createHash("sha256").update(run.id).digest("hex");
  return {
    traceId: ids.slice(0, 32),
    spanId: ids.slice(32, 48),
    name: RUN_SPAN,
    kind: INTERNAL,
    startTimeUnixNano: at,
    endTimeUnixNano: at,
    attributes: [
      text("registry.artifact.ref", run.ref),
      ...(run.digest === undefined ? [] : [text("registry.artifact.digest", run.digest)]),
      text("registry.run.id", run.id),
      text("registry.run.trigger", run.trigger),
      text("registry.target", run.target),
    ],
  };
}

function text(key: string, value: string): KeyValue {
  return { key, value: { stringValue: value } };
}
