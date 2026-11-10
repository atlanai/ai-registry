// The list of everything each registry publishes, the sidebar filters, and the inspector.
import { api, cssToken, el, escapeHtml, hooks, sanitizeHtml, state } from "./core.js";
import { renderMarkdown } from "./markdown.js";

// Load Primary Artifacts
export async function loadArtifacts() {
  try {
    const res = await api("/api/artifacts");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Failed to load artifacts");

    state.artifacts = json.data.artifacts || [];
    state.stats = json.data.stats || { total: 0, namespaces: {}, harnesses: {} };
    state.registries = json.data.registries || [];
    state.problems = json.data.problems || [];

    updateHeaderStats();
    renderSidebarCounts();
    renderRegistries();
    renderProblems();
    hooks.updateAttentionCounts();
    if (state.activeMode === "audit") hooks.renderAuditDashboard();
    renderStream();

    if (!state.selectedKey && state.artifacts.length > 0) {
      await selectArtifact(state.artifacts[0].key);
    }
  } catch (err) {
    el.artifactsList.innerHTML = `
      <div class="stream-empty">
        <p>Could not read the registries.</p>
        <small>${escapeHtml(err.message)}</small>
      </div>
    `;
  }
}

// Update Status Tickers
export function updateHeaderStats() {
  const installed = state.artifacts.filter((a) => a.state !== "available").length;
  el.manifestStatusText.textContent = `${installed} installed, ${state.stats.total} listed`;
  const targets = Object.keys(state.stats.harnesses || {}).length;
  el.harnessStatusText.textContent = `${targets} ${targets === 1 ? "target" : "targets"}`;
}

// Namespaces and targets come from what the registries list and what is installed.
export function renderSidebarCounts() {
  const item = (attr, value, label, count, active) => `
      <li><button type="button" class="nav-item${active ? " active" : ""}" ${attr}="${escapeHtml(value)}" aria-pressed="${active}">
        <span class="nav-label">${escapeHtml(label)}</span>
        <span class="nav-count">${escapeHtml(String(count))}</span>
      </button></li>`;
  const namespaces = Object.entries(state.stats.namespaces || {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  el.namespaceNav.innerHTML =
    item("data-ns", "all", "All artifacts", state.stats.total, state.activeNamespace === "all") +
    namespaces
      .map(([ns, count]) => item("data-ns", ns, ns, count, state.activeNamespace === ns))
      .join("");
  const targets = Object.entries(state.stats.harnesses || {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  el.harnessNav.innerHTML =
    item("data-harness", "all", "All targets", "", state.activeHarness === "all") +
    targets
      .map(([target, count]) =>
        item("data-harness", target, target, count, state.activeHarness === target),
      )
      .join("");
}

export function renderRegistries() {
  if (!el.registryList) return;
  if (state.registries.length === 0) {
    el.registryList.innerHTML =
      '<div class="reg-path">No registry is declared. Run <code>aireg registry add &lt;address&gt; -g</code>.</div>';
    return;
  }
  el.registryList.innerHTML = state.registries
    .map((r) => {
      const tag = registryTag(r);
      return `
      <div class="registry-card-mini" title="${escapeHtml(r.error || r.address)}">
        <div class="reg-mini-row">
          <span class="reg-name">${escapeHtml(r.name)}</span>
          <span class="reg-tag">${escapeHtml(tag)}</span>
        </div>
        <div class="reg-path">${escapeHtml(r.address)}</div>
      </div>`;
    })
    .join("");
}

// Filter & Sort Artifacts
export function getFilteredArtifacts() {
  let items = [...state.artifacts];

  if (state.activeNamespace !== "all") {
    items = items.filter((a) => a.namespace === state.activeNamespace);
  }

  if (state.activeHarness !== "all") {
    items = items.filter((a) => a.harnesses.includes(state.activeHarness));
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase().trim();
    items = items.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.namespace.toLowerCase().includes(q) ||
        a.digest.toLowerCase().includes(q),
    );
  }

  switch (state.sortBy) {
    case "name-asc":
      items.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "name-desc":
      items.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "namespace":
      items.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
      break;
    case "version":
      items.sort((a, b) => b.version.localeCompare(a.version) || a.name.localeCompare(b.name));
      break;
  }

  return items;
}

// Render Artifacts Stream
export function renderStream() {
  const hadFocus = el.artifactsList.contains(document.activeElement);
  drawStream();
  // A background read redraws the list; a keyboard user keeps their place in it.
  if (hadFocus)
    el.artifactsList.querySelector(".artifact-row.active")?.focus({ preventScroll: true });
}

function drawStream() {
  const items = getFilteredArtifacts();
  el.streamCount.textContent = items.length;
  el.streamNamespaceTitle.textContent =
    state.activeNamespace === "all" ? "All artifacts" : state.activeNamespace;

  if (items.length === 0) {
    // Nothing at all is a different state from nothing matching, and says what to do.
    el.artifactsList.innerHTML =
      state.artifacts.length === 0
        ? `<div class="stream-empty"><p>Nothing is listed or installed yet.</p><small>Declare a registry with <code>aireg registry add &lt;address&gt; -g</code>, or use Add.</small></div>`
        : `<div class="stream-empty"><p>Nothing matches.</p><small>Clear the filter, or choose All artifacts.</small></div>`;
    return;
  }

  el.artifactsList.innerHTML = items
    .map((a) => {
      const isSelected = a.key === state.selectedKey;
      const harnessBadges = a.harnesses
        .map((h) => `<span class="harness-micro-badge">${escapeHtml(h)}</span>`)
        .join("");
      const shortDigest = a.digest ? a.digest.slice(7, 15) : "";

      return `
      <div class="artifact-row ${isSelected ? "active" : ""}" data-key="${escapeHtml(a.key)}" role="option" tabindex="${isSelected ? "0" : "-1"}" aria-selected="${isSelected}">
        <div class="artifact-row-top">
          <div class="row-name-group">
            ${a.namespace ? `<span class="row-ns-badge ns-${cssToken(a.namespace)}">${escapeHtml(a.namespace)}</span>` : ""}
            <span class="row-title">${escapeHtml(a.name)}</span>
          </div>
          <span class="row-version">${a.version ? `v${escapeHtml(a.version)}` : escapeHtml(a.kind)}</span>
        </div>
        <div class="row-desc">${escapeHtml(a.description)}</div>
        <div class="row-bottom-meta">
          <div class="row-harnesses"><span class="harness-micro-badge">${escapeHtml(a.registry)}</span>${harnessBadges}</div>
          <span class="row-hash">${escapeHtml(shortDigest)}</span>
        </div>
      </div>
    `;
    })
    .join("");

  el.artifactsList.setAttribute("role", "listbox");
  el.artifactsList.setAttribute("aria-label", "Artifacts");
  el.artifactsList.querySelectorAll(".artifact-row").forEach((row) => {
    const choose = () => selectArtifact(row.getAttribute("data-key"));
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void choose();
      }
    });
  });
}

