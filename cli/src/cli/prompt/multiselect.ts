import { plural } from "#adapter/text.ts";
import { windowAround } from "#cli/console/model/list.ts";
import type { Styler } from "#core/output.ts";
import { displayWidth } from "#core/term/format.ts";
import { GLYPH } from "#core/term/theme.ts";
import { fitLines, footerLines, heightOf, type Mark, railLine, titleLine } from "./layout.ts";
import {
  ask,
  CANCEL,
  type Canceled,
  type Keypress,
  type Machine,
  type PromptIo,
  type Size,
} from "./prompt.ts";
import { type Fill, type Node, outline, plant, Selection } from "./tree.ts";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string | undefined;
  group?: string | undefined;
  section?: string | undefined;
  detail?: string | undefined;
}

export interface MultiselectOptions<T> {
  message: string;
  choices: Choice<T>[];
  style: Styler;
  initial?: readonly T[] | undefined;
  required?: boolean | undefined;
  /** Group headings become collapsible rows that toggle their whole group. */
  groups?: boolean | undefined;
  /** Adds a Select all row, and lets `a` select or clear every top-level row. */
  selectAll?: boolean | undefined;
  groupValues?: ReadonlyMap<string, T> | undefined;
  groupDetails?: ReadonlyMap<string, string> | undefined;
  /** Shown dim beside a group's name, such as what kinds it holds. */
  groupHints?: ReadonlyMap<string, string> | undefined;
  collapsed?: boolean | undefined;
  detail?: boolean | undefined;
  detailLines?: number | undefined;
  maxVisible?: number | undefined;
}

const VISIBLE = 8;
const DETAIL_LINES = 2;
/** The fewest list rows worth keeping the description for. */
const MINIMUM_ROWS = 3;
/** Rail, cursor and the description's arrow, plus a cell of margin. */
const DETAIL_INSET = 7;
const DIVIDER_WIDTH = 24;

/** The Select all row, which sits above the tree rather than in it. */
const ALL = Symbol("all");
type Row<T> = Node<T> | typeof ALL;

class Picking<T> implements Machine<T[]> {
  private readonly options: MultiselectOptions<T>;
  private readonly top: Node<T>[];
  private readonly selection: Selection<T>;
  private readonly folded: Set<string>;
  private at: Row<T> | undefined;
  private ended: Mark = "active";

  constructor(options: MultiselectOptions<T>) {
    this.options = options;
    this.top = plant(options.choices, options.groups === true, options.groupValues);
    this.selection = new Selection(this.top, options.initial ?? []);
    this.folded = new Set(
      options.collapsed === true
        ? this.top.flatMap((node) => (node.kind === "group" ? [node.key] : []))
        : [],
    );
    this.at = this.top[0];
  }

  private rows(): Row<T>[] {
    const tree = outline(this.top, this.folded);
    return this.options.selectAll === true ? [ALL, ...tree] : tree;
  }

  press(key: Keypress): { answer: T[] | Canceled } | undefined {
    if (this.ended !== "active") return undefined;
    const at = this.at;
    if (key.cancel) {
      this.ended = "cancel";
      return { answer: CANCEL };
    }
    if (key.enter) {
      if (this.options.required === true && this.selection.picked.size === 0) return undefined;
      this.ended = "submit";
      return { answer: [...this.selection.picked] };
    }
    if (at === undefined) return undefined;
    if (at === ALL) this.pressOnAll(key);
    else this.pressOn(at, key);
    return undefined;
  }

  private pressOnAll(key: Keypress): void {
    const rows = this.rows();
    if (key.up || key.down) this.at = rows[key.up ? 0 : Math.min(rows.length - 1, 1)];
    else if (!key.modified && (key.text === " " || key.text === "a")) this.selection.toggleAll();
  }

  private pressOn(at: Exclude<Row<T>, typeof ALL>, key: Keypress): void {
    const rows = this.rows();
    const index = rows.indexOf(at);
    if (key.up) this.at = rows[Math.max(0, index - 1)];
    else if (key.down) this.at = rows[Math.min(rows.length - 1, index + 1)];
    else if (key.right) {
      if (at.kind !== "leaf") this.folded.delete(at.key);
    } else if (key.left) this.foldAt(at);
    else if (key.modified) return;
    else if (key.text === " ") this.selection.toggle(at);
    else if (key.text === "a" && this.options.selectAll === true) this.selection.toggleAll();
  }

  /** Folds a group, or from a leaf folds its group and moves up to it. */
  private foldAt(at: Exclude<Row<T>, typeof ALL>): void {
    if (at.kind !== "leaf") this.folded.add(at.key);
    else if (at.parent !== undefined) {
      this.folded.add(at.parent.key);
      this.at = at.parent;
    }
  }

  lines(size: Size): string[] {
    const { style, message } = this.options;
    if (this.ended === "cancel")
      return [titleLine(style, "cancel", message, style.dim("canceled"))];
    if (this.ended === "submit") {
      const picked = this.selection.labels();
      const answer = picked.length === 0 ? "nothing selected" : picked.join(", ");
      return [titleLine(style, "submit", message, style.dim(answer))];
    }

    const total = this.options.choices.length;
    const title = titleLine(
      style,
      "active",
      message,
      style.dim(`${this.selection.covered()} of ${total} selected`),
    );
    const footer = footerLines(style, this.keys());
    const rows = this.rows();
    // The divider under Select all is a line of its own, kept out of the rows.
    const divider = this.options.selectAll === true ? [""] : [];
    const fixed = heightOf([title, "", "", ...divider, ...footer], size.columns);
    const fit = this.allot(rows.length, fixed, size);
    const shown = windowAround(rows.length, Math.max(0, rows.indexOf(this.at as Row<T>)), fit.size);
    const list = rows
      .slice(shown.from, shown.to)
      .flatMap((node) => (node === ALL ? [this.row(node), this.divider()] : [this.row(node)]));
    const beyond = [
      ...(shown.from > 0 ? [`${shown.from} above`] : []),
      ...(shown.to < rows.length ? [`${rows.length - shown.to} below`] : []),
    ];
    if (beyond.length > 0) list.push(railLine(style, style.dim(beyond.join(", "))));

    const detail = fit.detail ? [...this.detailRows(size.columns), railLine(style)] : [];
    return [title, railLine(style), ...list, railLine(style), ...detail, ...footer];
  }

