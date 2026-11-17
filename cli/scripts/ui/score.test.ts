import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../../ui/public/js/score.js", import.meta.url), "utf8");

test("assessment opens on demand and resets when the selected file changes", () => {
  const panel = {
    hidden: true,
    innerHTML: "",
    open: false,
    matches() {
      return this.open;
    },
    showPopover() {
      this.open = true;
    },
    hidePopover() {
      this.open = false;
    },
    addEventListener() {},
  };
  let click = () => {};
  const toggle = {
    hidden: true,
    expanded: "false",
    addEventListener(_event: string, handler: () => void) {
      click = handler;
    },
    setAttribute(_name: string, value: string) {
      this.expanded = value;
    },
  };
  const { renderScore } = runInNewContext(
    `${source.replace(/^import .*$/gm, "").replace(/^export /gm, "")}\n({ renderScore });`,
    {
      document: { getElementById: (id: string) => (id === "skillScore" ? panel : toggle) },
      escapeHtml: (s: string) => s,
    },
  );
  renderScore({ status: "scored", score: 100, checks: [], review: [], rubric: "test" });
  expect(toggle.hidden).toBe(false);
  expect(panel.hidden).toBe(true);
  expect(panel.innerHTML).toContain("Preliminary checklist");
  expect(panel.innerHTML).toContain("100/100");
  click();
  expect(panel.hidden).toBe(false);
  expect(panel.open).toBe(true);
  click();
  expect(panel.open).toBe(false);
  click();
  renderScore(null);
  expect(toggle.hidden).toBe(true);
  expect(toggle.expanded).toBe("false");
  expect(panel.hidden).toBe(true);
  expect(panel.innerHTML).toBe("");
  renderScore({ status: "unavailable" });
  expect(toggle.hidden).toBe(false);
  expect(panel.open).toBe(false);
  click();
  expect(panel.innerHTML).toContain("Checks unavailable");
});
