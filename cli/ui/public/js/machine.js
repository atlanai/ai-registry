// Daemon, jobs and runs, and what needs a look, with the command that settles each.
import { announce, api, el, escapeHtml, formatTime, hooks, state } from "./core.js";

// Load Live Engine State via /api/console
export async function loadConsoleData() {
  try {
    const res = await api("/api/console");
    const json = await res.json();
    if (json?.ok && json.data) {
      state.consoleData = json.data;
      updateConsoleTelemetry();
    }
  } catch (_err) {}
}

// What a person may need to act on, and the command that settles each.
export const NEEDS_LOOK = {
  edited: (a) => `aireg sync -g compares it with ${a.registry}; publish it to keep your edit`,
  missing: () => "aireg install -g links it again",
  dangling: () => "aireg status -g names the link to remove",
  failed: (a) => `aireg status -g shows why ${a.registry} would not serve it`,
  unpublished: () => "aireg publish <folder> --to <registry>/<namespace>",
  duplicate: () => "An installed artifact has this name; remove or rename this copy",
};

export function needsLook(filter) {
  return state.artifacts.filter((a) => {
    if (!(a.state in NEEDS_LOOK)) return false;
    if (filter === "unpublished") return a.registry === "this machine";
    if (filter === "drifted") return a.state === "edited";
    if (filter === "broken") return a.state === "missing" || a.state === "dangling";
    return true;
  });
}

export function updateAttentionCounts() {
  const all = needsLook("all");
  const set = (node, value) => {
    if (node) node.textContent = String(value);
  };
  set(el.auditCountBadge, all.length);
  set(el.auditCountAll, all.length);
  set(el.auditCountUnpublished, needsLook("unpublished").length);
  set(el.auditCountDrifted, needsLook("drifted").length);
  set(el.auditCountBroken, needsLook("broken").length);
  set(el.auditLocalCount, needsLook("unpublished").length);
  set(el.auditDriftCount, needsLook("drifted").length);
  set(el.auditBrokenCount, needsLook("broken").length);
  set(el.auditOkCount, state.artifacts.filter((a) => a.state === "ok").length);
  const installed = state.artifacts.filter(
    (a) => a.state !== "available" && a.registry !== "this machine",
  );
  const off = installed.filter((a) => a.state in NEEDS_LOOK).length;
  set(el.lockfileSummary, lockfileSummary(installed.length, off));
}

// Update Console Telemetry Across UI
export function updateConsoleTelemetry() {
  if (!state.consoleData) return;
  const cd = state.consoleData;
  showDaemon(cd.daemon);
  showJobs(cd.jobs || [], cd.policy || {});
  showRuns(cd.runs || []);
  updateAttentionCounts();
  if (state.activeMode === "sync") renderSyncEngineDashboard();
  if (state.activeMode === "audit") void renderAuditDashboard();
}

function showDaemon(daemon) {
  if (!daemon) return;
  const running = daemon.running && daemon.pid;
  el.daemonStatusText.textContent = running
    ? `Daemon running (PID ${daemon.pid})`
    : "Daemon stopped";
  el.daemonPidText.textContent = running ? daemon.pid : "not running";
  el.telemetryDaemonPid.textContent = running ? `PID ${daemon.pid}` : "Stopped";
  el.daemonJobsText.textContent = `${daemon.jobsEnabled} of ${daemon.jobsTotal} enabled`;
  if (el.telemetryDaemonStatus) {
    el.telemetryDaemonStatus.textContent = running
      ? "Running"
      : "Stopped: start it with aireg daemon start";
  }
}

function showJobs(jobs, policy) {
  const every = jobs[0] ? `${Math.round(jobs[0].intervalSeconds / 60)}m` : "";
  el.jobsCountBadge.textContent = jobs.length;
  if (el.telemetryCadence) el.telemetryCadence.textContent = every || "No job";
  if (el.syncIntervalText) el.syncIntervalText.textContent = every || "none";
  if (!el.syncPolicyList) return;
  const steps = Object.keys(policy);
  el.syncPolicyList.innerHTML =
    steps.length === 0
      ? '<div class="policy-item">No sync job is set up.</div>'
      : steps
          .map(
            (step) =>
              `<div class="policy-item"><span>${escapeHtml(step)}:</span> <code>${escapeHtml(String(policy[step]))}</code></div>`,
          )
          .join("");
}