  private keys(): string[] {
    const { groups, selectAll } = this.options;
    return [
      `${GLYPH.upDown} move`,
      ...(groups === true ? [`${GLYPH.leftRight} fold`] : []),
      "space pick",
      ...(selectAll === true ? ["a all"] : []),
      "enter next",
      "esc cancel",
    ];
  }

  /** The list gets what is left; the description goes only when even a short list cannot fit. */
  private allot(total: number, fixed: number, size: Size): { size: number; detail: boolean } {
    const limit = size.rows === undefined ? Number.POSITIVE_INFINITY : size.rows - 1;
    const most = this.options.maxVisible ?? VISIBLE;
    // A list that does not fit gives one row to the count of what is off screen.
    const rowsIn = (space: number): number =>
      total <= Math.min(space, most) ? total : Math.max(0, Math.min(most, space - 1));
    const lines = this.options.detailLines ?? DETAIL_LINES;
    if (this.options.detail === true) {
      const rows = rowsIn(limit - fixed - lines - 1);
      if (rows >= Math.min(MINIMUM_ROWS, total, most)) return { size: rows, detail: true };
    }
    return { size: Math.max(1, rowsIn(limit - fixed)), detail: false };
  }

  private row(node: Row<T>): string {
    const { style } = this.options;
    const on = node === this.at;
    const cursor = on ? `${style.cyan(GLYPH.cursor)} ` : "  ";
    const body = node === ALL ? this.allBody(on) : this.body(node, on);
    return `${style.dim(GLYPH.pipe)} ${cursor}${body}`;
  }

  private divider(): string {
    const { style } = this.options;
    return `${style.dim(GLYPH.pipe)}   ${style.dim(GLYPH.rule.repeat(DIVIDER_WIDTH))}`;
  }

  private radio(fill: Fill): string {
    const { style } = this.options;
    if (fill === "all") return style.green(GLYPH.bullet);
    return fill === "some" ? style.yellow(GLYPH.partial) : style.dim(GLYPH.hollow);
  }

  private nameWidth(): number {
    return Math.max(
      0,
      ...this.top.map((node) => (node.kind === "group" ? displayWidth(node.label) : 0)),
    );
  }

  private allBody(on: boolean): string {
    const full = this.top.filter((node) => this.selection.fill(node) === "all").length;
    const fill: Fill = full === 0 ? "none" : full === this.top.length ? "all" : "some";
    // The title already counts what is selected, in the same units the tree picks.
    const label = "Select all";
    return `${this.radio(fill)} ${on ? this.options.style.cyan(label) : label}`;
  }

  private body(node: Node<T>, on: boolean): string {
    const { style } = this.options;
    const radio = this.radio(this.selection.fill(node));
    if (node.kind !== "leaf") {
      const fold = style.dim(this.folded.has(node.key) ? GLYPH.folded : GLYPH.open);
      if (node.kind === "group") {
        const hint = this.options.groupHints?.get(node.label) ?? `(${node.leaves.length})`;
        const name = style.bold(on ? style.cyan(node.label) : node.label);
        // Hints line up in one column, after the longest group name.
        const pad = " ".repeat(this.nameWidth() - displayWidth(node.label) + 2);
        return `${fold} ${radio} ${name}${pad}${style.dim(hint)}`;
      }
      const label = `${node.label} (${node.leaves.length})`;
      return `  ${fold} ${radio} ${on ? style.cyan(label) : style.dim(label)}`;
    }
    const { choice, depth } = node;
    const twig = depth === 0 ? "" : style.dim(node.last ? GLYPH.twigLast : GLYPH.twig);
    // Under a section the kind is the heading, so a hint would repeat it.
    const hint =
      choice.hint !== undefined && choice.hint !== "" && node.parent?.kind !== "section"
        ? style.dim(` ${choice.hint}`)
        : "";
    const label = on ? style.cyan(choice.label) : choice.label;
    return `${" ".repeat(depth * 2)}${twig}${radio} ${label}${hint}`;
  }

  private detailRows(columns: number): string[] {
    const { style } = this.options;
    const text =
      this.at === undefined
        ? undefined
        : this.at === ALL
          ? `Select or clear every row below: ${this.top.length} in all.`
          : this.describe(this.at);
    const lines = fitLines(text, columns - DETAIL_INSET, this.options.detailLines ?? DETAIL_LINES);
    return lines.map((line, index) =>
      line === ""
        ? railLine(style)
        : railLine(style, style.dim(`${index === 0 ? GLYPH.aside : " "} ${line}`)),
    );
  }

  private describe(node: Node<T>): string | undefined {
    if (node.kind === "leaf") return node.choice.detail;
    const count = node.leaves.length;
    if (node.kind === "section") {
      return `Every ${node.label} artifact in ${node.group}: ${count} in all.`;
    }
    return (
      this.options.groupDetails?.get(node.label) ??
      `Everything in ${node.label}: ${plural(count, "artifact")}.`
    );
  }
}

export async function multiselect<T>(
  options: MultiselectOptions<T>,
  io: PromptIo,
): Promise<T[] | Canceled> {
  if (options.choices.length === 0) return CANCEL;
  return await ask(io, new Picking(options));
}
