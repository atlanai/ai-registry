// Shared by every module: the session token and API client, the page state and its elements,
// escaping, and the sanitizer every rendered file passes through.

// The server prints an address with a token after `#`, which the browser never sends.
// It moves to this tab's session storage and out of the address bar.
export const TOKEN_KEY = "aireg-web-token";
export const token = (() => {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})/.exec(location.hash);
  // Out of the address bar first, whether or not this tab can keep it in storage.
  if (match) history.replaceState(null, "", location.pathname);
  try {
    if (match) sessionStorage.setItem(TOKEN_KEY, match[1]);
    return match ? match[1] : sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (_) {
    return match ? match[1] : "";
  }
})();

/** Every call to the server carries the token; a write is always JSON. */
export function api(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.method === "POST") headers["Content-Type"] = "application/json";
  return fetch(url, { ...options, headers, credentials: "omit", cache: "no-store" });
}

/** Says a result to screen readers, and shows it in the status line. */
export function announce(message) {
  const live = document.getElementById("liveStatus");
  if (live) {
    live.textContent = "";
    setTimeout(() => {
      live.textContent = message;
    }, 50);
  }
  const chip = document.getElementById("lockfileSummary");
  if (chip) chip.title = message;
}

// Rendered Markdown passes through this before it reaches the page: whatever the renderer
// emits, only these tags and attributes survive, and a link opens only on the web or by mail.
export const SAFE_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "STRONG",
  "EM",
  "DEL",
  "CODE",
  "PRE",
  "BLOCKQUOTE",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "A",
  "SPAN",
  "DIV",
  "BR",
  "HR",
]);
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!SAFE_TAGS.has(child.tagName)) {
        child.replaceWith(doc.createTextNode(child.textContent || ""));
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keep =
          attr.name === "class" ||
          (child.tagName === "A" &&
            (attr.name === "target" ||
              attr.name === "rel" ||
              (attr.name === "href" && /^(https?:\/\/|mailto:)/i.test(attr.value))));
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") {
        child.setAttribute("rel", "noopener noreferrer");
        child.setAttribute("target", "_blank");
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** A value safe inside a class attribute. */
export function cssToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
}

/** Links in a skill open only on the web or by mail; anything else stays text. */
export function safeLink(text, href) {
  const target = String(href).replace(/&amp;/g, "&").trim();
  if (/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(target)) {
    return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }
  return `${text} (<code>${escapeHtml(target)}</code>)`;
}

// Application State
export const state = {
  activeMode: "artifacts", // 'artifacts' | 'sync' | 'audit'
  artifacts: [],
  stats: { total: 0, namespaces: {}, harnesses: {} },
  registries: [],
  consoleData: null,
  activeNamespace: "all",
  activeHarness: "all",
  auditFilter: "all", // 'all' | 'unpublished' | 'drifted' | 'broken'
  searchQuery: "",
  sortBy: "name-asc",
  selectedKey: null,
  cmdPaletteOpen: false,
  /** After an install: the key of what it installed, null for nothing to show, undefined before. */
  addDone: undefined,
  cmdMatches: [],
  cmdSelectedIndex: 0,
  syncing: false,
};

