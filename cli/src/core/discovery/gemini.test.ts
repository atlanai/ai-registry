import { describe, expect, test, vi } from "vitest";
import { Gemini } from "./gemini.ts";

describe("Gemini discovery transport", () => {
  test("uses the documented fixed endpoints and rejects redirects", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ embedding: { values: [1, 0] } }))
      .mockResolvedValueOnce(
        Response.json({ answers: { skill: { choice: "one", confidence: 0.9 } } }),
      );
    const client = new Gemini("synthetic-key", send);
    expect(await client.embed("synthetic text")).toEqual([1, 0]);
    expect(await client.decide("synthetic task", { one: "one", none: "none" })).toEqual({
      choice: "one",
      confidence: 0.9,
    });
    expect(send.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(send.mock.calls[1]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/decisions",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { "x-goog-api-key": "synthetic-key" },
    });
  });
  test("does not expose response bodies or underlying network failures", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("synthetic-private-provider-body", { status: 403 }))
      .mockRejectedValueOnce(new Error("synthetic-private-network-error"));
    const client = new Gemini("synthetic-key", send);
    await expect(client.embed("x")).rejects.toThrow("Google returned HTTP 403. Check your API key");
    await expect(client.embed("x")).rejects.toThrow(
      "Google could not be reached or returned an unreadable response. Try again.",
    );
  });
  test("rejects malformed vectors and choices outside the closed candidate set", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ embedding: { values: [0, 0] } }))
      .mockResolvedValueOnce(Response.json({ answers: { skill: { choice: "invented" } } }));
    const client = new Gemini("synthetic-key", send);
    await expect(client.embed("x")).rejects.toThrow("invalid embedding");
    await expect(client.decide("x", { one: "one", none: "none" })).rejects.toThrow(
      "outside the candidate set",
    );
  });
});
