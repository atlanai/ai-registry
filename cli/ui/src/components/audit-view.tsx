import type { UiState } from "../../../src/cli/ui/protocol.ts";
import { installed, needsLook, nextStep, stateLabel } from "../lib/state.ts";
import type { AuditFilter } from "../lib/url-state.ts";
import { useCopy } from "./copy-command.tsx";
import { Dashboard, EmptyRow, Metric, Metrics, Section, Table } from "./dashboard.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

function clip(text: string): string {
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

const LEAD =
  "Artifacts edited after install, links that are missing or point elsewhere, and work written here that no registry holds yet.";

export function AuditView({
  state,
  filter,
  onSelect,
}: {
  state: UiState | undefined;
  filter: AuditFilter;
  onSelect: (key: string) => void;
}) {
  const [copied, copy] = useCopy();
  if (state === undefined)
    return (
      <Dashboard title="Needs a look" lead={LEAD}>
        {null}
      </Dashboard>
    );
  const rows = needsLook(state.artifacts, filter);
  const clean = state.artifacts.filter((artifact) => artifact.state === "ok").length;
  return (
    <Dashboard title="Needs a look" lead={LEAD}>
      <Metrics>
        <Metric
          label="Written here"
          value={needsLook(state.artifacts, "unpublished").length}
          sub="In no registry yet"
        />
        <Metric
          label="Edited"
          value={needsLook(state.artifacts, "drifted").length}
          sub="Changed since install"
        />
        <Metric
          label="Missing or broken"
          value={needsLook(state.artifacts, "broken").length}
          sub="Links an agent can’t load"
        />
        <Metric
          label="In order"
          value={`${clean}/${state.artifacts.filter(installed).length}`}
          sub="Installed and matching the lockfile"
        />
      </Metrics>
      <Section
        title="What needs a look"
        note="Each row says what aireg found and the command that settles it."
      >
        <Table head={["Artifact", "State", "Targets", "Folder", "Next step"]}>
          {rows.length === 0 && (
            <EmptyRow span={5}>
              Nothing needs a look. Everything installed matches the lockfile.
            </EmptyRow>
          )}
          {rows.map((artifact) => {
            const next = nextStep(artifact, state) ?? "";
            return (
              <tr key={artifact.key}>
                <td>
                  <button
                    type="button"
                    onClick={() => onSelect(artifact.key)}
                    className="cursor-pointer text-[12.5px] font-semibold text-ink hover:underline"
                  >
                    {artifact.name}
                  </button>
                </td>
                <td>
                  <Badge
                    tone={
                      artifact.state === "edited" || artifact.state === "unpublished"
                        ? "warn"
                        : "bad"
                    }
                  >
                    {stateLabel(artifact.state)}
                  </Badge>
                </td>
                <td>
                  <span className="text-muted">
                    {artifact.links.map((link) => link.target).join(", ") || "-"}
                  </span>
                </td>
                <td
                  className="max-w-[220px] truncate font-mono text-[12px] text-muted"
                  title={artifact.path}
                >
                  {artifact.path || "-"}
                </td>
                <td>
                  <Button
                    className="px-[7px] py-[3px] text-[11px]"
                    title={next}
                    onClick={() => copy(next)}
                  >
                    {copied === next ? "Copied" : clip(next)}
                  </Button>
                </td>
              </tr>
            );
          })}
        </Table>
      </Section>
    </Dashboard>
  );
}
