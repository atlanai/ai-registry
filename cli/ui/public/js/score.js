import { escapeHtml } from "./core.js";

const toggle = document.getElementById("skillScoreToggle");
toggle?.addEventListener("click", () => {
  const panel = document.getElementById("skillScore");
  if (!panel) return;
  if (panel.matches(":popover-open")) panel.hidePopover();
  else {
    panel.hidden = false;
    panel.showPopover();
  }
});

document.getElementById("skillScore")?.addEventListener("toggle", (event) => {
  toggle?.setAttribute("aria-expanded", String(event.newState === "open"));
});

/** Each result describes only the file just read, never an unrelated selected skill. */
export function renderScore(report) {
  const panel = document.getElementById("skillScore");
  if (!panel) return;
  panel.hidePopover();
  panel.hidden = true;
  if (toggle) {
    toggle.hidden = report == null;
    toggle.textContent =
      report?.status === "scored" ? `Score ${report.score}/100` : "Score unavailable";
    toggle.setAttribute("aria-expanded", "false");
  }
  panel.innerHTML = "";
  if (report == null) return;
  if (report.status !== "scored") {
    panel.innerHTML =
      "<h2>Skill assessment</h2><p>Checks unavailable: the file is missing, empty, or too large to assess.</p>";
    return;
  }
  const fixes = report.checks.filter((check) => check.earned < check.points);
  const rows = report.checks
    .map(
      (check) => `
    <li class="score-check">
      <div><strong>${escapeHtml(check.label)}</strong><span>${check.earned === check.points ? "Detected" : "Review"}</span></div>
      <p>${escapeHtml(check.evidence)}</p>
      ${check.earned < check.points ? `<p class="score-fix">${escapeHtml(check.improvement)}</p>` : ""}
    </li>`,
    )
    .join("");
  panel.innerHTML = `
    <div class="score-heading"><h2>Score: ${report.score}/100</h2><span class="score-status">Preliminary checklist</span></div>
    <p><strong>${report.checks.length - fixes.length} of ${report.checks.length} authoring signals detected.</strong> These are structural clues in this SKILL.md, not a quality grade.</p>
    <p>Detection uses English headings and text patterns. “Not found” can mean the guidance is written differently or lives in supporting files. Review before adding boilerplate.</p>
    <div class="score-next"><strong>${fixes.length ? "Review first" : "Next: review and test"}</strong>
      <p>${escapeHtml(fixes[0]?.improvement || "Review the instructions, then compare real tasks with and without this skill.")}</p></div>
    <details><summary>See all ${report.checks.length} checks and evidence</summary><ul class="score-checks">${rows}</ul></details>
    <details><summary>What still needs review</summary><ul>${report.review.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul></details>
    <div class="score-unmeasured"><span>Safety: not assessed</span><span>Performance: not measured</span></div>
    <small>Rubric: ${escapeHtml(report.rubric)} · No skill code executed or sent to an AI service.</small>`;
}
