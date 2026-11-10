// The command palette and the doctor, retire and add dialogs.
import { loadArtifacts, navigateToArtifact, selectArtifact } from "./catalog.js";
import { api, cssToken, el, escapeHtml, hooks, state } from "./core.js";
import { loadConsoleData } from "./machine.js";

// Command Palette (⌘K)
export function openCommandPalette() {
  state.cmdPaletteOpen = true;
  el.cmdPaletteBackdrop.classList.add("open");
  el.cmdInput.value = "";
  renderCommandMatches("");
  setTimeout(() => el.cmdInput.focus(), 50);
}

export function closeCommandPalette() {
  state.cmdPaletteOpen = false;
  el.cmdPaletteBackdrop.classList.remove("open");
}

export function renderCommandMatches(query) {
  const q = query.toLowerCase().trim();
  let matches = state.artifacts;

  if (q) {
    matches = matches.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.namespace.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }

  state.cmdMatches = matches.slice(0, 15);
  state.cmdSelectedIndex = 0;

  if (state.cmdMatches.length === 0) {
    el.cmdResults.innerHTML = `<div class="u48">Nothing matches "${escapeHtml(query)}"</div>`;
    return;
  }

  el.cmdResults.innerHTML = state.cmdMatches
    .map(
      (m, idx) => `
    <div class="cmd-item ${idx === 0 ? "selected" : ""}" data-idx="${idx}" data-key="${escapeHtml(m.key)}">
      <div class="cmd-item-left">
        <span class="row-ns-badge ns-${cssToken(m.namespace)}">${escapeHtml(m.namespace)}</span>
        <span class="cmd-item-title">${escapeHtml(m.name)}</span>
      </div>
      <span class="row-version">v${escapeHtml(m.version)}</span>
    </div>
  `,
    )
    .join("");

  el.cmdResults.querySelectorAll(".cmd-item").forEach((item) => {
    item.addEventListener("click", () => {
      const key = item.getAttribute("data-key");
      hooks.switchMode("artifacts");
      void selectArtifact(key);
      closeCommandPalette();
    });
  });
}

// Doctor Report Modal
export async function openDoctorModal() {
  el.doctorModalBackdrop.classList.add("open");
  el.doctorModalContent.innerHTML = `
    <div class="u49">
      <div class="subtle-spinner"></div>
      <span>Running aireg doctor diagnostic...</span>
    </div>
  `;

  try {
    const res = await api("/api/doctor");
    const json = await res.json();
    if (json?.ok && json.data && Array.isArray(json.data.checks)) {
      el.doctorModalContent.innerHTML = json.data.checks
        .map(
          (c) => `
        <div class="diag-item">
          <span class="diag-name">${escapeHtml(c.name)}</span>
          <span class="diag-val">${escapeHtml(c.detail || "")}</span>
        </div>
      `,
        )
        .join("");
    } else {
      el.doctorModalContent.innerHTML = `<pre class="u34">${escapeHtml(JSON.stringify(json, null, 2))}</pre>`;
    }
  } catch (err) {
    el.doctorModalContent.innerHTML = `<p class="u44">Error: ${escapeHtml(err.message)}</p>`;
  }
}

export function closeDoctorModal() {
  el.doctorModalBackdrop.classList.remove("open");
}

// Retire Modal Functions
export async function openRetireModal() {
  const artifact = state.artifacts.find((a) => a.key === state.selectedKey);
  if (!artifact) return;
  // An artifact no one installed yet is installed from its registry, not retired.
  if (artifact.state === "available") {
    openAddModal();
    el.addSourceInput.value = artifact.key;
    return;
  }

  el.retireModalTitle.textContent = `Retire ${artifact.name}`;
  el.retireModalBackdrop.classList.add("open");
  el.retireConfirmText.textContent = "Retire it";
  el.retireConfirmBtn.disabled = true;
  el.retireTargetsList.textContent = "Asking aireg what this would change…";

  try {
    const res = await api("/api/retire", {
      method: "POST",
      body: JSON.stringify({ key: artifact.key, dryRun: true }),
    });
    const json = await res.json();
    // The server's own plan, word for word: nothing here is guessed.
    el.retireTargetsList.textContent = json.ok
      ? json.message
      : json.error || json.message || "aireg would not retire it.";
    el.retireConfirmBtn.disabled = !json.ok;
  } catch (_) {
    el.retireTargetsList.textContent = "The server did not answer.";
  }
}

