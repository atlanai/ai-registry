import { useQuery } from "@tanstack/react-query";
import { Check, Copy, MousePointerClick, Plus, Trash2 } from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import type { UiArtifact, UiLink } from "../../../src/cli/ui/protocol.ts";
import { describeError, rpc } from "../lib/rpc.ts";
import { namespaceOf, stateText } from "../lib/state.ts";
import { cn } from "../lib/utils.ts";
import { shellQuote, useCopy } from "./copy-command.tsx";
import { NamespacePill } from "./namespace-pill.tsx";
import { Badge, type Tone } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";

// The Markdown stack is the largest dependency; load it only when a file is shown.
const MarkdownView = lazy(() => import("./markdown.tsx"));

const TONE: Record<"clean" | "drifted" | "pending", Tone> = {
  clean: "ok",
  drifted: "bad",
  pending: "warn",
};

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-4 py-2">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

function linkWord(link: UiLink): string {
  if (!link.present) return "Missing";
  return link.ok ? "Linked" : "Points elsewhere";
}

function FileSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the file"
      className="flex flex-col gap-2.5"
    >
      <div className="h-4 w-1/3 rounded bg-subtle" />
      <div className="h-3 w-full rounded bg-subtle/70" />
      <div className="h-3 w-11/12 rounded bg-subtle/70" />
      <div className="h-3 w-2/3 rounded bg-subtle/70" />
    </div>
  );
}

function FileView({ artifact }: { artifact: UiArtifact }) {
  const file = useQuery({
    queryKey: ["file", artifact.key, artifact.digest, artifact.diskDigest],
    queryFn: () => rpc("artifact.file", { key: artifact.key }),
    staleTime: Infinity,
  });
  let body: ReactNode = <FileSkeleton />;
  if (file.isError) {
    const { title, hint } = describeError(file.error);
    body = (
      <div className="rounded-md bg-bad-bg px-3 py-2.5 text-[12.5px]">
        <p className="font-medium text-bad-ink">Couldn’t read this file. {title}</p>
        {hint !== undefined && <p className="mt-0.5 text-ink-2">{hint}</p>}
      </div>
    );
  } else if (file.data !== undefined) {
    body = (
      <Suspense fallback={<FileSkeleton />}>
        <MarkdownView text={file.data.text} />
      </Suspense>
    );
  }
  const from = file.data?.from === "registry" ? `From ${artifact.registry}` : "Installed copy";
  return (
    <Section title="File" aside={file.data && <span className="text-[12px] text-dim">{from}</span>}>
      <article className="doc-article">{body}</article>
    </Section>
  );
}

function Links({ artifact }: { artifact: UiArtifact }) {
  if (artifact.links.length === 0) {
    return (
      <p className="text-[12.5px] text-muted">
        {artifact.state === "available"
          ? "Install it to make it available to your agents."
          : "No agent loads it yet."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-hairline">
      {artifact.links.map((link) => {
        const word = linkWord(link);
        return (
          <li key={`${link.target}:${link.path}`} className="flex items-center gap-4 py-2">
            <span className="w-[120px] shrink-0 text-[13px] text-ink">{link.target}</span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted"
              title={link.path}
            >
              {link.path}
            </span>
            <Badge tone={word === "Linked" ? "ok" : "warn"}>{word}</Badge>
          </li>
        );
      })}
    </ul>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-60 flex-col items-center gap-2 text-center">
        <MousePointerClick aria-hidden className="size-5 text-dim" />
        <p className="text-[13px] font-medium text-ink">Nothing selected</p>
        <p className="text-[12.5px] leading-5 text-muted">
          Pick an artifact from the list, or press <Kbd>⌘K</Kbd> to find one.
        </p>
      </div>
    </div>
  );
}

export function Inspector({
  artifact,
  onInstall,
  onRemove,
}: {
  artifact: UiArtifact | undefined;
  onInstall: (artifact: UiArtifact) => void;
  onRemove: (artifact: UiArtifact) => void;
}) {
  const [copied, copy] = useCopy();
  if (artifact === undefined) return <Empty />;
  const [tone, said] = stateText(artifact);
  const available = artifact.state === "available";
  const cli = artifact.listed
    ? `aireg show -- ${shellQuote(artifact.key)}`
    : `aireg show -- ${shellQuote(artifact.path)}`;
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-10 pt-8 pb-20 max-[1100px]:px-5">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-balance break-words text-ink">
              {artifact.name}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <Badge tone={TONE[tone]}>{artifact.detail || said}</Badge>
              <NamespacePill namespace={namespaceOf(artifact)} large />
              {artifact.version !== "" && (
                <span className="font-mono text-[12px]">{artifact.version}</span>
              )}
              <span className="text-faint">·</span>
              <span>{artifact.kind}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" onClick={() => copy(cli)} title={cli}>
              {copied === cli ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied === cli ? "Copied" : "Copy command"}
            </Button>
            {available ? (
              <Button
                variant="primary"
                onClick={() => onInstall(artifact)}
                disabled={!artifact.listed}
              >
                <Plus aria-hidden /> Install
              </Button>
            ) : (
              <Button
                variant="retire"
                onClick={() => onRemove(artifact)}
                disabled={!artifact.removable}
                title={
                  artifact.removable
                    ? undefined
                    : "aireg doesn’t manage this folder, so it can’t remove it"
                }
              >
                <Trash2 aria-hidden /> Remove
              </Button>
            )}
          </div>
        </div>
        {artifact.description !== "" && (
          <p className="max-w-[62ch] text-[14px] leading-6 text-pretty text-ink-2">
            {artifact.description}
          </p>
        )}
      </header>

      <Section title="Details">
        <dl className="divide-y divide-hairline border-y border-hairline">
          <Field label="Registry">{artifact.registry || "-"}</Field>
          {artifact.installedVersion !== "" && artifact.installedVersion !== artifact.version && (
            <Field label="Installed">
              <span className="font-mono text-[12.5px]">{artifact.installedVersion}</span>
            </Field>
          )}
          {artifact.path !== "" && (
            <Field label="Folder">
              <span className="font-mono text-[12.5px] break-all">{artifact.path}</span>
            </Field>
          )}
          <Field label="Digest">
            {artifact.digest === "" ? (
              <span className="text-muted">None yet</span>
            ) : (
              <button
                type="button"
                onClick={() => copy(artifact.digest)}
                title="Copy the digest"
                className={cn(
                  "cursor-pointer rounded text-left font-mono text-[12.5px] break-all transition-colors hover:text-accent",
                  copied === artifact.digest && "text-ok-ink",
                )}
              >
                {copied === artifact.digest ? "Copied" : artifact.digest}
              </button>
            )}
          </Field>
        </dl>
      </Section>

      <Section title="Agents">
        <Links artifact={artifact} />
      </Section>

      <FileView artifact={artifact} key={artifact.key} />
    </div>
  );
}