// DOM Elements
export const el = {
  // Mode Switcher & Views
  modeBtns: document.querySelectorAll(".mode-btn"),
  viewArtifacts: document.getElementById("viewArtifacts"),
  viewSyncEngine: document.getElementById("viewSyncEngine"),
  viewAudit: document.getElementById("viewAudit"),
  sidebarArtifactsMode: document.getElementById("sidebarArtifactsMode"),
  sidebarSyncMode: document.getElementById("sidebarSyncMode"),
  sidebarAuditMode: document.getElementById("sidebarAuditMode"),

  // Top Status Bar
  daemonStatusText: document.getElementById("daemonStatusText"),
  manifestStatusText: document.getElementById("manifestStatusText"),
  harnessStatusText: document.getElementById("harnessStatusText"),
  nextSyncCountdown: document.getElementById("nextSyncCountdown"),
  cmdKBtn: document.getElementById("cmdKBtn"),
  doctorModalBtn: document.getElementById("doctorModalBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  syncBtnText: document.getElementById("syncBtnText"),

  // Sidebar - Artifacts
  sidebarSearchInput: document.getElementById("sidebarSearchInput"),
  namespaceNav: document.getElementById("namespaceNav"),
  registryList: document.getElementById("registryList"),
  lockfileSummary: document.getElementById("lockfileSummary"),
  auditOkCount: document.getElementById("auditOkCount"),
  telemetryRunResults: document.getElementById("telemetryRunResults"),
  telemetryRunFailures: document.getElementById("telemetryRunFailures"),
  syncPolicyList: document.getElementById("syncPolicyList"),
  syncIntervalText: document.getElementById("syncIntervalText"),
  inspIntegrity: document.getElementById("inspIntegrity"),
  harnessNav: document.getElementById("harnessNav"),

  // Sidebar - Sync Engine
  daemonPidText: document.getElementById("daemonPidText"),
  daemonJobsText: document.getElementById("daemonJobsText"),

  // Sidebar - Drift & Audit
  auditCategoryNav: document.getElementById("auditCategoryNav"),
  auditCountBadge: document.getElementById("auditCountBadge"),
  jobsCountBadge: document.getElementById("jobsCountBadge"),
  auditCountAll: document.getElementById("auditCountAll"),
  auditCountUnpublished: document.getElementById("auditCountUnpublished"),
  auditCountDrifted: document.getElementById("auditCountDrifted"),
  auditCountBroken: document.getElementById("auditCountBroken"),

  // Artifacts Stream & Inspector
  streamNamespaceTitle: document.getElementById("streamNamespaceTitle"),
  streamCount: document.getElementById("streamCount"),
  sortSelect: document.getElementById("sortSelect"),
  artifactsList: document.getElementById("artifactsList"),
  emptyInspector: document.getElementById("emptyInspector"),
  activeInspector: document.getElementById("activeInspector"),
  inspNsPill: document.getElementById("inspNsPill"),
  inspTitle: document.getElementById("inspTitle"),
  inspVerPill: document.getElementById("inspVerPill"),
  inspDriftBadge: document.getElementById("inspDriftBadge"),
  inspLead: document.getElementById("inspDescription"),
  inspDigest: document.getElementById("inspDigest"),
  inspRegistry: document.getElementById("inspRegistry"),
  projectionsList: document.getElementById("projectionsList"),
  inspFilePath: document.getElementById("inspFilePath"),
  inspMarkdown: document.getElementById("inspMarkdown"),
  copyCliBtn: document.getElementById("copyCliBtn"),
  copyDigestBtn: document.getElementById("copyDigestBtn"),
  retireSkillBtn: document.getElementById("retireSkillBtn"),

  // Retire Modal
  retireModalBackdrop: document.getElementById("retireModalBackdrop"),
  retireModalTitle: document.getElementById("retireModalTitle"),
  retireModalClose: document.getElementById("retireModalClose"),
  retireCancelBtn: document.getElementById("retireCancelBtn"),
  retireConfirmBtn: document.getElementById("retireConfirmBtn"),
  retireConfirmText: document.getElementById("retireConfirmText"),
  retireTargetsList: document.getElementById("retireTargetsList"),
  auditCountRetired: document.getElementById("auditCountRetired"),

  // Add Artifact Modal
  addArtifactBtn: document.getElementById("addArtifactBtn"),
  addModalBackdrop: document.getElementById("addModalBackdrop"),
  addModalClose: document.getElementById("addModalClose"),
  addCancelBtn: document.getElementById("addCancelBtn"),
  addConfirmBtn: document.getElementById("addConfirmBtn"),
  addConfirmText: document.getElementById("addConfirmText"),
  addPreviewBtn: document.getElementById("addPreviewBtn"),
  addSourceInput: document.getElementById("addSourceInput"),
  addSelectInput: document.getElementById("addSelectInput"),
  addTrustCheckbox: document.getElementById("addTrustCheckbox"),
  addTrustNameInput: document.getElementById("addTrustNameInput"),
  addPreviewBox: document.getElementById("addPreviewBox"),
  addPreviewTitle: document.getElementById("addPreviewTitle"),
  addPreviewBadge: document.getElementById("addPreviewBadge"),
  addPreviewContent: document.getElementById("addPreviewContent"),

  // Dashboard - Sync Engine
  dashSyncBtn: document.getElementById("dashSyncBtn"),
  telemetryDaemonPid: document.getElementById("telemetryDaemonPid"),
  telemetryDaemonStatus: document.getElementById("telemetryDaemonStatus"),
  telemetryCadence: document.getElementById("telemetryCadence"),
  telemetryNextCountdown: document.getElementById("telemetryNextCountdown"),
  telemetryTotalRuns: document.getElementById("telemetryTotalRuns"),
  telemetryRunsCount: document.getElementById("telemetryRunsCount"),
  daemonJobsBody: document.getElementById("daemonJobsBody"),
  syncRunsBody: document.getElementById("syncRunsBody"),

  // Dashboard - Drift & Audit
  auditLocalCount: document.getElementById("auditLocalCount"),
  auditDriftCount: document.getElementById("auditDriftCount"),
  auditBrokenCount: document.getElementById("auditBrokenCount"),
  auditTableBody: document.getElementById("auditTableBody"),

  // Modals
  cmdPaletteBackdrop: document.getElementById("cmdPaletteBackdrop"),
  cmdInput: document.getElementById("cmdInput"),
  cmdResults: document.getElementById("cmdResults"),
  doctorModalBackdrop: document.getElementById("doctorModalBackdrop"),
  doctorModalClose: document.getElementById("doctorModalClose"),
  doctorModalContent: document.getElementById("doctorModalContent"),
};

// A time in the viewer's own zone and locale, with the zone named
export function formatTime(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Calls that would loop modules back on each other; main.js fills these in. */
export const hooks = {};
