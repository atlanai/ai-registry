import { describe, expect, test, vi } from "vitest";
import type { Operations } from "./operations.ts";
import type { PageReader } from "./page-state.ts";
import { dispatch, REFUSED } from "./rpc.ts";

function served() {
  const operations = {
    plan: vi.fn(async () => ({ planId: "p" })),
    apply: vi.fn(() => ({ runId: "r", command: "" })),
    cancel: vi.fn(() => ({ cancelled: true })),
  };
  return {
    operations,
    served: { reader: {} as PageReader, operations: operations as unknown as Operations },
  };
}

const call = (method: string, params?: unknown, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("a call the page makes", () => {
  test("is JSON-RPC 2.0 with a numeric id and a known method", async () => {
    const { served: s } = served();
    expect(await dispatch("{", s)).toMatchObject({ error: { code: -32700 } });
    expect(await dispatch("[]", s)).toMatchObject({ error: { code: -32600 } });
    expect(await dispatch(call("run.cancel", { runId: "r" }, "1"), s)).toMatchObject({
      error: { code: -32600 },
    });
    expect(await dispatch(call("fs.read", {}), s)).toMatchObject({
      id: 1,
      error: { code: -32601 },
    });
    expect(await dispatch(call("toString", {}), s)).toMatchObject({ error: { code: -32601 } });
    expect(await dispatch(call("run.cancel", { runId: "r" }), s)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { cancelled: true },
    });
  });

  test("takes only the parameters its method names", async () => {
    const { served: s, operations } = served();
    expect(await dispatch(call("run.cancel", { runId: "r", extra: 1 }), s)).toMatchObject({
      error: { code: -32602 },
    });
    expect(await dispatch(call("install.apply", { planId: "p", trust: "x" }), s)).toMatchObject({
      error: { code: -32602 },
    });
    expect(await dispatch(call("install.apply", { planId: "p\n", trust: [] }), s)).toMatchObject({
      error: { code: -32602 },
    });
    expect(operations.apply).not.toHaveBeenCalled();
  });

  test("keeps names and sources from steering the child", async () => {
    const { served: s, operations } = served();
    for (const params of [
      { source: "--force" },
      { source: "acme", select: ["--all"] },
      { source: "acme", select: ["../x"] },
    ]) {
      expect(await dispatch(call("install.plan", params), s)).toMatchObject({
        error: { code: -32602 },
      });
    }
    for (const source of [
      "https://me:token@example.com/r",
      "https://example.com/r?token=x",
      "me:token@example.com:r.git",
    ]) {
      expect(await dispatch(call("install.plan", { source }), s)).toMatchObject({
        error: { code: REFUSED },
      });
    }
    expect(operations.plan).not.toHaveBeenCalled();
    await dispatch(
      call("install.plan", { source: "git@example.com:acme/r.git", select: ["a"] }),
      s,
    );
    expect(operations.plan).toHaveBeenCalledWith("git@example.com:acme/r.git", ["a"]);
  });
});
