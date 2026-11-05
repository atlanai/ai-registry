import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import { STEP_POLICIES } from "#core/config/model.ts";
import type { ConsoleState } from "#core/console/model.ts";
import { RUN_MODES, RUN_STATES, RUN_TRIGGERS } from "#core/run/model.ts";
import { SCOPES } from "#core/store/paths.ts";
import { RunCounts } from "./job.ts";
import { absent, matching, oneOf, outputDocument, readonlyRecord } from "./match.ts";

const ARTIFACT_STATES = [
  "ok",
  "missing",
  "dangling",
  "edited",
  "failed",
  "pending",
  "imported",
  "unpublished",
  "duplicate",
] as const;

const Millis = Type.Number({ description: "Milliseconds since the Unix epoch." });

const Account = Type.Object(
  {
    id: Type.String(),
    registry: Type.String(),
    address: Type.String(),
    config: readonlyRecord(Type.String()),
    credentialsFile: absent(Type.String()),
    signedIn: Type.Boolean(),
    signIn: Type.Boolean({ description: "The registry's adapter has a sign-in at all." }),
    publishes: Type.Boolean(),
    defaultNamespace: absent(Type.String()),
    artifactCount: Type.Number(),
    namespaceCount: Type.Number(),
  },
  { additionalProperties: false },
);

const Row = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    kind: oneOf(KINDS),
    registry: Type.String({ description: "`local` for work authored on this machine." }),
    namespace: absent(Type.String()),
    id: Type.String(),
    version: absent(Type.String()),
    lockDigest: Type.String(),
    diskDigest: absent(Type.String()),
    state: oneOf(ARTIFACT_STATES),
    detail: absent(Type.String()),
    targets: Type.Array(Type.String()),
    copy: Type.String(),
    changedAtMs: absent(Millis),
    carriedBy: Type.Optional(absent(Type.String())),
    links: Type.Array(
      Type.Object(
        {
          target: Type.String(),
          path: Type.String(),
          present: Type.Boolean(),
          ok: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const Group = Type.Object(
  {
    key: Type.String({ description: "The namespace, or `~local` for work authored here." }),
    label: Type.String(),
    isDefault: Type.Boolean(),
    authoredHere: Type.Boolean(),
    rows: Type.Array(Row),
    counts: Type.Object(
      {
        ok: Type.Number(),
        missing: Type.Number(),
        dangling: Type.Number(),
        edited: Type.Number(),
        failed: Type.Number(),
        pending: Type.Number(),
        imported: Type.Number(),
        unpublished: Type.Number(),
        duplicate: Type.Number(),
      },
      { additionalProperties: false, description: "Rows in each state." },
    ),
    versions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const Summary = Type.Object(
  {
    skillsImported: Type.Number(),
    skillsExamined: Type.Number(),
    failed: Type.Number(),
    edited: Type.Number(),
    dangling: Type.Number(),
    missing: Type.Number(),
    pending: Type.Number(),
    imported: Type.Number(),
    unpublished: Type.Number(),
    duplicate: Type.Number(),
  },
  { additionalProperties: false },
);

const JobRow = Type.Object(
  {
    id: Type.String(),
    name: Type.String({ description: "What a person called it, falling back to the id." }),
    type: Type.String(),
    accountId: Type.String(),
    enabled: Type.Boolean(),
    intervalSeconds: Type.Number(),
    summary: Type.String({ description: "The steps, on one line." }),
    lastRunAtMs: absent(Millis),
    nextRunAtMs: absent(Millis),
  },
  { additionalProperties: false },
);

const RunRow = Type.Object(
  {
    id: Type.String(),
    jobId: absent(Type.String()),
    mode: oneOf(RUN_MODES),
    trigger: oneOf(RUN_TRIGGERS),
    state: oneOf(RUN_STATES),
    requestedAtMs: Millis,
    finishedAtMs: absent(Millis),
    counts: RunCounts,
    errorCode: absent(Type.String()),
    reason: absent(Type.String({ description: "Why it failed, from the daemon's log." })),
  },
  { additionalProperties: false },
);

const Policy = Type.Object(
  {
    pull: oneOf(STEP_POLICIES),
    publish: oneOf(STEP_POLICIES),
    delete: oneOf(STEP_POLICIES),
    adopt: Type.Optional(oneOf(STEP_POLICIES)),
    claim: Type.Optional(oneOf(STEP_POLICIES)),
  },
  { additionalProperties: false },
);

const State = matching<ConsoleState>()(
  Type.Object(
    {
      version: Type.String(),
      account: absent(Account),
      accounts: Type.Array(Account),
      groups: Type.Array(Group),
      summary: Summary,
      jobs: Type.Array(JobRow),
      runs: Type.Array(RunRow),
      daemon: Type.Object(
        {
          running: Type.Boolean(),
          pid: absent(Type.Number()),
          jobsEnabled: Type.Number(),
          jobsTotal: Type.Number(),
        },
        { additionalProperties: false },
      ),
      policy: absent(Policy),
      scope: oneOf(SCOPES),
      root: Type.String(),
      readAtMs: Millis,
      problems: Type.Array(Type.String()),
      panels: readonlyRecord(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("console", { console: State });