// Select & Inspect Artifact
export async function selectArtifact(key) {
  state.selectedKey = key;
  const artifact = state.artifacts.find((a) => a.key === key);
  if (!artifact) return;
  markSelected(key);
  el.emptyInspector.style.display = "none";
  el.activeInspector.style.display = "flex";
  showHeader(artifact);
  showState(artifact);
  showLinks(artifact);
  await showFile(artifact);
}

function markSelected(key) {
  for (const row of el.artifactsList.querySelectorAll(".artifact-row")) {
    const chosen = row.getAttribute("data-key") === key;
    row.classList.toggle("active", chosen);
    row.setAttribute("aria-selected", String(chosen));
    row.setAttribute("tabindex", chosen ? "0" : "-1");
  }
}

function showHeader(artifact) {
  el.inspNsPill.textContent = artifact.namespace || artifact.registry;
  el.inspNsPill.className = `ns-pill ns-${cssToken(artifact.namespace)}`;
  el.inspTitle.textContent = artifact.name;
  el.inspVerPill.textContent = artifact.version ? `v${artifact.version}` : artifact.kind;
  el.inspLead.textContent = artifact.description;
  el.inspDigest.textContent = artifact.digest || "none";
  el.inspDigest.title = artifact.digest;
  el.inspRegistry.textContent = artifact.registry;
  if (el.retireSkillBtn) {
    const available = artifact.state === "available";
    const label = el.retireSkillBtn.querySelector("span");
    if (label) label.textContent = available ? "Install" : "Retire";
    el.retireSkillBtn.classList.toggle("btn-retire", !available);
    el.retireSkillBtn.title = available
      ? `Install it from ${artifact.registry}, with a dry run first`
      : "Remove it from every target, or move a folder written here aside";
  }
}

/** Each state's tone and what it means, in the console's words. */
function stateText(artifact) {
  const said = {
    ok: ["clean", "Installed, matches the lockfile"],
    available: [
      "pending",
      `Not installed; ${artifact.registry} serves ${artifact.version || "it"}`,
    ],
    authored: ["clean", "Written here and published"],
    edited: ["drifted", "Edited after it was installed"],
    missing: ["drifted", "A target link is missing"],
    dangling: ["drifted", "A link points somewhere else"],
    failed: ["drifted", "Its registry would not serve it"],
    unpublished: ["pending", "Written here, in no registry yet"],
    duplicate: ["pending", "Another copy of an installed artifact"],
    imported: ["clean", "Written here; a job carries it to its registry"],
    pending: ["pending", "Published; run aireg install to track it"],
  };
  return said[artifact.state] || ["pending", artifact.state];
}

