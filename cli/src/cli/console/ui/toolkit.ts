import type { ReactNode } from "react";
import { windowAround } from "#cli/console/data/list.ts";
import type { PanelBoxProps, PanelNode, PanelTextProps, PanelToolkit } from "#core/host/panel.ts";
import {
  ago,
  bar,
  bytes,
  clock,
  day,
  interval,
  pad,
  truncate,
  truncateStart,
} from "#core/term/format.ts";
import { COLOR, GLYPH } from "#core/term/theme.ts";
import { summaryStrip } from "./chrome.ts";
import { action, box, dim, faint, heading, plain, rule, text } from "./elements.ts";

// `PanelNode` is `unknown` on the panel's side, which is what these casts pay for.
const node = (value: PanelNode): ReactNode => value as ReactNode;
const nodes = (values: PanelNode[]): ReactNode[] => values.map(node);

export const toolkit: PanelToolkit = {
  box: (props: PanelBoxProps | null, ...children: PanelNode[]) =>
    box(props as Parameters<typeof box>[0], ...nodes(children)),
  text: (props: PanelTextProps | null, ...children: PanelNode[]) =>
    text(props as Parameters<typeof text>[0], ...nodes(children)),
  plain: (value) => plain(node(value)),
  dim: (value) => dim(node(value)),
  faint: (value) => faint(node(value)),
  rule,
  heading,
  action,
  summaryStrip: (props) =>
    summaryStrip({
      width: props.width,
      title: node(props.title),
      badge: props.badge,
      lines: nodes(props.lines),
      hint: props.hint,
    }),
  color: COLOR,
  glyph: GLYPH,
  format: { ago, bar, bytes, clock, day, interval, pad, truncate, truncateStart },
  window: windowAround,
};
