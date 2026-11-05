import { Type } from "@sinclair/typebox";
import type { DaemonAutostart, DaemonSettled, DaemonStatus } from "#cli/commands/daemon/result.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const State = oneOf(["down", "ready", "stopping", "outdated", "foreign"], {
  description:
    "`outdated` is a daemon an older aireg started that cannot prove it runs as you; " +
    "`foreign` is another program on the daemon's socket.",
});

const Pid = Type.Optional(Type.Number({ description: "Absent while no daemon is running." }));

const Status = matching<DaemonStatus>()(
  Type.Object(
    {
      status: State,
      pid: Pid,
      jobs: Type.Number(),
      enabled: Type.Number(),
      paused: Type.Boolean(),
      autostart: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

const Settled = matching<DaemonSettled>()(
  Type.Object(
    { status: State, pid: Pid, changed: Type.Boolean() },
    { additionalProperties: false },
  ),
);

const registration = {
  mechanism: oneOf(["launchd", "systemd", "run-key"]),
  location: Type.String({ description: "The file or registry value holding the definition." }),
  registered: Type.Boolean(),
  loaded: Type.Boolean(),
  current: Type.Boolean({
    description: "The definition on disk is the one turning autostart on would write now.",
  }),
};

const Autostart = matching<DaemonAutostart>()(
  Type.Union([
    Type.Object(
      { changed: Type.Boolean(), ...registration },
      { additionalProperties: false, description: "After `on` or `off`." },
    ),
    Type.Object(
      { supported: Type.Literal(false) },
      { additionalProperties: false, description: "With `status`, on a platform without one." },
    ),
    Type.Object(
      { supported: Type.Literal(true), ...registration },
      { additionalProperties: false, description: "With `status`." },
    ),
  ]),
);

export const OUTPUT = outputDocument("daemon", {
  status: Status,
  start: Settled,
  stop: Settled,
  restart: Settled,
  autostart: Autostart,
});
