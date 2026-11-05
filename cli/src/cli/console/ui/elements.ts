import { Box, Text } from "ink";
import { type Attributes, createElement, type ReactElement, type ReactNode } from "react";
import { sanitizeBlock } from "#adapter/text.ts";
import type { HintKey } from "#core/host/panel.ts";
import { COLOR } from "#core/term/theme.ts";

type BoxProps = (Parameters<typeof Box>[0] & Attributes) | null;
type TextProps = (Parameters<typeof Text>[0] & Attributes) | null;

// `createElement`, not JSX: Node's type stripping does not transform JSX.
export function box(props: BoxProps, ...children: ReactNode[]): ReactElement {
  return createElement(Box, props, ...children);
}

export function text(props: TextProps, ...children: ReactNode[]): ReactElement {
  return createElement(Text, props, ...children.map(inert));
}

/** Manifest, lockfile and registry text may carry escapes Ink would honor; styling goes through props. */
function inert(node: ReactNode): ReactNode {
  if (typeof node === "string") return sanitizeBlock(node);
  return Array.isArray(node) ? node.map(inert) : node;
}

export function plain(value: ReactNode): ReactElement {
  return createElement(Text, null, inert(value));
}

export function dim(value: ReactNode): ReactElement {
  return createElement(Text, { color: COLOR.dim }, inert(value));
}

export function faint(value: ReactNode): ReactElement {
  return createElement(Text, { color: COLOR.faint }, inert(value));
}

/** Ink has no top-only border, so the rule is drawn as text. */
export function rule(width: number): ReactElement {
  return createElement(Text, { color: COLOR.faint }, "─".repeat(Math.max(0, width)));
}

export function heading(label: string): ReactElement {
  return createElement(Text, { color: COLOR.dim }, inert(label.toUpperCase()));
}

export function action(key: string, label: string, active = true): ReactElement {
  const color = active ? COLOR.green : COLOR.faint;
  return createElement(
    Text,
    { color, bold: active },
    inert(`[${key}] `),
    createElement(Text, { color, bold: false }, inert(label)),
  );
}

export function hints(keys: readonly HintKey[]): ReactElement {
  const parts: ReactNode[] = [];
  for (const [index, hint] of keys.entries()) {
    if (index > 0) parts.push(createElement(Text, { key: `s${index}` }, "   "));
    parts.push(
      createElement(Text, { key: `k${index}`, color: COLOR.ink }, inert(hint.key)),
      createElement(Text, { key: `l${index}`, color: COLOR.faint }, inert(` ${hint.label}`)),
    );
  }
  return createElement(Box, null, ...parts);
}
