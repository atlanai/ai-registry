import type { ReactElement, ReactNode } from "react";
import type { ArtifactGroup, ArtifactRow, ArtifactState } from "#core/console/model.ts";
import { ARTIFACT_STATES } from "#core/console/model.ts";
import { STATE_MEANING, stateStyle } from "#core/console/state-style.ts";
import type { HintKey } from "#core/host/panel.ts";
import { ago, duration, pad, shortDigest, truncate, truncateStart } from "#core/term/format.ts";
import { COLOR, GLYPH } from "#core/term/theme.ts";
import { action, box, dim, faint, plain, text } from "./elements.ts";

export function artifactDetail(props: {
  width: number;
  row: ArtifactRow;
  url: string | undefined;
  /** The app the link belongs to, named by whichever adapter served the row. */
  app: string;
}): ReactElement {
  const row = props.row;
  const style = stateStyle(row.state);
  const width = props.width;
  // Nothing was fetched, so there is no id, digest, copy or link: the panel says why
  // rather than printing a column of blanks.
  const bodiless = row.state === "failed" && row.id === "";
  const rows: (ReactElement | undefined)[] = [
    known("id", row.id),
    known(
      "version",
      row.version,
      box(
        null,
        text({ color: COLOR.white }, row.version ?? ""),
        faint(`   ${row.kind}${row.registry === "" ? "" : ` from ${row.registry}`}`),
      ),
    ),
    field(
      "state",
      box(
        null,
        text({ color: style.color }, `${style.glyph} ${row.state}`),
        faint(`   ${STATE_MEANING[row.state]}`),
      ),
    ),
    row.detail === undefined
      ? undefined
      : field("reason", text({ color: COLOR.yellow }, truncate(row.detail, width - 18))),
    known("lockfile", shortDigest(row.lockDigest), faint(shortDigest(row.lockDigest))),
    known(
      "on disk",
      shortDigest(row.diskDigest),
      box(
        null,
        text(
          { color: row.state === "edited" ? COLOR.yellow : COLOR.faint },
          shortDigest(row.diskDigest),
        ),
        row.state === "edited"
          ? text({ color: COLOR.yellow }, "   differs, so this is your edit")
          : plain(""),
      ),
    ),
    known("copy", row.copy, faint(truncateStart(row.copy, width - 18))),
    known("changed", row.changedAtMs === undefined ? undefined : ago(row.changedAtMs)),
  ];

  return panel(
    `${row.namespace ?? "this machine"} / ${row.name}   ${row.state.toUpperCase()}`,
    width,
    ...rows.filter((node): node is ReactElement => node !== undefined),
    bodiless
      ? box(
          { marginTop: 1 },
          faint(
            "The catalog lists it and the registry will not serve it, so nothing " +
              "was fetched: there is no version, digest or copy to show.",
          ),
        )
      : plain(""),
    row.links.length === 0
      ? plain("")
      : box(
          { marginTop: 1, flexDirection: "column" },
          box(null, dim(pad("links", 12)), plain("")),
          ...row.links.map((link) =>
            box(
              { key: link.path },
              plain(" ".repeat(12)),
              text(
                { color: link.ok ? COLOR.green : COLOR.orange },
                `${link.ok ? GLYPH.ok : GLYPH.dangling} `,
              ),
              dim(pad(link.target, 10)),
              faint(truncateStart(link.path, width - 30)),
            ),
          ),
        ),
    box(
      { marginTop: 1 },
      row.state === "edited"
        ? action("p", `publish this edit to ${row.namespace ?? "its registry"}`)
        : faint("nothing to publish: only an edited artifact can be sent back"),
      plain("      "),
      props.url === undefined
        ? faint("[o] nothing upstream to open")
        : action("o", `open in ${props.app}`),
      plain("      "),
      action("esc", "close"),
    ),
  );
}

/** Only the fields the artifact actually has: an empty row says nothing. */
function known(
  label: string,
  value: string | undefined,
  node?: ReactNode,
): ReactElement | undefined {
  if (value === undefined || value === "" || value === "\u2014") return undefined;
  return field(label, node ?? text({ color: COLOR.white }, value));
}

function field(label: string, value: ReactNode): ReactElement {
  return box(null, dim(pad(label, 12)), value);
}

function panel(title: string, width: number, ...children: ReactNode[]): ReactElement {
  return box(
    {
      flexDirection: "column",
      width,
      borderStyle: "round",
      borderColor: COLOR.faint,
      paddingX: 1,
    },
    box(
      { justifyContent: "space-between" },
      text({ color: COLOR.white, bold: true }, title),
      plain(""),
    ),
    box({ flexDirection: "column", marginTop: 1 }, ...children),
  );
}

export interface PublishPlan {
  title: string;
  /** The registry the publish is addressed to. */
  alias: string | undefined;
  /** Namespace it will land in, which is what a person recognizes. */
  namespace: string | undefined;
  send: ArtifactRow[];
  skip: { row: ArtifactRow; why: string }[];
  /** Set for the local group, whose members publish together or not at all. */
  wholeGroupOnly: boolean;
  /** Something the registry will refuse, said before the key is pressed. */
  caution: string | undefined;
  command: string;
}

