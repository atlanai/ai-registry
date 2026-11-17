import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

function moduleSource(name: string) {
  return readFileSync(new URL(`../../ui/public/js/${name}.js`, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from ".*?";\n/gm, "")
    .replace(/^export /gm, "");
}

function retireDialog() {
  const state = {
    artifacts: [
      { key: "one", name: "One" },
      { key: "two", name: "Two" },
    ],
    selectedKey: "one",
  };
  const calls: object[] = [];
  let respond: ((value: object) => void) | undefined;
  const element = () => ({ textContent: "", disabled: false });
  const el = {
    retireModalTitle: element(),
    retireConfirmText: element(),
    retireConfirmBtn: element(),
    retireTargetsList: element(),
    retireModalBackdrop: { classList: { add() {}, remove() {} } },
  };
  const api = runInNewContext(
    `${moduleSource("dialogs")}\n({openRetireModal, closeRetireModal, confirmRetire});`,
    {
      state,
      el,
      api: async (_path: string, options: { body: string }) => {
        calls.push(JSON.parse(options.body));
        const response = new Promise((resolve) => {
          respond = resolve;
        });
        return { json: () => response };
      },
      loadArtifacts: async () => {},
      loadConsoleData: async () => {},
    },
  ) as {
    openRetireModal(): Promise<void>;
    closeRetireModal(): void;
    confirmRetire(): Promise<void>;
  };
  return { state, el, api, calls, reply: (value: object) => respond?.(value) };
}

test("retire confirms the previewed artifact even if selection changes", async () => {
  const b = retireDialog();
  const preview = b.api.openRetireModal();
  await Promise.resolve();
  b.reply({
    ok: true,
    action: "remove",
    message: "Remove One.",
    recovery: "The registry copy is unchanged.",
  });
  await preview;
  expect(b.el.retireConfirmText.textContent).toBe("Remove");
  expect(b.el.retireTargetsList.textContent).toContain("The registry copy is unchanged.");
  b.state.selectedKey = "two";
  const confirmation = b.api.confirmRetire();
  await Promise.resolve();
  expect(b.calls).toEqual([
    { key: "one", dryRun: true },
    { key: "one", dryRun: false },
  ]);
  await b.api.confirmRetire();
  expect(b.calls).toHaveLength(2);
  b.reply({ ok: true });
  await confirmation;
});

test("closing a pending retire preview cannot enable a later confirmation", async () => {
  const b = retireDialog();
  const preview = b.api.openRetireModal();
  await Promise.resolve();
  b.api.closeRetireModal();
  b.reply({ ok: true, message: "Remove One" });
  await preview;
  await b.api.confirmRetire();
  expect(b.calls).toHaveLength(1);
  expect(b.el.retireConfirmBtn.disabled).toBe(true);
});

test("local namespace filtering and keyboard entry work when selection is hidden", () => {
  const list = { innerHTML: "", setAttribute() {}, querySelectorAll: () => [] };
  const state = {
    artifacts: [
      {
        key: "local",
        name: "Local",
        namespace: "",
        registry: "this machine",
        harnesses: [],
        digest: "",
      },
    ],
    activeNamespace: "this machine",
    activeHarness: "all",
    selectedKey: "hidden",
    searchQuery: "",
  };
  const api = runInNewContext(`${moduleSource("catalog")}\n({getFilteredArtifacts, drawStream});`, {
    state,
    el: { artifactsList: list, streamCount: {}, streamNamespaceTitle: {} },
    escapeHtml: (value: string) => value,
    cssToken: (value: string) => value,
  }) as { getFilteredArtifacts(): unknown[]; drawStream(): void };
  expect(api.getFilteredArtifacts()).toHaveLength(1);
  api.drawStream();
  expect(list.innerHTML).toContain('tabindex="0"');
});

test("copied POSIX shell arguments preserve quotes and metacharacters as data", () => {
  const source = moduleSource("main");
  const fn = source.slice(
    source.indexOf("function shellQuote"),
    source.indexOf("// Mode Switcher"),
  );
  const quote = runInNewContext(`${fn}\nshellQuote;`) as (value: string) => string;
  expect(quote("folder/a b;$(echo nope)")).toBe("'folder/a b;$(echo nope)'");
  expect(quote("it's here")).toBe("'it'\\''s here'");
});

test("registry diagnostics do not appear in a top-of-page banner", () => {
  const html = readFileSync(new URL("../../ui/public/index.html", import.meta.url), "utf8");
  expect(html).not.toContain('id="problemsStrip"');
});

test("diagnostic commands use the scope the CLI reports", () => {
  const state = { consoleData: { scope: "project" } };
  const messages = runInNewContext(`${moduleSource("machine")}\nNEEDS_LOOK;`, { state }) as {
    missing(): string;
  };
  expect(messages.missing()).toBe("aireg install links it again");
  state.consoleData.scope = "user";
  expect(messages.missing()).toBe("aireg install -g links it again");
});

test("the schedule displays the earliest enabled job and clears absent schedules", () => {
  let tick = () => {};
  const state = {
    consoleData: {
      daemon: { running: true },
      jobs: [
        { enabled: false, nextRunAtMs: 1 },
        { enabled: true, nextRunAtMs: Date.now() + 600_000 },
        { enabled: true, nextRunAtMs: Date.now() - 1000 },
      ],
    },
  };
  const el = {
    nextSyncCountdown: { textContent: "" },
    telemetryNextCountdown: { textContent: "" },
  };
  runInNewContext(`${moduleSource("machine")}\nstartCountdownTicker();`, {
    state,
    el,
    setInterval: (callback: () => void) => {
      tick = callback;
    },
  });
  tick();
  expect(el.nextSyncCountdown.textContent).toBe("Next run: due now");
  state.consoleData.jobs = [];
  tick();
  expect(el.nextSyncCountdown.textContent).toBe("No scheduled runs");
});

test("Markdown keeps executable HTML, unsafe links and remote images out of the page", () => {
  const helpers = runInNewContext(
    `${moduleSource("core").replace("const token = await sessionToken();", "")}\n({escapeHtml, safeLink});`,
    { document: { getElementById: () => ({}), querySelectorAll: () => [] } },
  );
  const render = runInNewContext(`${moduleSource("markdown")}\nrenderMarkdown;`, helpers) as (
    markdown: string,
  ) => string;
  const html = render(
    "<script>alert(1)</script>\n\n[run](javascript:alert)\n\n![track](https://example.com/pixel)\n\n```html\n<img src=x onerror=alert(1)>\n```",
  );
  expect(html).not.toMatch(/<script|<img|href="javascript:/i);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
});
