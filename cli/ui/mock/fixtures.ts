import type { UiArtifact, UiState } from "../../src/cli/ui/protocol.ts";

const KINDS = ["skill", "agent", "command", "mcp-server", "plugin"];
const STATES = ["ok", "ok", "ok", "edited", "missing", "available", "available", "available"];
const WORDS = [
  "review",
  "deploy",
  "triage",
  "lint",
  "docs",
  "release",
  "search",
  "audit",
  "sql",
  "notes",
];

function artifact(at: number): UiArtifact {
  const registry = at % 3 === 0 ? "example-team" : "example-public";
  const kind = KINDS[at % KINDS.length] ?? "skill";
  const state = STATES[at % STATES.length] ?? "available";
  const name = `${WORDS[at % WORDS.length]}-${kind === "skill" ? "helper" : kind}-${at}`;
  const present = state !== "available";
  return {
    key: `${registry}/acme/${kind}/${name}`,
    name,
    namespace: "acme",
    registry,
    kind,
    version: `1.${at % 7}.0`,
    installedVersion: present ? `1.${Math.max(0, (at % 7) - (at % 4 === 0 ? 1 : 0))}.0` : "",
    description: `Helps with ${WORDS[at % WORDS.length]} work in a typical repository.`,
    state,
    detail: state === "edited" ? "Changed on disk since it was installed." : "",
    digest: present ? `sha256:${(at * 7919).toString(16).padStart(64, "a")}` : "",
    diskDigest: present
      ? `sha256:${(at * (state === "edited" ? 31 : 7919)).toString(16).padStart(64, "a")}`
      : "",
    path: present ? `~/.aireg/store/${name}` : "",
    links: present
      ? [
          {
            target: "claude-code",
            path: `~/.claude/skills/${name}`,
            present: true,
            ok: state !== "missing",
          },
          {
            target: "codex",
            path: `~/.codex/skills/${name}`,
            present: state !== "missing",
            ok: state === "ok",
          },
        ]
      : [],
    harnesses: present ? ["claude-code", "codex"] : [],
    listed: true,
    removable: present,
    carriedBy: undefined,
  };
}

export function initialState(): UiState {
  const now = Date.now();
  return {
    artifacts: Array.from({ length: 240 }, (_, at) => artifact(at)),
    registries: [
      {
        name: "example-public",
        address: "github.com/example/public-registry",
        count: 160,
        installed: 60,
        error: undefined,
        loading: false,
      },
      {
        name: "example-team",
        address: "github.com/example/team-registry",
        count: 80,
        installed: 30,
        error: undefined,
        loading: false,
      },
      {
        name: "example-offline",
        address: "https://registry.example.invalid",
        count: 0,
        installed: 0,
        error: "Could not reach the registry.",
        loading: false,
      },
    ],
    scope: "project",
    root: "~/code/example-project",
    daemon: { running: true, detail: "pid 4242" },
    jobs: [
      {
        id: "job_1",
        name: "sync",
        enabled: true,
        intervalSeconds: 3600,
        nextRunAtMs: now + 1_200_000,
      },
    ],
    runs: [
      {
        id: "run_old",
        label: "sync",
        state: "succeeded",
        startedAtMs: now - 3_600_000,
        endedAtMs: now - 3_590_000,
        error: undefined,
      },
    ],
    problems: [],
    readAtMs: now,
    version: "0.0.0-mock",
  };
}

export const SAMPLE_FILE = `# Example skill

A **fixture** file for the mock server. It renders with GitHub-flavored Markdown.

- [x] Tables
- [ ] Raw HTML, which stays out: <script>alert(1)</script>

| Field | Value |
| ----- | ----- |
| kind  | skill |

\`\`\`sh
aireg add example/public-registry --only review-helper-0
\`\`\`

[A safe link](https://example.com) and [an unsafe one](javascript:alert(1)).
`;