export function publishConfirm(props: { width: number; plan: PublishPlan }): ReactElement {
  const width = props.width;
  const plan = props.plan;
  return panel(
    `publish ${plan.title}`,
    width,
    box(
      null,
      dim("to   "),
      text(
        { color: COLOR.white, inverse: true },
        ` ${plan.namespace ?? plan.alias ?? "its registry"} `,
      ),
      faint("   where it came from"),
    ),
    box(
      { marginTop: 1, flexDirection: "column" },
      ...plan.send.map((row) =>
        box(
          { key: row.key },
          text(
            { color: row.state === "edited" ? COLOR.yellow : COLOR.green },
            `  ${row.state === "edited" ? GLYPH.edited : "+"} `,
          ),
          text({ color: COLOR.white }, pad(row.name, 30)),
          dim(
            row.state === "edited"
              ? `${row.version ?? "-"} → new version`
              : "new · never published",
          ),
        ),
      ),
      ...plan.skip.map(({ row, why }) =>
        box(
          { key: `s-${row.key}` },
          text({ color: COLOR.red }, `  ${GLYPH.failed} `),
          text({ color: COLOR.white }, pad(row.name, 30)),
          text({ color: COLOR.red }, why),
        ),
      ),
    ),
    plan.send.length === 0
      ? box(
          { marginTop: 1 },
          text({ color: COLOR.yellow }, "  Nothing here has changed, so this would send nothing."),
        )
      : plain(""),
    plan.caution === undefined
      ? plain("")
      : box(
          { marginTop: 1 },
          text({ color: COLOR.red }, `  ${GLYPH.failed} `),
          text({ color: COLOR.red }, truncate(plan.caution, width - 8)),
        ),
    plan.wholeGroupOnly
      ? box(
          { marginTop: 1 },
          faint("  Publishing the group sends all of it; `p` on one row sends only that one."),
        )
      : plain(""),
    box({ marginTop: 1 }, dim("  runs  "), faint(plan.command)),
    box(
      { marginTop: 1 },
      plan.send.length === 0
        ? faint("  [enter] nothing to do")
        : text(
            { color: COLOR.white, inverse: true, bold: true },
            ` Publish ${plan.send.length}${plan.skip.length > 0 ? `, skip ${plan.skip.length}` : ""} `,
          ),
      plain("    "),
      action("esc", "cancel"),
    ),
  );
}

/** The most of a command's output the activity panel ever shows. */
const ACTIVITY_LINES = 16;

/**
 * A command's output with one more line, kept to what the panel can show: a
 * verbose child would otherwise grow it, and copy it, for every line it writes.
 */
export function withLine(lines: readonly string[], line: string): string[] {
  return [...lines.slice(-(ACTIVITY_LINES - 1)), line];
}

export function activityPanel(props: {
  width: number;
  label: string;
  command: string;
  lines: readonly string[];
  done: boolean;
  code: number | undefined;
  /** What the run's own counts say it has got through, while it is going. */
  progress: string | undefined;
  /** Shown from 2 s on: a publish uploads one artifact at a time. */
  elapsedMs: number;
  /**
   * What the state actually says now that it has finished, read back rather
   * than inferred from the exit code. A command can exit 0 and change nothing.
   */
  changed: readonly string[] | undefined;
}): ReactElement {
  const width = props.width;
  const tail = props.lines.slice(-(props.changed === undefined ? ACTIVITY_LINES : 8));
  return panel(
    props.label,
    width,
    box(null, dim("$ "), text({ color: COLOR.faint, wrap: "truncate" }, props.command)),
    box(
      { marginTop: 1 },
      text({ color: COLOR.yellow }, `  ${props.progress ?? (props.done ? "" : "working\u2026")}`),
      props.elapsedMs < 2_000 ? plain("") : faint(`   ${duration(props.elapsedMs)}`),
    ),
    box(
      { marginTop: 1, flexDirection: "column" },
      ...tail.map((line, index) => box({ key: `l${index}` }, faint(truncate(line, width - 6)))),
      tail.length === 0 ? box(null, faint("starting…")) : plain(""),
    ),
    props.changed === undefined
      ? plain("")
      : box(
          { marginTop: 1, flexDirection: "column" },
          text({ color: COLOR.white, bold: true }, "  What changed"),
          ...(props.changed.length === 0
            ? [box(null, text({ color: COLOR.orange }, "    nothing on this machine"))]
            : props.changed.map((line, index) =>
                box({ key: `c${index}` }, text({ color: COLOR.green }, `    ${line}`)),
              )),
        ),
    box(
      { marginTop: 1 },
      props.done
        ? text(
            { color: props.code === 0 ? COLOR.green : COLOR.red },
            props.code === 0 ? "finished" : `exited ${props.code}`,
          )
        : text({ color: COLOR.yellow }, "running…"),
      plain("    "),
      action("esc", props.done ? "close and reload" : "cancel"),
    ),
  );
}

export function helpPanel(width: number, keys: readonly HintKey[]): ReactElement {
  return panel(
    "Keys",
    width,
    ...keys.map(({ key, label }) =>
      box({ key }, text({ color: COLOR.white }, pad(key, 18)), faint(label)),
    ),
    box({ marginTop: 1 }, text({ color: COLOR.white, bold: true }, "States")),
    ...ARTIFACT_STATES.map((state: ArtifactState) => {
      const style = stateStyle(state);
      return box(
        { key: state },
        text({ color: style.color }, `${style.glyph}  `),
        text({ color: style.color }, pad(state, 15)),
        faint(STATE_MEANING[state]),
      );
    }),
  );
}

export function groupTitle(group: ArtifactGroup): string {
  return group.authoredHere ? "THIS MACHINE" : group.label;
}
