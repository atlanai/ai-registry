import { describe, expect, test } from "vitest";
import { encodeTraceRequest, type TraceRequest } from "./protobuf.ts";

type Field = { number: number; value: bigint | Uint8Array };

/** A protobuf wire reader that knows no schema, so it checks the encoder independently. */
function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[at++] as number;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (at < bytes.length) {
    const tag = Number(varint());
    const wire = tag & 7;
    if (wire === 0) out.push({ number: tag >> 3, value: varint() });
    else if (wire === 1) {
      out.push({
        number: tag >> 3,
        value: new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true),
      });
      at += 8;
    } else {
      const length = Number(varint());
      out.push({ number: tag >> 3, value: bytes.subarray(at, at + length) });
      at += length;
    }
  }
  return out;
}

const one = (all: Field[], number: number) => all.filter((f) => f.number === number);
const bytesOf = (field: Field | undefined) => field?.value as Uint8Array;
const text = (field: Field | undefined) => new TextDecoder().decode(bytesOf(field));

const REQUEST: TraceRequest = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "registry.name", value: { stringValue: "acme" } }] },
      scopeSpans: [
        {
          scope: { name: "aireg", version: "0.2.0" },
          spans: [
            {
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: "0123456789abcdef",
              name: "registry.artifact.run",
              kind: 1,
              startTimeUnixNano: "1795561200000000000",
              endTimeUnixNano: "1795561200000000000",
              attributes: [
                { key: "registry.run.trigger", value: { stringValue: "model" } },
                { key: "registry.artifact.modified", value: { boolValue: true } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("encodeTraceRequest", () => {
  test("lays out the OTLP trace messages under their proto field numbers", () => {
    const [resourceSpans] = one(fields(encodeTraceRequest(REQUEST)), 1);
    const resourceFields = fields(bytesOf(resourceSpans));
    const [attribute] = one(fields(bytesOf(one(resourceFields, 1)[0])), 1);
    const keyValue = fields(bytesOf(attribute));
    expect(text(one(keyValue, 1)[0])).toBe("registry.name");
    expect(text(one(fields(bytesOf(one(keyValue, 2)[0])), 1)[0])).toBe("acme");

    const scopeSpans = fields(bytesOf(one(resourceFields, 2)[0]));
    const scope = fields(bytesOf(one(scopeSpans, 1)[0]));
    expect([text(one(scope, 1)[0]), text(one(scope, 2)[0])]).toEqual(["aireg", "0.2.0"]);

    const span = fields(bytesOf(one(scopeSpans, 2)[0]));
    expect(Buffer.from(bytesOf(one(span, 1)[0])).toString("hex")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(Buffer.from(bytesOf(one(span, 2)[0])).toString("hex")).toBe("0123456789abcdef");
    expect(text(one(span, 5)[0])).toBe("registry.artifact.run");
    expect(one(span, 6)[0]?.value).toBe(1n);
    expect(one(span, 7)[0]?.value).toBe(1795561200000000000n);
    expect(one(span, 8)[0]?.value).toBe(1795561200000000000n);

    const [trigger, modified] = one(span, 9).map((field) => fields(bytesOf(field)));
    expect(text(one(fields(bytesOf(one(trigger ?? [], 2)[0])), 1)[0])).toBe("model");
    expect(one(fields(bytesOf(one(modified ?? [], 2)[0])), 2)[0]?.value).toBe(1n);
  });
});
