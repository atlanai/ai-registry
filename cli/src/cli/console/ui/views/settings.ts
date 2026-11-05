import type { ReactElement, ReactNode } from "react";
import { box, dim, faint, heading, text } from "#cli/console/ui/elements.ts";
import { defineView } from "#cli/console/ui/screen.ts";
import { underHome } from "#cli/render/home.ts";
import { STEP_POLICIES } from "#core/config/model.ts";
import { configPath } from "#core/config/repository.ts";
import type { ConsoleState } from "#core/console/model.ts";
import { POLICY_AXES, type PolicyAxis, type SyncPolicy } from "#core/sync/policy.ts";
import { interval, pad } from "#core/term/format.ts";
import { COLOR } from "#core/term/theme.ts";

export const SETTINGS_VIEW = defineView<readonly PolicyAxis[]>("settings", {
  model: () => POLICY_AXES,
  length: (axes) => axes.length,
  body: ({ frame, cursor }) =>
    settingsView({
      width: frame.width,
      state: frame.state,
      cursor,
      extra: frame.blocks("settings"),
    }),
  keys: {},
});

/** What each of `STEP_POLICIES` means on an axis, in that order. */
const MEANING: Record<PolicyAxis, readonly string[]> = {
  pull: ["take what changed in the registry", "say it changed, take nothing", "do not look"],
  publish: ["send your edits up", "say you edited it, send nothing", "do not look"],
  delete: ["remove what vanished", "say it vanished, remove nothing", "do not look"],
  adopt: ["send work no registry has yet", "say it is new, send nothing", "do not look"],
  claim: ["manage a folder that matches the registry", "say it matches, leave it", "do not look"],
};

/** Read-only on purpose: a write from a scrolling list is how a policy changes by accident. */
export function settingsView(props: {
  width: number;
  state: ConsoleState;
  cursor: number;
  /** A section per contributed panel, for a setting aireg does not name. */
  extra: ReactNode[];
}): ReactElement {
  const policy = props.state.policy;
  return box(
    { flexDirection: "column", width: props.width },
    box(
      { justifyContent: "space-between" },
      heading("settings"),
      faint(`${props.state.account?.registry ?? "no account"} · reads ${underHome(configPath())}`),
    ),
    box({ marginTop: 1 }, heading("sync policy")),
    ...POLICY_AXES.map((axis, index) =>
      box(
        { key: axis },
        axisRow(
          axis,
          STEP_POLICIES,
          MEANING[axis],
          policy === undefined ? undefined : effective(policy, axis),
          index === props.cursor,
        ),
      ),
    ),
    policy === undefined
      ? box(null, faint("    no artifacts job on this machine, so no policy applies"))
      : box(null, faint("    change with `aireg job add` or `aireg sync --pull ...`")),

    box({ marginTop: 1 }, heading("schedule")),
    ...props.state.jobs.map((job) =>
      box(
        { key: job.id },
        dim(`    ${pad(job.id, 26)}`),
        text({ color: COLOR.white }, pad(interval(job.intervalSeconds), 14)),
        text(
          { color: job.enabled ? COLOR.green : COLOR.faint },
          pad(job.enabled ? "enabled" : "disabled", 12),
        ),
        faint(job.summary),
      ),
    ),

    ...props.extra,

    box({ marginTop: 1 }, heading("publish")),
    box(
      null,
      dim(`    ${pad("publishes to", 20)}`),
      text({ color: COLOR.white }, pad(props.state.account?.defaultNamespace ?? "not set", 26)),
      faint("used when a row names no namespace"),
    ),
    box(
      null,
      dim(`    ${pad("registry", 20)}`),
      text({ color: COLOR.white }, props.state.account?.registry ?? "-"),
    ),
  );
}

function axisRow(
  axis: string,
  options: readonly string[],
  meaning: readonly string[],
  current: string | undefined,
  selected: boolean,
): ReactElement {
  const chosen = options.indexOf(current ?? "");
  return box(
    { ...(selected ? { backgroundColor: COLOR.selection } : {}) },
    dim(`    ${pad(axis, 14)}`),
    ...options.map((option) =>
      text(
        {
          key: option,
          color: option === current ? COLOR.white : COLOR.faint,
          inverse: option === current,
        },
        pad(` ${option} `, 10),
      ),
    ),
    faint(`     ${chosen === -1 ? "" : (meaning[chosen] ?? "")}`),
  );
}

/** An absent adopt follows publish and an absent claim never takes a folder, as a sync reads them. */
function effective(policy: SyncPolicy, axis: PolicyAxis): string {
  if (axis === "adopt") return policy.adopt ?? policy.publish;
  if (axis === "claim") return policy.claim ?? "off";
  return policy[axis];
}