function showRuns(runs) {
  const failed = runs.filter((r) => ["failed", "timed_out", "abandoned"].includes(r.state)).length;
  const succeeded = runs.filter((r) => r.state === "succeeded").length;
  el.telemetryTotalRuns.textContent = String(runs.length);
  el.telemetryRunsCount.textContent = runs.length === 0 ? "No runs yet" : `The last ${runs.length}`;
  if (el.telemetryRunResults)
    el.telemetryRunResults.textContent = runs.length === 0 ? "—" : `${succeeded} succeeded`;
  if (el.telemetryRunFailures) {
    el.telemetryRunFailures.textContent =
      failed === 0 ? "None failed" : `${failed} failed; see the table`;
  }
}

// Live Next-Sync Countdown Ticker
export function startCountdownTicker() {
  setInterval(() => {
    if (!state.consoleData?.jobs || state.consoleData.jobs.length === 0) return;
    const job = state.consoleData.jobs[0];
    if (!state.consoleData.daemon?.running) {
      el.nextSyncCountdown.textContent = "Daemon stopped";
      el.telemetryNextCountdown.textContent = "Nothing runs until the daemon starts";
      return;
    }
    if (!job.nextRunAtMs) return;

    const diff = job.nextRunAtMs - Date.now();
    if (diff <= 0) {
      // Due or running: the regular read picks up the next run time.
      el.nextSyncCountdown.textContent = "Next sync: due now";
      el.telemetryNextCountdown.textContent = "A run is due now";
    } else {
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      const str = `${mins}m ${secs.toString().padStart(2, "0")}s`;
      el.nextSyncCountdown.textContent = `Next sync in: ${str}`;
      el.telemetryNextCountdown.textContent = `Next scheduled run in: ${str}`;
    }
  }, 1000);
}

// Trigger On-Demand Sync
export async function triggerSync() {
  if (state.syncing) return;
  state.syncing = true;
  el.syncBtnText.textContent = "Syncing…";
  el.dashSyncBtn.querySelector("span").textContent = "Syncing…";

  try {
    const res = await api("/api/sync", { method: "POST" });
    const json = await res.json();
    announce(
      json.ok
        ? "Synced: took the latest of everything installed."
        : `Sync did not finish: ${json.error || json.message || "see aireg logs"}`,
    );
    await hooks.loadArtifacts();
    await loadConsoleData();
  } catch (_err) {
    announce("Sync did not finish: the server did not answer.");
  } finally {
    state.syncing = false;
    el.syncBtnText.textContent = "Sync Now";
    el.dashSyncBtn.querySelector("span").textContent = "Run Sync";
  }
}

// Render Sync Engine Dashboard View
/** Each run state in the CLI's words, and its tone. */
const RUN_STATE = {
  queued: ["queued", "warn"],
  running: ["running", "warn"],
  succeeded: ["succeeded", "success"],
  attention: ["needs attention", "warn"],
  partial: ["partly done", "warn"],
  failed: ["failed", "failed"],
  timed_out: ["timed out", "failed"],
  canceled: ["canceled", "warn"],
  abandoned: ["abandoned", "failed"],
};

function jobRow(j) {
  const minutes = Math.round(Number(j.intervalSeconds) / 60);
  return `
      <tr>
        <td><strong class="u32">${escapeHtml(j.name || j.id)}</strong></td>
        <td><span class="u33">${escapeHtml(j.accountId || "")}</span></td>
        <td><code>${escapeHtml(j.summary || j.type || "")}</code></td>
        <td>${escapeHtml(String(minutes))} min</td>
        <td><small>${formatTime(j.lastRunAtMs)}</small></td>
        <td><small>${j.enabled ? formatTime(j.nextRunAtMs) : "—"}</small></td>
        <td><span class="status-pill ${j.enabled ? "success" : "warn"}">${j.enabled ? "enabled" : "disabled"}</span></td>
      </tr>`;
}

function runRow(r) {
  const [word, tone] = RUN_STATE[r.state] || [r.state, "warn"];
  const finished = typeof r.finishedAtMs === "number";
  const took = finished ? `${((r.finishedAtMs - r.requestedAtMs) / 1000).toFixed(1)}s` : "—";
  const counts = r.counts || {};
  const count = (value) => escapeHtml(String(value ?? 0));
  return `
        <tr>
          <td><code class="u34" title="${escapeHtml(r.id || "")}">${escapeHtml((r.id || "").slice(0, 14))}…</code></td>
          <td><span class="u35">${escapeHtml(r.jobId || "by hand")}</span></td>
          <td><span class="nav-badge-pill">${escapeHtml(r.trigger || "")}</span></td>
          <td>${count(counts.examined)}</td>
          <td>${count(counts.changed)}</td>
          <td>${count(counts.skipped)}</td>
          <td>${took}</td>
          <td><small>${finished ? formatTime(r.finishedAtMs) : "—"}</small></td>
          <td><span class="status-pill ${tone}" title="${escapeHtml(r.reason || "")}">${escapeHtml(word)}</span></td>
        </tr>`;
}

