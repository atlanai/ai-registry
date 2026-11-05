import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import type {
  JobList,
  JobRemoved,
  JobRun,
  JobSaved,
  JobsPaused,
  JobToggled,
  RunDetail,
  RunList,
} from "#cli/commands/job/result.ts";
import { STEP_POLICIES } from "#core/config/model.ts";
import { ITEM_OUTCOMES, RUN_MODES, RUN_STATES, RUN_TRIGGERS } from "#core/run/model.ts";
import { DISPOSITIONS } from "#core/sync/model.ts";
import { SYNC_OPERATIONS } from "#core/sync/policy.ts";
import { absent, matching, oneOf, outputDocument, readonlyArray, readonlyRecord } from "./match.ts";

const Selector = Type.Object(
  {
    from: Type.String(),
    match: Type.Optional(Type.String()),
    kinds: Type.Optional(readonlyArray(oneOf(KINDS))),
    target: Type.Optional(readonlyArray(Type.String())),
    harness: Type.Optional(readonlyArray(Type.String())),
  },
  { additionalProperties: false },
);

const Step = Type.Object(
  {
    name: Type.String(),
    kind: Type.String(),
    needs: readonlyArray(Type.String()),
    root: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    select: readonlyArray(Selector),
    policy: oneOf(STEP_POLICIES),
    extra: Type.Readonly(readonlyRecord(Type.Unknown())),
  },
  { additionalProperties: false },
);

const Job = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    account: Type.String(),
    schedule: Type.Object(
      {
        every: Type.Number({ description: "Seconds between runs." }),
        enabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    steps: readonlyArray(Step),
  },
  { additionalProperties: false },
);

export const RunCounts = Type.Object(
  {
    examined: Type.Number(),
    changed: Type.Number(),
    skipped: Type.Number(),
    attention: Type.Number(),
    failed: Type.Number(),
  },
  { additionalProperties: false },
);

const Millis = Type.Number({ description: "Milliseconds since the Unix epoch." });

export const RunRecord = Type.Object(
  {
    id: Type.String(),
    jobId: absent(Type.String({ description: "Absent for a run no job started." })),
    accountId: Type.String(),
    configRevision: Type.Number(),
    mode: oneOf(RUN_MODES),
    trigger: oneOf(RUN_TRIGGERS),
    state: oneOf(RUN_STATES),
    step: absent(Type.String()),
    requestedAtMs: Millis,
    startedAtMs: absent(Millis),
    deadlineAtMs: Millis,
    finishedAtMs: absent(Millis),
    counts: RunCounts,
    errorCode: absent(Type.String()),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const RunEvent = Type.Object(
  {
    id: Type.Number(),
    runId: Type.String(),
    seq: Type.Number(),
    occurredAtMs: Millis,
    eventType: Type.String({ description: "A daemon of another version may send a new type." }),
    step: absent(Type.String()),
    artifact: absent(Type.String()),
    kind: absent(oneOf(KINDS)),
    disposition: absent(oneOf(DISPOSITIONS)),
    operation: absent(oneOf(SYNC_OPERATIONS)),
    outcome: absent(oneOf(ITEM_OUTCOMES)),
    errorCode: absent(Type.String()),
    retryable: Type.Boolean(),
    data: absent(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const Saved = matching<JobSaved>()(
  Type.Object({ job: Job, revision: Type.Number() }, { additionalProperties: false }),
);

const List = matching<JobList>()(
  Type.Object(
    { paused: Type.Boolean(), jobs: readonlyArray(Job) },
    { additionalProperties: false },
  ),
);

const Removed = matching<JobRemoved>()(
  Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
);

const Toggled = matching<JobToggled>()(
  Type.Object({ jobId: Type.String(), enabled: Type.Boolean() }, { additionalProperties: false }),
);

const Paused = matching<JobsPaused>()(
  Type.Object({ paused: Type.Boolean(), revision: Type.Number() }, { additionalProperties: false }),
);

const Run = matching<JobRun>()(Type.Object({ run: RunRecord }, { additionalProperties: false }));

const Runs = matching<RunList | RunDetail>()(
  Type.Union([
    Type.Object({ runs: Type.Array(RunRecord) }, { additionalProperties: false }),
    Type.Object(
      { run: RunRecord, events: Type.Array(RunEvent) },
      { additionalProperties: false, description: "With a run id: that run and its events." },
    ),
  ]),
);

export const OUTPUT = outputDocument("job", {
  add: Saved,
  list: List,
  remove: Removed,
  start: Run,
  enable: Toggled,
  disable: Toggled,
  pause: Paused,
  resume: Paused,
  runs: Runs,
  retry: Run,
  cancel: Run,
});
