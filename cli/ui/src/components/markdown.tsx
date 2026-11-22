import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const SAFE_LINK = /^(https?:|mailto:)/i;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href !== undefined && SAFE_LINK.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Images never load: the file is read-only text, and the CSP forbids remote sources.
  img: ({ alt }) => (
    <span className="inline-block rounded border border-dashed border-dim px-1.5 text-[12px] text-muted">
      {alt || "image"}
    </span>
  ),
};

/** Top-level `key: value` lines only; nested YAML shows as its raw value. */
function fields(yaml: string): [string, string][] {
  return yaml
    .split(/\r?\n/)
    .map((line) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1] ?? "", match[2] ?? ""]);
}

function Frontmatter({ yaml }: { yaml: string }) {
  return (
    <div className="mb-6 rounded-lg border border-hairline bg-subtle px-3.5 py-3">
      <div className="mb-2 text-[12px] font-medium text-muted">Frontmatter</div>
      <div className="flex flex-col gap-1 font-mono text-[11px]">
        {fields(yaml).map(([key, value]) => (
          <div key={key} className="flex gap-2 leading-[1.45]">
            <span className="min-w-[90px] font-semibold text-ink-2">{key}</span>
            <span className="break-all text-ink">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Raw HTML stays out (no rehype-raw), and the tree is sanitized before React sees it. */
export default function MarkdownView({ text }: { text: string }) {
  const front = FRONTMATTER.exec(text);
  const body = front === null ? text : text.slice(front[0].length);
  return (
    <>
      {front?.[1] !== undefined && <Frontmatter yaml={front[1]} />}
      {body.trim() === "" ? (
        <p>
          <em>The file is empty.</em>
        </p>
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          components={COMPONENTS}
        >
          {body}
        </Markdown>
      )}
    </>
  );
}