export function renderSyncEngineDashboard() {
  if (!state.consoleData) return;
  const cd = state.consoleData;
  const jobs = cd.jobs || [];
  const runs = cd.runs || [];
  el.daemonJobsBody.innerHTML =
    jobs.length === 0
      ? '<tr><td colspan="7"><em>No background job is set up. Installing for your user, with <code>aireg add -g</code>, adds one.</em></td></tr>'
      : jobs.map(jobRow).join("");
  el.syncRunsBody.innerHTML =
    runs.length === 0
      ? '<tr><td colspan="9"><em>No runs yet.</em></td></tr>'
      : runs.slice(0, 16).map(runRow).join("") +
        (runs.length > 16
          ? `<tr><td colspan="9"><em>${runs.length - 16} more in <code>aireg logs</code>.</em></td></tr>`
          : "");
}

// What needs a look
export async function renderAuditDashboard() {
  // If retired archive filter
  if (state.auditFilter === "retired") {
    try {
      const res = await api("/api/retired");
      const json = await res.json();
      const retired = json.retired || [];
      if (el.auditCountRetired) el.auditCountRetired.textContent = retired.length;

      if (retired.length === 0) {
        el.auditTableBody.innerHTML = `
          <tr>
            <td class="u36" colspan="5">
              Nothing is retired. Retiring a skill written here moves it aside, to restore later.
            </td>
          </tr>
        `;
        return;
      }

      el.auditTableBody.innerHTML = retired
        .map(
          (item) => `
        <tr>
          <td><strong class="u37">${escapeHtml(item.name)}</strong></td>
          <td><span class="status-pill warn">retired</span></td>
          <td><span class="u38">${escapeHtml(item.description)}</span></td>
          <td><code class="u34">${escapeHtml(item.from)}</code></td>
          <td>
            <button class="subtle-btn restore-btn u39" data-id="${escapeHtml(item.id)}">
              Restore
            </button>
          </td>
        </tr>
      `,
        )
        .join("");

      el.auditTableBody.querySelectorAll(".restore-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-id");
          btn.textContent = "Restoring…";
          try {
            const res = await api("/api/restore", {
              method: "POST",
              body: JSON.stringify({ id }),
            });
            const json = await res.json();
            if (!json.ok) {
              btn.textContent = "Not restored";
              btn.title = json.error || "";
              return;
            }
            await hooks.loadArtifacts();
            await loadConsoleData();
            void renderAuditDashboard();
          } catch (err) {
            console.error("Restore error:", err);
            btn.textContent = "Failed";
          }
        });
      });
      return;
    } catch (err) {
      console.error("Error loading retired skills:", err);
    }
  }

  const filteredRows = needsLook(state.auditFilter);
  if (filteredRows.length === 0) {
    el.auditTableBody.innerHTML = `
      <tr>
        <td class="u40" colspan="5">
          Nothing here needs a look.
        </td>
      </tr>
    `;
    return;
  }

  el.auditTableBody.innerHTML =
    filteredRows
      .slice(0, 200)
      .map((a) => {
        const targetsList = (a.harnesses || [])
          .map((t) => `<span class="harness-micro-badge">${escapeHtml(t)}</span>`)
          .join(" ");
        const next = NEEDS_LOOK[a.state](a);
        return `
      <tr>
        <td><strong class="u37">${escapeHtml(a.name)}</strong><div class="u41">${escapeHtml(a.registry)}</div></td>
        <td><span class="status-pill warn">${escapeHtml(a.state)}</span></td>
        <td><div class="u42">${targetsList}</div></td>
        <td><code class="u34">${escapeHtml(a.path || "")}</code></td>
        <td>
          <button class="subtle-btn copy-cmd-btn u43" data-cmd="${escapeHtml(next)}" title="${escapeHtml(next)}">
            ${escapeHtml(next.length > 48 ? `${next.slice(0, 47)}…` : next)}
          </button>
        </td>
      </tr>
    `;
      })
      .join("") +
    (filteredRows.length > 200
      ? `<tr><td class="u44" colspan="5">${filteredRows.length - 200} more not shown.</td></tr>`
      : "");

  // Attach copy button listeners in audit table
  el.auditTableBody.querySelectorAll(".copy-cmd-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.getAttribute("data-cmd");
      navigator.clipboard.writeText(cmd);
      const was = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = was;
      }, 1200);
    });
  });
}

function lockfileSummary(installed, off) {
  if (installed === 0) return "Nothing installed yet";
  if (off === 0) return "Everything matches the lockfile";
  return `${off} of ${installed} need a look`;
}
