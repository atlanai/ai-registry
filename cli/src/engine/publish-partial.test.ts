import { describe, expect, it } from "vitest";
import type { PublishInput, PublishOptions } from "#adapter/index.ts";
import { AdapterError } from "#adapter/index.ts";
import type { SyncExecutionHooks, SyncOutcome } from "./decide.ts";
import { settlePublished } from "./publish-settle.ts";
import { publishPartial } from "./remote.ts";

const input = (name: string, version?: string) =>
  ({ name, kind: "skill", version }) as unknown as PublishInput;
const empty = () => ({
  published: new Map<string, string | undefined>(),
  archived: new Set<string>(),
});

describe("publishPartial", () => {
  it("records what landed at the version sent, reports each refusal, and rethrows the first after", async () => {
    const refused = new AdapterError("acme", "invalid", "blocked");
    const result = empty();
    const failed: string[] = [];
    const sent: string[] = [];
    let asked: PublishOptions | undefined;
    const publish = async (_: readonly PublishInput[], options: PublishOptions) => {
      asked = options;
      return { refused: [{ index: 1, error: refused }] };
    };
    await expect(
      publishPartial(
        publish,
        [input("a", "1.0.0"), input("b"), input("c")],
        ["a", "b", "c"],
        result,
        {
          event: () => {},
          failed: (name) => failed.push(name),
          sent: (name) => sent.push(name),
        },
      ),
    ).rejects.toBe(refused);
    expect(asked).toEqual({ partial: true });
    expect(sent).toEqual(["a", "b", "c"]);
    expect([...result.published]).toEqual([
      ["a", "1.0.0"],
      ["c", undefined],
    ]);
    expect(failed).toEqual(["b"]);
  });

  it("records nothing when an adapter that ignores partial throws", async () => {
    const thrown = new AdapterError("git", "conflict", "HTTP 409");
    const result = empty();
    const publish = async () => {
      throw thrown;
    };
    await expect(
      publishPartial(publish, [input("a")], ["a"], result, { event: () => {} }),
    ).rejects.toBe(thrown);
    expect(result.published.size).toBe(0);
  });

  it("reports a held change without recording or failing it", async () => {
    const result = empty();
    const held: [string, string][] = [];
    const publish = async () => ({ held: [{ index: 0, reason: "in review" }] });
    await publishPartial(publish, [input("a"), input("b")], ["a", "b"], result, {
      event: () => {},
      held: (name, reason) => held.push([name, reason]),
    });
    expect([...result.published.keys()]).toEqual(["b"]);
    expect(held).toEqual([["a", "in review"]]);
  });
});

describe("settlePublished", () => {
  const outcome = (artifact: string) =>
    ({ artifact, kind: "skill", disposition: "adopt", operation: "publish" }) as SyncOutcome;
  const collect = () => {
    const settled: [string, unknown][] = [];
    const hooks = {
      item: (name: string, _phase: string, item: unknown, data?: unknown) =>
        settled.push([
          name,
          data === undefined ? item : { ...(item as object), ...(data as object) },
        ]),
    } as unknown as SyncExecutionHooks;
    return { settled, hooks };
  };

  it("settles each once: changed when it landed, failed with its own code when refused", () => {
    const { settled, hooks } = collect();
    settlePublished(
      [outcome("a"), outcome("b")],
      {
        attempted: new Set(["a", "b"]),
        published: new Set(["a"]),
        refusals: new Map([["b", new AdapterError("acme", "invalid", "blocked")]]),
      },
      undefined,
      hooks,
    );
    expect(settled).toEqual([
      ["a", expect.objectContaining({ outcome: "changed" })],
      [
        "b",
        expect.objectContaining({
          outcome: "failed",
          errorCode: "adapter_invalid",
          detail: "blocked",
        }),
      ],
    ]);
  });

  it("fails the rest with the batch's error when the whole batch was refused", () => {
    const { settled, hooks } = collect();
    const batch = new AdapterError("acme", "unavailable", "HTTP 503");
    settlePublished(
      [outcome("a")],
      { attempted: new Set(["a"]), published: new Set(), refusals: new Map() },
      batch,
      hooks,
    );
    expect(settled).toEqual([
      [
        "a",
        expect.objectContaining({
          outcome: "failed",
          errorCode: "adapter_unavailable",
          retryable: true,
        }),
      ],
    ]);
  });

  it("leaves one the plan no longer sent for a person, even when another was refused", () => {
    const { settled, hooks } = collect();
    const refused = new AdapterError("acme", "invalid", "blocked");
    settlePublished(
      [outcome("a"), outcome("b")],
      { attempted: new Set(["b"]), published: new Set(), refusals: new Map([["b", refused]]) },
      refused,
      hooks,
    );
    expect(settled).toEqual([
      ["a", expect.objectContaining({ outcome: "attention" })],
      ["b", expect.objectContaining({ outcome: "failed", detail: "blocked" })],
    ]);
    expect(settled[0]?.[1]).not.toHaveProperty("errorCode");
  });

  it("settles a held change as in review, not failed", () => {
    const { settled, hooks } = collect();
    settlePublished(
      [outcome("a")],
      {
        attempted: new Set(["a"]),
        published: new Set(),
        refusals: new Map(),
        holds: new Map([["a", "The registry is reviewing a"]]),
      },
      undefined,
      hooks,
    );
    expect(settled).toEqual([
      [
        "a",
        expect.objectContaining({
          outcome: "attention",
          errorCode: "in_review",
          detail: "The registry is reviewing a",
        }),
      ],
    ]);
  });

  it("settles an archive that landed as changed and one refused with its own error", () => {
    const settled: [string, string, unknown][] = [];
    const hooks = {
      item: (name: string, phase: string, item: unknown) => settled.push([name, phase, item]),
    } as unknown as SyncExecutionHooks;
    const archive = (artifact: string) =>
      ({ artifact, kind: "skill", disposition: "archive", operation: "archive" }) as SyncOutcome;
    settlePublished(
      [archive("gone"), archive("shipped")],
      {
        attempted: new Set(["gone", "shipped"]),
        published: new Set(),
        archived: new Set(["gone"]),
        refusals: new Map([["shipped", new AdapterError("acme", "invalid", "built in")]]),
      },
      undefined,
      hooks,
    );
    expect(settled).toEqual([
      ["gone", "archiving", expect.objectContaining({ outcome: "changed" })],
      [
        "shipped",
        "archiving",
        expect.objectContaining({ outcome: "failed", errorCode: "adapter_invalid" }),
      ],
    ]);
  });
});
