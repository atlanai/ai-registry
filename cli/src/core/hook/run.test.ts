import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import {
  AdapterError,
  type SourceAdapter,
  type SourceContext,
  type SourceHandle,
} from "#adapter/index.ts";
import type { PipelineHook } from "#core/config/hook-stages.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { formatConfig } from "#core/config/parse.ts";
import { test } from "#test/kit/fixtures.ts";
import { sourceContext } from "#test/kit/source-context.ts";
import { bindAdapter } from "./bind.ts";
import { runPipelineHooks } from "./run.ts";

let home: string;

async function writeHome(hooks: readonly PipelineHook[], handlers: Record<string, string>) {
  await mkdir(join(home, "hooks"), { recursive: true });
  await writeFile(
    join(home, "config.yml"),
    formatConfig({ ...emptyRegistryConfig(), hooks }),
    "utf8",
  );
  for (const [name, body] of Object.entries(handlers)) {
    await writeFile(join(home, "hooks", name), body, "utf8");
  }
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  vi.stubEnv("AIREG_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runPipelineHooks", () => {
  test("is a no-op when the machine config names none", async () => {
    await expect(runPipelineHooks("preConnect", { alias: "kit" })).resolves.toBeUndefined();
  });

  test("runs a handler under the home and skips a matcher that misses", async () => {
    const log = join(home, "seen.txt");
    await writeHome(
      [
        { id: "all", stage: "preConnect", handler: "hooks/all.mjs" },
        { id: "other", stage: "preConnect", handler: "hooks/other.mjs", matcher: "other" },
      ],
      {
        "all.mjs": `import { appendFileSync } from "node:fs";
export default (event) => appendFileSync(${JSON.stringify(log)}, event.stage + ":" + event.alias + "\\n");`,
        "other.mjs": `import { appendFileSync } from "node:fs";
export default () => appendFileSync(${JSON.stringify(log)}, "missed\\n");`,
      },
    );
    await runPipelineHooks("preConnect", { alias: "kit" });
    expect(await readFile(log, "utf8")).toBe("preConnect:kit\n");
  });

  test("mints HOOK_REJECTED when the handler throws or lives outside the home", async () => {
    await writeHome([{ id: "gate", stage: "preConnect", handler: "hooks/gate.mjs" }], {
      "gate.mjs": "export default () => { throw new Error('blocked'); };\n",
    });
    await expect(runPipelineHooks("preConnect", { alias: "kit" })).rejects.toMatchObject({
      name: "AdapterError",
      adapter: "hooks",
      failure: "invalid",
      problem: { code: "HOOK_REJECTED" },
    });

    await writeFile(
      join(home, "config.yml"),
      formatConfig({
        ...emptyRegistryConfig(),
        hooks: [{ id: "out", stage: "preConnect", handler: "/tmp/evil.mjs" }],
      }),
      "utf8",
    );
    await expect(runPipelineHooks("preConnect")).rejects.toBeInstanceOf(AdapterError);
  });

  test("matches a plan stage against aliases when alias is unset", async () => {
    const log = join(home, "seen.txt");
    await writeHome([{ id: "kit", stage: "prePlan", handler: "hooks/all.mjs", matcher: "kit" }], {
      "all.mjs": `import { appendFileSync } from "node:fs";
export default (event) => appendFileSync(${JSON.stringify(log)}, event.stage + "\\n");`,
    });
    await runPipelineHooks("prePlan", { aliases: ["kit", "other"] });
    expect(await readFile(log, "utf8")).toBe("prePlan\n");
  });

  test("stops before invoking when the signal is already aborted", async () => {
    const log = join(home, "seen.txt");
    await writeHome([{ id: "all", stage: "preConnect", handler: "hooks/all.mjs" }], {
      "all.mjs": `import { appendFileSync } from "node:fs";
export default () => appendFileSync(${JSON.stringify(log)}, "ran\\n");`,
    });
    await expect(
      runPipelineHooks("preConnect", { alias: "kit" }, AbortSignal.abort()),
    ).rejects.toThrow();
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function probe(handle: SourceHandle): SourceAdapter {
  return {
    id: "probe",
    displayName: "Probe",
    protocol: 1,
    artifactKinds: ["skill"],
    dispatch: { schemes: ["probe"] },
    capabilities: { pinsSource: false, publish: false, auth: false },
    connect: async () => handle,
  };
}

function context(): SourceContext {
  return sourceContext({ registry: "kit", location: "probe://x", config: {}, key: "k" });
}

function handle(over: Partial<SourceHandle> = {}): SourceHandle {
  return {
    resolve: async () => ({ artifacts: [] }),
    fetch: async () => new Uint8Array(),
    close: async () => {},
    ...over,
  };
}

const connect = (inner: SourceHandle) => bindAdapter(probe(inner), "kit").connect(context());

/** Handler source that appends each event's stage, and any operation, to `log`. */
function logger(log: string): string {
  return `import { appendFileSync } from "node:fs";
export default (event) => appendFileSync(${JSON.stringify(log)}, [event.stage, event.operation].filter(Boolean).join(" ") + "\\n");`;
}

describe("bindAdapter", () => {
  test("fires resolve and close stages around the inner handle", async () => {
    const log = join(home, "bound.txt");
    await writeHome(
      [
        { id: "pre", stage: "preResolve", handler: "hooks/log.mjs" },
        { id: "post", stage: "postResolve", handler: "hooks/log.mjs" },
        { id: "close", stage: "preClose", handler: "hooks/log.mjs" },
      ],
      { "log.mjs": logger(log) },
    );
    const wrapped = await connect(handle());
    await wrapped.resolve([]);
    await wrapped.close();
    expect(await readFile(log, "utf8")).toBe("preResolve\npostResolve\npreClose\n");
  });

  test("reads the hooks once, when it connects", async () => {
    const log = join(home, "once.txt");
    await writeHome([{ id: "pre", stage: "preResolve", handler: "hooks/log.mjs" }], {
      "log.mjs": logger(log),
    });
    const wrapped = await connect(handle());
    await writeHome([], {});
    await wrapped.resolve([]);
    expect(await readFile(log, "utf8")).toBe("preResolve\n");
  });

  test("still closes the inner handle when preClose rejects", async () => {
    let closed = false;
    await writeHome([{ id: "gate", stage: "preClose", handler: "hooks/gate.mjs" }], {
      "gate.mjs": "export default () => { throw new Error('blocked'); };\n",
    });
    const wrapped = await connect(
      handle({
        close: async () => {
          closed = true;
        },
      }),
    );
    await expect(wrapped.close()).rejects.toMatchObject({ problem: { code: "HOOK_REJECTED" } });
    expect(closed).toBe(true);
  });

  test("fires the publish stages around unpublish too, saying which it is", async () => {
    const log = join(home, "unpub.txt");
    await writeHome(
      [
        { id: "pre", stage: "prePublish", handler: "hooks/log.mjs" },
        { id: "post", stage: "postPublish", handler: "hooks/log.mjs" },
      ],
      { "log.mjs": logger(log) },
    );
    const wrapped = await connect(handle({ publish: async () => ({}), unpublish: async () => {} }));
    await wrapped.publish?.([], {});
    await wrapped.unpublish?.([{ id: "a1", kind: "skill" }]);
    expect(await readFile(log, "utf8")).toBe(
      "prePublish publish\npostPublish publish\nprePublish unpublish\npostPublish unpublish\n",
    );
  });

  test("closes the inner handle when postConnect rejects", async () => {
    let closed = false;
    await writeHome([{ id: "gate", stage: "postConnect", handler: "hooks/gate.mjs" }], {
      "gate.mjs": "export default () => { throw new Error('blocked'); };\n",
    });
    await expect(
      connect(
        handle({
          close: async () => {
            closed = true;
          },
        }),
      ),
    ).rejects.toMatchObject({ problem: { code: "HOOK_REJECTED" } });
    expect(closed).toBe(true);
  });
});