export function closeRetireModal() {
  el.retireModalBackdrop.classList.remove("open");
}

export async function confirmRetire() {
  const artifact = state.artifacts.find((a) => a.key === state.selectedKey);
  if (!artifact) return;

  el.retireConfirmText.textContent = "Retiring...";
  el.retireConfirmBtn.disabled = true;

  try {
    const res = await api("/api/retire", {
      method: "POST",
      body: JSON.stringify({ key: artifact.key, dryRun: false }),
    });
    const json = await res.json();
    if (!json.ok) {
      // Stay open and say why, so a failure never looks like success.
      el.retireTargetsList.textContent = json.error || json.message || "aireg did not retire it.";
      el.retireConfirmText.textContent = "Retire it";
      el.retireConfirmBtn.disabled = false;
      return;
    }
    closeRetireModal();
    await loadArtifacts();
    await loadConsoleData();
  } catch (_err) {
    el.retireTargetsList.textContent = "The server did not answer.";
    el.retireConfirmText.textContent = "Retire it";
    el.retireConfirmBtn.disabled = false;
  }
}

// Add Artifact Modal Functions
export function openAddModal() {
  if (!el.addModalBackdrop) return;
  el.addSourceInput.value = "";
  el.addSelectInput.value = "";
  // Trust is never on by default: the dry run names what needs it, and you choose.
  el.addTrustCheckbox.checked = false;
  el.addTrustNameInput.value = "";
  el.addPreviewBox.classList.add("hidden");
  el.addPreviewContent.textContent = "";
  if (el.addPreviewBadge) {
    el.addPreviewBadge.className = "status-pill verified";
    el.addPreviewBadge.textContent = "Ready";
  }
  el.addConfirmText.textContent = "Install";
  el.addConfirmBtn.disabled = false;
  // The confirm button installs; once an install is done, it shows what was installed.
  state.addDone = undefined;
  el.addModalBackdrop.classList.add("open");
  setTimeout(() => el.addSourceInput.focus(), 50);
}

export function closeAddModal() {
  if (!el.addModalBackdrop) return;
  el.addModalBackdrop.classList.remove("open");
}

export async function runAddDryRun() {
  const source = el.addSourceInput.value.trim();
  if (!source) {
    el.addSourceInput.focus();
    return;
  }

  el.addPreviewBox.classList.remove("hidden");
  el.addPreviewTitle.textContent = "Running a dry run…";
  if (el.addPreviewBadge) {
    el.addPreviewBadge.className = "status-pill pending";
    el.addPreviewBadge.textContent = "Running";
  }
  el.addPreviewContent.textContent =
    "Reading the source and planning what would change. Nothing is installed yet.";
  el.addPreviewBtn.disabled = true;

  // Smooth scroll the preview box into view so nothing is buried
  el.addPreviewBox.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const res = await api("/api/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        select: el.addSelectInput.value.trim() || undefined,
        trust: el.addTrustCheckbox.checked,
        trustName: el.addTrustNameInput.value.trim() || undefined,
        dryRun: true,
      }),
    });
    const data = await res.json();
    el.addPreviewTitle.textContent = data.ok ? "Would change" : "Would not install";
    if (el.addPreviewBadge) {
      el.addPreviewBadge.className = data.ok ? "status-pill verified" : "status-pill failed";
      el.addPreviewBadge.textContent = data.ok ? "Dry run" : "Refused";
    }
    el.addPreviewContent.textContent = data.output || data.error || "No changes predicted.";
    // Offer exactly the plugins the dry run named; the box stays unticked until you tick it.
    if (Array.isArray(data.untrusted) && data.untrusted.length > 0) {
      el.addTrustNameInput.value = data.untrusted.join(", ");
    }
    el.addPreviewBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    el.addPreviewTitle.textContent = "The dry run did not finish";
    if (el.addPreviewBadge) {
      el.addPreviewBadge.className = "status-pill failed";
      el.addPreviewBadge.textContent = "Failed";
    }
    el.addPreviewContent.textContent = err.message || "Network error";
  } finally {
    el.addPreviewBtn.disabled = false;
  }
}