function showState(artifact) {
  const [tone, said] = stateText(artifact);
  el.inspDriftBadge.className = `drift-badge ${tone}`;
  el.inspDriftBadge.textContent = artifact.state;
  if (!el.inspIntegrity) return;
  el.inspIntegrity.textContent = artifact.detail || said;
  // The tag's colour follows the state: green only when nothing needs a look.
  const warn = tone === "drifted" ? "failed" : "warn";
  el.inspIntegrity.className = tone === "clean" ? "status-verified-tag" : `status-pill ${warn}`;
}

function showLinks(artifact) {
  if (!artifact.links || artifact.links.length === 0) {
    const none =
      artifact.state === "available"
        ? "Not installed here, so no target loads it."
        : "No target links it.";
    el.projectionsList.innerHTML = `<div class="u45"><em>${none}</em></div>`;
    return;
  }
  el.projectionsList.innerHTML = artifact.links
    .map((l) => {
      const said = linkWord(l);
      return `
        <div class="projection-card-row">
          <div class="proj-left">
            <span class="proj-harness-badge">${escapeHtml(l.target)}</span>
            <span class="proj-path">${escapeHtml(l.path)}</span>
          </div>
          <span class="mode-tag ${said === "linked" ? "symlink" : "copy"}">${escapeHtml(said)}</span>
        </div>`;
    })
    .join("");
}

/** The file a target loads, or the one its registry serves; the server finds it by key. */
async function showFile(artifact) {
  el.inspMarkdown.innerHTML = `<div class="subtle-spinner u46"></div><p class="u47">Reading the file…</p>`;
  try {
    const res = await api(`/api/skill?key=${encodeURIComponent(artifact.key)}`);
    const json = await res.json();
    if (state.selectedKey !== artifact.key) return;
    el.inspFilePath.textContent = json.ok && json.data ? json.data.path : "";
    el.inspMarkdown.innerHTML =
      json.ok && json.data
        ? sanitizeHtml(renderMarkdown(json.data.markdown))
        : "<p><em>Could not read its file.</em></p>";
  } catch (_) {
    el.inspMarkdown.innerHTML = "<p><em>The server did not answer.</em></p>";
  }
}

// Keyboard Navigation in Stream (Up / Down)
export function navigateStream(direction) {
  const items = getFilteredArtifacts();
  if (items.length === 0) return;

  const currentIndex = items.findIndex((a) => a.key === state.selectedKey);
  let nextIndex = currentIndex + direction;

  if (nextIndex < 0) nextIndex = 0;
  if (nextIndex >= items.length) nextIndex = items.length - 1;

  const nextArtifact = items[nextIndex];
  if (nextArtifact) {
    void selectArtifact(nextArtifact.key);
    const row = el.artifactsList.querySelector(`[data-key="${CSS.escape(nextArtifact.key)}"]`);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
    }
  }
}

// Navigate directly to a specific artifact
export function navigateToArtifact(key) {
  if (!key) return;

  // 1. Switch workspace mode to artifacts
  hooks.switchMode("artifacts");

  // 2. Clear sidebar search query
  state.searchQuery = "";
  if (el.sidebarSearchInput) el.sidebarSearchInput.value = "";

  // 3. Find the artifact
  const art = state.artifacts.find(
    (a) => a.key === key || a.name === key || a.key.endsWith(`/${key}`),
  );
  if (art) {
    if (state.activeNamespace !== "all" && state.activeNamespace !== art.namespace) {
      state.activeNamespace = "all";
    }
    renderSidebarCounts();
    renderStream();

    // 4. Select and inspect the artifact
    void selectArtifact(art.key);

    // 5. Scroll the middle stream list to this item and flash highlight
    setTimeout(() => {
      const row = el.artifactsList.querySelector(`[data-key="${CSS.escape(art.key)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("flash-highlight");
        setTimeout(() => row.classList.remove("flash-highlight"), 2500);
      }
      if (el.activeInspector) {
        el.activeInspector.scrollTop = 0;
      }
    }, 120);
  }
}

function registryTag(registry) {
  if (registry.loading) return "reading";
  if (registry.error) return "unavailable";
  return `${registry.count} listed`;
}

function linkWord(link) {
  if (!link.present) return "missing";
  return link.ok ? "linked" : "points elsewhere";
}

/** What the server could not read, said where a person sees it, not only on hover. */
function renderProblems() {
  const strip = document.getElementById("problemsStrip");
  if (!strip) return;
  const problems = state.problems || [];
  strip.hidden = problems.length === 0;
  strip.textContent = problems.length === 0 ? "" : problems.join(" · ");
}

/** True while any registry is still being read, so the page reads again soon. */
export function stillReading() {
  return Array.isArray(state.registries) && state.registries.some((r) => r.loading);
}
