import { describe, expect, test, vi } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { sha256Hex } from "#core/fs/hash.ts";
import { downloadArtifact, fetchOriginBytes } from "./fetch.ts";

const url = "https://releases.example.test/manifest.json";
function streaming(headers?: Record<string, string>) {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls > 10) controller.close();
        else controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, headers === undefined ? {} : { headers });
  return { response, cancel, pulls: () => pulls };
}

describe("bounded release downloads", () => {
  test.each([undefined, "1", "invalid"])(
    "cancels an oversized body with content length %s",
    async (declared) => {
      const stream = streaming(declared === undefined ? undefined : { "content-length": declared });
      await expect(
        fetchOriginBytes(url, 3, async () => stream.response, undefined),
      ).rejects.toMatchObject({ code: ErrorCode.Integrity });
      expect(stream.pulls()).toBe(2);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(stream.response.body?.locked).toBe(false);
    },
  );
  test("cancels a declared oversized body without reading it", async () => {
    const stream = streaming({ "content-length": "30" });
    await expect(
      fetchOriginBytes(url, 3, async () => stream.response, undefined),
    ).rejects.toMatchObject({
      code: ErrorCode.Integrity,
    });
    expect(stream.pulls()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });
  test("accepts a body exactly at the limit, refusing redirects and passing the signal", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    const signal = new AbortController().signal;
    expect(await fetchOriginBytes(url, 3, fetcher, signal)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "error", signal }),
    );
  });
  test.each([
    ["no length", undefined],
    ["its exact length", "20"],
    ["a length shorter than the body, as a compressed one is", "4"],
  ])("reads a body in many chunks whole, declaring %s", async (_label, declared) => {
    const stream = streaming(declared === undefined ? undefined : { "content-length": declared });
    const bytes = await fetchOriginBytes(url, 20, async () => stream.response, undefined);
    expect(bytes).toEqual(new Uint8Array(20).map((_, index) => (index % 2 === 0 ? 1 : 2)));
    expect(bytes.buffer.byteLength).toBe(20);
  });
  test("cancels and unlocks a response aborted during a pending read", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            started();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    const pending = fetchOriginBytes(url, 3, async () => response, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reading;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  test("refuses a download of the wrong size or checksum", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const plan = {
      kind: "manifest" as const,
      url,
      name: "synthetic",
      size: 3,
      sha256: sha256Hex(bytes),
    };
    expect(await downloadArtifact(plan, async () => new Response(bytes))).toEqual(bytes);
    await expect(
      downloadArtifact(plan, async () => new Response(new Uint8Array([1]))),
    ).rejects.toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/wrong size/),
    });
    await expect(
      downloadArtifact({ ...plan, sha256: "0".repeat(64) }, async () => new Response(bytes)),
    ).rejects.toMatchObject({
      code: ErrorCode.Integrity,
      message: expect.stringMatching(/failed its checksum/),
    });
  });
});
