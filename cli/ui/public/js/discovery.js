import { api, escapeHtml } from "./core.js";

const get = (id) => document.getElementById(id);
let snapshot;
let initialized = false;
let running = false;
let polling;
let result;
const esc = escapeHtml;

async function request(action, payload = {}) {
  const response = await api(
    "/api/discovery",
    action
      ? {
          method: "POST",
          body: JSON.stringify({ action, ...payload }),
        }
      : {},
  );
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || "Could not reach discovery. Retry.");
  return body.data;
}
function message(text, error = false) {
  get("discoveryMessage").textContent = text;
  get("discoveryMessage").classList.toggle("is-error", error);
}
function panel(name) {
  get("viewDiscovery").scrollTop = 0;
  for (const value of ["search", "setup", "usage"]) {
    get(`discovery${value[0].toUpperCase()}${value.slice(1)}Panel`).hidden = value !== name;
  }
  for (const button of document.querySelectorAll("[data-discovery-panel]")) {
    button.setAttribute("aria-pressed", String(button.dataset.discoveryPanel === name));
  }
}
async function act(label, work) {
  if (running) return;
  running = true;
  message(label);
  get("viewDiscovery").setAttribute("aria-busy", "true");
  for (const button of get("viewDiscovery").querySelectorAll("form button")) button.disabled = true;
  try {
    await work();
  } catch (error) {
    message(error.message || "Something went wrong. Try again.", true);
  } finally {
    running = false;
    get("viewDiscovery").removeAttribute("aria-busy");
    for (const button of get("viewDiscovery").querySelectorAll("form button"))
      button.disabled = false;
    if (snapshot) renderStatus();
  }
}
function renderStatus() {
  const s = snapshot;
  const ready = s.connected && s.indexReady && !s.job.running && !s.busy;
  get("discoveryConnection").textContent = s.connected ? "Gemini connected" : "Setup needed";
  get("discoverySearchButton").disabled = running || !ready;
  get("discoveryStopButton").disabled = !s.job.running;
  get("discoveryIndexButton").disabled = running || !s.connected || s.job.running || s.busy;
  get("discoveryDisconnect").disabled = running || !s.connected || s.job.running || s.busy;
  let indexStatus = `${s.indexed} embeddings saved. Build / refresh the index to search.`;
  if (s.indexReady)
    indexStatus = `${s.indexed} skills indexed · Updated ${new Date(s.indexedAt).toLocaleString()}`;
  if (s.job.running) indexStatus = `Indexing ${s.job.done} of ${s.job.total} skills…`;
  get("discoveryIndexStatus").textContent = s.job.error || indexStatus;
  get("discoveryProgress").max = s.job.total || s.eligible || 1;
  get("discoveryProgress").value = s.job.running ? s.job.done : s.indexed;
  let next =
    "Open Setup and build the index before searching. If a registry is missing, check Artifacts first.";
  if (ready)
    next = `${s.indexed} skills ready. Search text and candidate descriptions will be sent to Google.`;
  if (s.busy && !s.job.running)
    next = "Another discovery operation is running. This view updates when it finishes.";
  if (!s.connected) next = "Start in Setup: connect your key and choose registries.";
  get("discoveryNext").textContent = next;
  renderUsage(s);
}
function renderSetup() {
  get("discoveryRegistries").innerHTML = snapshot.available.length
    ? snapshot.available
        .map(
          (registry) =>
            `<label class="discovery-check"><input type="checkbox" name="discoveryRegistry" value="${esc(registry)}" ${snapshot.registries.includes(registry) ? "checked" : ""}><span>${esc(registry)}</span></label>`,
        )
        .join("")
    : "<p>No skills loaded yet. Check Artifacts, then refresh this view.</p>";
  get("discoveryTelemetry").checked = snapshot.telemetry;
}
async function refresh(setup = false) {
  snapshot = await request();
  renderStatus();
  if (setup) renderSetup();
  clearTimeout(polling);
  if (snapshot.job.running || snapshot.busy)
    polling = setTimeout(() => {
      void refresh().catch((error) => message(error.message, true));
    }, 1500);
}
export async function openDiscovery() {
  await act("Loading discovery…", async () => {
    await refresh(!initialized);
    if (!initialized) panel(snapshot.connected ? "search" : "setup");
    initialized = true;
    message("");
  });
}
function renderResults() {
  const chosen = result.selected;
  let title = "No suitable skill found";
  let note = "Try another description or include more registries in Setup.";
  if (result.status === "clarify") {
    title = "Add a little more detail";
    note = "Describe the deliverable, tools and constraints, then search again.";
  }
  if (chosen) {
    title = chosen.name;
    note =
      "Selected by Gemini Decisions from the retrieved candidates. Review the skill before using it.";
  }
  get("discoveryResults").innerHTML =
    `<article class="discovery-recommendation"><p class="discovery-eyebrow">${chosen ? "RECOMMENDED" : "NO HANDOFF"}</p><h2>${esc(title)}</h2><p>${esc(note)}</p>${chosen ? `<p>${esc(chosen.description)}</p><p class="discovery-meta">${esc(chosen.registry)} · ${esc(chosen.version || "unversioned")}</p><div class="discovery-actions"><button type="button" class="discovery-primary" id="discoveryHandoff">Prepare handoff</button><button type="button" data-feedback="helpful">Helpful</button><button type="button" data-feedback="not_helpful">Not helpful</button></div><p class="discovery-meta">Feedback describes this recommendation; it does not count as skill execution.</p>` : ""}${result.confidence !== null ? `<p class="discovery-meta">Model confidence: ${Math.round(result.confidence * 100)}% · not a skill quality score</p>` : ""}<div id="discoveryHandoffOutput"></div></article><details><summary>Retrieved candidates (${result.candidates.length})</summary><ol class="discovery-candidates">${result.candidates.map((s) => `<li><strong>${esc(s.name)}</strong><span>${esc(s.registry)}</span><p>${esc(s.description)}</p></li>`).join("")}</ol></details>`;
  get("discoveryHandoff")?.addEventListener("click", () => void handoff());
  for (const button of get("discoveryResults").querySelectorAll("[data-feedback]")) {
    button.addEventListener(
      "click",
      () =>
        void act("Saving feedback…", async () => {
          const data = await request("feedback", {
            requestId: result.requestId,
            outcome: button.dataset.feedback,
          });
          message(data.message);
          await refresh();
        }),
    );
  }
}
async function handoff() {
  await act("Preparing handoff…", async () => {
    const data = await request("handoff", { requestId: result.requestId });
    const output = get("discoveryHandoffOutput");
    output.replaceChildren();
    const label = document.createElement("label");
    label.textContent =
      "Copy this handoff into your agent. It does not install or execute a skill.";
    const area = document.createElement("textarea");
    area.readOnly = true;
    area.rows = 9;
    area.setAttribute("aria-label", "Skill handoff JSON");
    area.value = JSON.stringify(data.handoff, null, 2);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy handoff";
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(area.value).then(
        () => message("Handoff copied. Paste it into your agent."),
        () => {
          area.focus();
          area.select();
          message("Select and copy the handoff text manually.");
        },
      );
    });
    output.append(label, area, button);
    message("Handoff prepared. No harness execution has been recorded.");
    await refresh();
  });
}
function renderUsage(s) {
  const count = (type) => s.events.filter((e) => e.type === type).length;
  const metrics = [
    ["Searches", count("search")],
    ["Recommendations", count("recommendation")],
    ["Handoffs prepared", count("handoff")],
    ["Verified executions", "Not connected"],
  ];
  get("discoveryMetrics").innerHTML = metrics
    .map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`)
    .join("");
  const groups = new Map();
  for (const e of s.events.filter((e) => e.type === "recommendation"))
    groups.set(e.skillKey, (groups.get(e.skillKey) || 0) + 1);
  get("discoverySkillUsage").innerHTML = groups.size
    ? `<ul class="discovery-candidates">${[...groups]
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `<li><strong>${esc(key)}</strong><span>${n} recommendations</span></li>`)
        .join("")}</ul>`
    : "<p>No recommendations yet. Run your first search to start the history.</p>";
  get("discoveryEvents").innerHTML = s.events.length
    ? `<table><caption>Latest 50 local events</caption><thead><tr><th>Time</th><th>Event</th><th>Skill / outcome</th><th>Latency</th></tr></thead><tbody>${s.events
        .slice(-50)
        .reverse()
        .map(
          (e) =>
            `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td>${esc(e.type)}</td><td>${esc(e.skillKey || e.outcome)}${e.type === "feedback" ? ` · ${esc(e.outcome)} (user-reported)` : ""}</td><td>${e.durationMs ? `${e.durationMs} ms` : "—"}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "<p>No events recorded.</p>";
  get("discoveryRecording").textContent = s.telemetry ? "Pause recording" : "Resume recording";
  get("discoveryTelemetryState").textContent =
    s.telemetryWarning ||
    (s.telemetry ? "Local recording on · last 1,000 events" : "Local recording paused");
}
export function wireDiscovery() {
  for (const button of document.querySelectorAll("[data-discovery-panel]")) {
    button.addEventListener("click", () => {
      panel(button.dataset.discoveryPanel);
      void act("Refreshing…", async () => {
        await refresh(button.dataset.discoveryPanel === "setup");
        message("");
      });
    });
  }
  get("discoveryKeyLink").addEventListener("click", () =>
    window.open("https://aistudio.google.com/apikey", "_blank", "noopener,noreferrer"),
  );
  get("discoverySetupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const key = get("discoveryKey").value;
    get("discoveryKey").value = "";
    const registries = [
      ...document.querySelectorAll('input[name="discoveryRegistry"]:checked'),
    ].map((input) => input.value);
    void act("Testing both Gemini models…", async () => {
      const data = await request("setup", {
        key,
        registries,
        consent: get("discoveryConsent").checked,
        telemetry: get("discoveryTelemetry").checked,
      });
      result = undefined;
      get("discoveryResults").replaceChildren();
      message(data.message);
      await refresh(true);
    });
  });
  get("discoveryStopButton").addEventListener(
    "click",
    () =>
      void act("Stopping index…", async () => {
        const data = await request("stop");
        message(data.message);
      }),
  );
  get("discoveryIndexButton").addEventListener(
    "click",
    () =>
      void act("Starting index…", async () => {
        const data = await request("index");
        message(data.message);
        await refresh();
      }),
  );
  get("discoveryDisconnect").addEventListener(
    "click",
    () =>
      void act("Disconnecting…", async () => {
        const data = await request("disconnect");
        result = undefined;
        get("discoveryResults").replaceChildren();
        message(data.message);
        await refresh(true);
      }),
  );
  get("discoverySearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void act("Retrieving candidates and asking Gemini Decisions…", async () => {
      get("discoveryResults").replaceChildren();
      result = undefined;
      try {
        result = await request("search", { query: get("discoveryQuery").value });
      } catch (error) {
        await refresh();
        throw error;
      }
      renderResults();
      message(result.warnings?.join(" ") || "Search complete.");
      await refresh();
    });
  });
  get("discoveryUsageRefresh").addEventListener(
    "click",
    () =>
      void act("Refreshing usage…", async () => {
        await refresh();
        message("Usage updated.");
      }),
  );
  get("discoveryRecording").addEventListener("click", () => {
    void act("Updating local recording…", async () => {
      const data = await request("telemetry", { enabled: !snapshot.telemetry });
      await refresh();
      message(data.message);
    });
  });
  get("discoveryClear").addEventListener("click", () => {
    if (
      !window.confirm(
        "Clear local history and expire saved recommendations? This cannot be undone.",
      )
    )
      return;
    void act("Clearing usage…", async () => {
      const data = await request("clear");
      message(data.message);
      await refresh();
    });
  });
}
