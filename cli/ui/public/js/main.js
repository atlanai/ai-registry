// Wires the modules together, the keyboard, and starts the page.
import {
  loadArtifacts,
  navigateStream,
  renderSidebarCounts,
  renderStream,
  selectArtifact,
  stillReading,
} from "./catalog.js";
import { announce, el, hooks, state } from "./core.js";
import {
  closeAddModal,
  closeCommandPalette,
  closeDoctorModal,
  closeRetireModal,
  confirmAdd,
  confirmRetire,
  openAddModal,
  openCommandPalette,
  openDoctorModal,
  openRetireModal,
  renderCommandMatches,
  runAddDryRun,
  updateCmdSelection,
  watchDialogs,
} from "./dialogs.js";
import {
  loadConsoleData,
  renderAuditDashboard,
  renderSyncEngineDashboard,
  startCountdownTicker,
  triggerSync,
  updateAttentionCounts,
} from "./machine.js";

// Mode Switcher Handler
export function switchMode(mode) {
  state.activeMode = mode;

  el.modeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
  });

  // Toggle views
  el.viewArtifacts.style.display = mode === "artifacts" ? "flex" : "none";
  el.viewSyncEngine.style.display = mode === "sync" ? "flex" : "none";
  el.viewAudit.style.display = mode === "audit" ? "flex" : "none";

  // Toggle sidebar content
  el.sidebarArtifactsMode.style.display = mode === "artifacts" ? "flex" : "none";
  el.sidebarSyncMode.style.display = mode === "sync" ? "flex" : "none";
  el.sidebarAuditMode.style.display = mode === "audit" ? "flex" : "none";

  if (mode === "sync") {
    renderSyncEngineDashboard();
  } else if (mode === "audit") {
    void renderAuditDashboard();
  }
}

// Event Handlers
export function initEvents() {
  wireModes();
  wireFilters();
  wireDialogs();
  wireCopyButtons();
  el.refreshBtn.addEventListener("click", triggerSync);
  el.dashSyncBtn.addEventListener("click", triggerSync);
  el.cmdInput.addEventListener("input", (e) => renderCommandMatches(e.target.value));
  window.addEventListener("keydown", onKey);
}

function wireModes() {
  for (const btn of el.modeBtns) {
    btn.addEventListener("click", () => switchMode(btn.getAttribute("data-mode")));
  }
  if (!el.auditCategoryNav) return;
  for (const item of el.auditCategoryNav.querySelectorAll(".nav-item")) {
    item.addEventListener("click", () => {
      for (const other of el.auditCategoryNav.querySelectorAll(".nav-item"))
        other.classList.remove("active");
      item.classList.add("active");
      state.auditFilter = item.getAttribute("data-audit");
      void renderAuditDashboard();
    });
  }
}

/** Namespace and target filters, drawn from the data, chosen by click or Enter. */
function wireFilters() {
  el.sidebarSearchInput.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderStream();
  });
  el.sortSelect.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderStream();
  });
  const pick = (list, attr, key) => {
    const choose = (event) => {
      const item = event.target.closest(".nav-item");
      if (!item || !list.contains(item)) return;
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      state[key] = item.getAttribute(attr);
      renderSidebarCounts();
      renderStream();
    };
    list.addEventListener("click", choose);
    list.addEventListener("keydown", choose);
  };
  pick(el.namespaceNav, "data-ns", "activeNamespace");
  pick(el.harnessNav, "data-harness", "activeHarness");
}

