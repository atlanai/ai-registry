/**
 * The OTLP `ExportTraceServiceRequest` in protobuf's binary wire format, which every OTLP over
 * HTTP receiver must accept, written by hand for the few fields a run span uses so aireg takes on
 * no protobuf library. Field numbers are those of opentelemetry/proto/trace/v1/trace.proto,
 * common/v1/common.proto and collector/trace/v1/trace_service.proto.
 */

type Value = { stringValue: string } | { boolValue: boolean };

export interface KeyValue {
  key: string;
  value: Value;
}

export interface Span {
  /** 32 hex characters. */
  traceId: string;
  /** 16 hex characters. */
  spanId: string;
  name: string;
  kind: number;
  /** Nanoseconds since the Unix epoch, as decimal text, as OTLP JSON writes them. */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
}

export interface TraceRequest {
  resourceSpans: {
    resource: { attributes: KeyValue[] };
    scopeSpans: { scope: { name: string; version: string }; spans: Span[] }[];
  }[];
}

const VARINT = 0;
const FIXED64 = 1;
const BYTES = 2;

export function encodeTraceRequest(request: TraceRequest): Uint8Array {
  return message(request.resourceSpans.map((resource) => field(1, resourceSpans(resource))));
}

function resourceSpans(value: TraceRequest["resourceSpans"][number]): Uint8Array {
  return message([
    field(1, message(value.resource.attributes.map((attribute) => field(1, keyValue(attribute))))),
    ...value.scopeSpans.map((scope) => field(2, scopeSpans(scope))),
  ]);
}

function scopeSpans(
  value: TraceRequest["resourceSpans"][number]["scopeSpans"][number],
): Uint8Array {
  return message([
    field(1, message([field(1, text(value.scope.name)), field(2, text(value.scope.version))])),
    ...value.spans.map((item) => field(2, span(item))),
  ]);
}

function span(value: Span): Uint8Array {
  return message([
    field(1, hex(value.traceId)),
    field(2, hex(value.spanId)),
    field(5, text(value.name)),
    concat([tag(6, VARINT), varint(BigInt(value.kind))]),
    concat([tag(7, FIXED64), fixed64(BigInt(value.startTimeUnixNano))]),
    concat([tag(8, FIXED64), fixed64(BigInt(value.endTimeUnixNano))]),
    ...value.attributes.map((attribute) => field(9, keyValue(attribute))),
  ]);
}

function keyValue(value: KeyValue): Uint8Array {
  const any =
    "stringValue" in value.value
      ? field(1, text(value.value.stringValue))
      : concat([tag(2, VARINT), varint(value.value.boolValue ? 1n : 0n)]);
  return message([field(1, text(value.key)), field(2, any)]);
}

/** A length-delimited field: its tag, its length, its bytes. */
function field(number: number, bytes: Uint8Array): Uint8Array {
  return concat([tag(number, BYTES), varint(BigInt(bytes.length)), bytes]);
}

function tag(number: number, wire: number): Uint8Array {
  return varint(BigInt((number << 3) | wire));
}

function varint(value: bigint): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    out.push(byte);
  } while (rest > 0n);
  return Uint8Array.from(out);
}

function fixed64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function message(parts: readonly Uint8Array[]): Uint8Array {
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
