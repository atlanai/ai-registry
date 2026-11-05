import type { Canceled, Machine, PromptIo, PromptWriter } from "./model.ts";

const nowhere: PromptWriter = { write: () => {} };
let silenced = false;

/** Runs `work` with every prompt and spinner writing nowhere, for commands run on another's behalf. */
export async function quietly<T>(work: () => Promise<T>): Promise<T> {
  silenced = true;
  try {
    return await work();
  } finally {
    silenced = false;
  }
}

export function defaultIo(): PromptIo {
  return { input: process.stdin, output: silenced ? nowhere : process.stderr };
}

let renderer: Promise<typeof import("./mount.ts")> | undefined;

/**
 * Starts loading Ink, which a command that asks nothing never does. A command
 * that will ask calls this before slow work, so the prompt does not wait for it.
 */
export function prepare(): Promise<typeof import("./mount.ts")> {
  if (renderer === undefined) {
    renderer = import("./mount.ts");
    // Unawaited until the first prompt, if one comes; a failure surfaces there.
    renderer.catch(() => {});
  }
  return renderer;
}

export async function ask<T>(io: PromptIo, machine: Machine<T>): Promise<T | Canceled> {
  const { mount } = await prepare();
  return await mount(io, machine);
}