/** Each dialog opens from its button and closes on its close button, Cancel, or the backdrop. */
function wireDialogs() {
  const dialog = (backdrop, close, buttons) => {
    for (const [button, handler] of buttons) button?.addEventListener("click", handler);
    backdrop?.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
  };
  dialog(el.retireModalBackdrop, closeRetireModal, [
    [el.retireSkillBtn, openRetireModal],
    [el.retireModalClose, closeRetireModal],
    [el.retireCancelBtn, closeRetireModal],
    [el.retireConfirmBtn, confirmRetire],
  ]);
  dialog(el.addModalBackdrop, closeAddModal, [
    [el.addArtifactBtn, openAddModal],
    [el.addModalClose, closeAddModal],
    [el.addCancelBtn, closeAddModal],
    [el.addPreviewBtn, runAddDryRun],
    [el.addConfirmBtn, confirmAdd],
  ]);
  dialog(el.doctorModalBackdrop, closeDoctorModal, [
    [el.doctorModalBtn, openDoctorModal],
    [el.doctorModalClose, closeDoctorModal],
  ]);
  el.cmdKBtn.addEventListener("click", openCommandPalette);
}

/** Copies a command or a digest, and says whether it worked. */
function wireCopyButtons() {
  const copy = (button, text) => {
    const label = button.querySelector("span");
    const was = label ? label.textContent : "";
    navigator.clipboard.writeText(text).then(
      () => {
        if (label) label.textContent = "Copied";
        announce(`Copied ${text}`);
      },
      () => announce("Could not copy; select the text instead."),
    );
    setTimeout(() => {
      if (label) label.textContent = was;
    }, 1200);
  };
  const selected = () => state.artifacts.find((a) => a.key === state.selectedKey);
  el.copyCliBtn.addEventListener("click", () => {
    const art = selected();
    // `aireg show` takes the registry's full address; work written here is read from its folder.
    if (art) copy(el.copyCliBtn, art.listed ? `aireg show ${art.key}` : `aireg show ${art.path}`);
  });
  el.copyDigestBtn.addEventListener("click", () => {
    const art = selected();
    if (art?.digest) copy(el.copyDigestBtn, art.digest);
  });
}

function typingIn(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function closeAll() {
  if (state.cmdPaletteOpen) closeCommandPalette();
  if (el.doctorModalBackdrop.classList.contains("open")) closeDoctorModal();
  if (el.retireModalBackdrop?.classList.contains("open")) closeRetireModal();
  if (el.addModalBackdrop?.classList.contains("open")) closeAddModal();
}

function paletteKey(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    state.cmdSelectedIndex = Math.max(
      0,
      Math.min(state.cmdSelectedIndex + step, state.cmdMatches.length - 1),
    );
    updateCmdSelection();
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const match = state.cmdMatches[state.cmdSelectedIndex];
  if (!match) return;
  switchMode("artifacts");
  void selectArtifact(match.key);
  closeCommandPalette();
}

/** ⌘K and Escape anywhere; list keys only in the list, never while typing or behind a dialog. */
function onKey(e) {
  const quiet = typingIn(e.target) || Boolean(document.querySelector(".open[data-dialog]"));
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    if (state.cmdPaletteOpen) closeCommandPalette();
    else openCommandPalette();
  } else if (e.key === "Escape") {
    closeAll();
  } else if (state.cmdPaletteOpen) {
    paletteKey(e);
  } else if (quiet) {
    return;
  } else if (
    el.artifactsList.contains(e.target) &&
    ["ArrowDown", "j", "ArrowUp", "k"].includes(e.key)
  ) {
    // Single-letter keys act only while focus is in the list they move (WCAG 2.1.4).
    e.preventDefault();
    navigateStream(e.key === "ArrowDown" || e.key === "j" ? 1 : -1);
  }
}

// Init: the calls other modules make back up the graph.
Object.assign(hooks, { loadArtifacts, renderAuditDashboard, switchMode, updateAttentionCounts });

watchDialogs();
initEvents();
void loadArtifacts();
void loadConsoleData();
startCountdownTicker();
keepReading();

/** Reads again on its own: soon while a registry is still answering, else every so often. */
function keepReading() {
  setTimeout(
    async () => {
      if (document.visibilityState === "visible" && !state.syncing) {
        await loadArtifacts();
        await loadConsoleData();
      }
      keepReading();
    },
    stillReading() ? 3000 : 15000,
  );
}