/** Sets the add dialog's status: a title, a badge and the text under them. */
function showAddStatus(title, badge, tone, text) {
  el.addPreviewTitle.textContent = title;
  if (el.addPreviewBadge) {
    el.addPreviewBadge.className = `status-pill ${tone}`;
    el.addPreviewBadge.textContent = badge;
  }
  el.addPreviewContent.textContent = text;
}

/** After an install: refresh, then offer to show only an artifact aireg says it installed. */
async function showInstalled(data) {
  const named = data.installed || [];
  // Success with nothing installed is its own answer, not "Installed".
  if (named.length > 0) showAddStatus("Installed", "Installed", "verified", data.output || "");
  else
    showAddStatus("Nothing was installed", "No change", "warn", data.output || "Nothing changed.");
  await loadArtifacts();
  await loadConsoleData();
  const installed = state.artifacts.find((a) => a.state !== "available" && named.includes(a.name));
  state.addDone = installed ? installed.key : null;
  el.addConfirmText.textContent = installed ? "Show it" : "Close";
  el.addConfirmBtn.disabled = false;
}

function showNotInstalled(text) {
  el.addConfirmText.textContent = "Try again";
  el.addConfirmBtn.disabled = false;
  el.addPreviewBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return text;
}

export async function confirmAdd() {
  if (state.addDone !== undefined) {
    const key = state.addDone;
    closeAddModal();
    if (key) navigateToArtifact(key);
    return;
  }
  const source = el.addSourceInput.value.trim();
  if (!source) {
    el.addSourceInput.focus();
    return;
  }
  el.addConfirmText.textContent = "Installing…";
  el.addConfirmBtn.disabled = true;
  el.addPreviewBox.classList.remove("hidden");
  showAddStatus(
    "Installing…",
    "Installing",
    "pending",
    "Fetching, checking each digest, and linking each target.",
  );
  el.addPreviewBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const res = await api("/api/add", {
      method: "POST",
      body: JSON.stringify({
        source,
        select: el.addSelectInput.value.trim() || undefined,
        trust: el.addTrustCheckbox.checked,
        trustName: el.addTrustNameInput.value.trim() || undefined,
        dryRun: false,
      }),
    });
    const data = await res.json();
    if (data.ok) await showInstalled(data);
    else
      showAddStatus(
        "Not installed",
        "Refused",
        "failed",
        showNotInstalled(data.output || data.error || "aireg did not install it."),
      );
  } catch (_) {
    showAddStatus(
      "The server did not answer",
      "Failed",
      "failed",
      showNotInstalled("Start it again with aireg ui."),
    );
  }
}

export function updateCmdSelection() {
  el.cmdResults.querySelectorAll(".cmd-item").forEach((item, idx) => {
    item.classList.toggle("selected", idx === state.cmdSelectedIndex);
  });
}

// Each modal is a dialog: named, modal, keeps focus inside, and returns it when it closes.
export function watchDialogs() {
  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
  document
    .querySelectorAll('.doctor-modal-backdrop, .cmd-palette-backdrop, [id$="ModalBackdrop"]')
    .forEach((backdrop) => {
      backdrop.setAttribute("data-dialog", "");
      const box = backdrop.firstElementChild;
      if (!box) return;
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      const title = box.querySelector('h1, h2, h3, .doctor-modal-title, [id$="Title"]');
      if (title) {
        if (!title.id) title.id = `${backdrop.id}-title`;
        box.setAttribute("aria-labelledby", title.id);
      }
      box.querySelectorAll(".modal-close").forEach((close) => {
        close.setAttribute("aria-label", "Close");
      });
      let opener = null;
      new MutationObserver(() => {
        const open = backdrop.classList.contains("open");
        if (open && !opener) {
          opener = document.activeElement;
          const first = box.querySelector(FOCUSABLE);
          setTimeout(() => (box.contains(document.activeElement) ? null : first?.focus()), 60);
        } else if (!open && opener) {
          if (opener.isConnected) opener.focus();
          opener = null;
        }
      }).observe(backdrop, { attributes: true, attributeFilter: ["class"] });
      backdrop.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const items = [...box.querySelectorAll(FOCUSABLE)].filter(
          (item) => item.offsetParent !== null,
        );
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    });
}
