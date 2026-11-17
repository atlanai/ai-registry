// A skill's Markdown, as HTML the sanitizer then filters. Raw HTML in it stays text.
import { escapeHtml, safeLink } from "./core.js";

const RULE = /^(\*{3,}|-{3,}|_{3,})$/;
const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+\.\s+/;
const CODE_TOKEN = "__CODE_BLOCK_";

/** A skill's Markdown as HTML: front matter as a card, then one block at a time. */
export function renderMarkdown(rawMd) {
  if (!rawMd) {
    return "<p><em>It has no file to show: a plugin can carry skills and settings without a README.</em></p>";
  }
  const { html: frontmatterHtml, rest } = frontmatter(rawMd.replace(/\r\n/g, "\n"));
  const codeBlocks = [];
  // Fenced code is set aside first, so no other rule changes what it holds.
  const md = rest.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || "text", code });
    return `\n${CODE_TOKEN}${codeBlocks.length - 1}__\n`;
  });
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const read = BLOCKS.reduce((found, parse) => found ?? parse(lines, i, codeBlocks), undefined);
    if (read === undefined) {
      i++;
      continue;
    }
    if (read.html !== "") blocks.push(read.html);
    i = read.next;
  }
  return frontmatterHtml + blocks.join("\n");
}

function frontmatter(md) {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return { html: "", rest: md };
  const fmRows = fmMatch[1]
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return `<div class="fm-row">${escapeHtml(line)}</div>`;
      const k = line.substring(0, idx).trim();
      const v = line.substring(idx + 1).trim();
      return `<div class="fm-row"><span class="fm-key">${escapeHtml(k)}:</span><span class="fm-val">${escapeHtml(v)}</span></div>`;
    })
    .join("");
  return {
    html: `
      <div class="frontmatter-container">
        <div class="frontmatter-label">Front matter</div>
        <div class="frontmatter-body">${fmRows}</div>
      </div>
    `,
    rest: md.substring(fmMatch[0].length),
  };
}

function codeBlock(lines, i, codeBlocks) {
  const line = lines[i].trim();
  if (!line.startsWith(CODE_TOKEN) || !line.endsWith("__")) return undefined;
  const b = codeBlocks[parseInt(line.replace(CODE_TOKEN, "").replace("__", ""), 10)];
  const html = b
    ? `
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-lang-tag">${escapeHtml(b.lang)}</span>
            </div>
            <pre><code class="language-${escapeHtml(b.lang)}">${escapeHtml(b.code)}</code></pre>
          </div>
        `
    : "";
  return { html, next: i + 1 };
}

function rule(lines, i) {
  return RULE.test(lines[i].trim()) ? { html: '<hr class="markdown-hr">', next: i + 1 } : undefined;
}

function heading(lines, i) {
  const hMatch = lines[i].match(/^(#{1,6})\s+(.*)$/);
  if (!hMatch) return undefined;
  const level = hMatch[1].length;
  return { html: `<h${level}>${formatInline(hMatch[2])}</h${level}>`, next: i + 1 };
}

function cellsOf(row) {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** A table: a line that starts with | and a |--- line under it. */
function table(lines, i) {
  if (
    !lines[i].trim().startsWith("|") ||
    i + 1 >= lines.length ||
    !/^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1])
  ) {
    return undefined;
  }
  const tableLines = [];
  let next = i;
  while (next < lines.length && lines[next].trim().startsWith("|"))
    tableLines.push(lines[next++].trim());
  if (tableLines.length < 2) return { html: "", next };
  const thead = `<thead><tr>${cellsOf(tableLines[0])
    .map((c) => `<th>${formatInline(c)}</th>`)
    .join("")}</tr></thead>`;
  const rows = tableLines.slice(2).map(
    (row) =>
      `<tr>${cellsOf(row)
        .map((c) => `<td>${formatInline(c)}</td>`)
        .join("")}</tr>`,
  );
  return {
    html: `<div class="table-scroll-wrapper"><table class="markdown-table">${thead}<tbody>${rows.join("")}</tbody></table></div>`,
    next,
  };
}

/** A quote, or a GitHub callout such as > [!NOTE]. */
function quote(lines, i) {
  if (!lines[i].trim().startsWith(">")) return undefined;
  const quoteLines = [];
  let next = i;
  while (next < lines.length && lines[next].trim().startsWith(">"))
    quoteLines.push(lines[next++].replace(/^\s*>\s?/, ""));
  const rawQuote = quoteLines.join("\n").trim();
  const alertMatch = rawQuote.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*)$/i);
  if (!alertMatch) return { html: `<blockquote>${formatInline(rawQuote)}</blockquote>`, next };
  const type = alertMatch[1].toUpperCase();
  return {
    html: `
          <div class="callout-box callout-${type.toLowerCase()}">
            <div class="callout-title">${type}</div>
            <div class="callout-content">${formatInline(alertMatch[2].trim())}</div>
          </div>
        `,
    next,
  };
}

function listOf(marker, tag) {
  return (lines, i) => {
    if (!marker.test(lines[i])) return undefined;
    const items = [];
    let next = i;
    while (next < lines.length && marker.test(lines[next]))
      items.push(`<li>${formatInline(lines[next++].replace(marker, ""))}</li>`);
    return { html: `<${tag}>${items.join("")}</${tag}>`, next };
  };
}

function startsBlock(line) {
  const trimmed = line.trim();
  return (
    ["#", ">", "|", CODE_TOKEN].some((start) => trimmed.startsWith(start)) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    RULE.test(trimmed)
  );
}

function paragraph(lines, i) {
  if (!lines[i].trim()) return undefined;
  const paraLines = [];
  let next = i;
  while (next < lines.length && lines[next].trim() && !startsBlock(lines[next]))
    paraLines.push(lines[next++]);
  // A line no block takes still moves the reader on, so nothing loops.
  if (paraLines.length === 0) return { html: `<p>${formatInline(lines[i])}</p>`, next: i + 1 };
  return { html: `<p>${formatInline(paraLines.join(" "))}</p>`, next };
}

/** Tried in this order on each line: the first that reads it wins. */
const BLOCKS = [
  codeBlock,
  rule,
  heading,
  table,
  quote,
  listOf(BULLET, "ul"),
  listOf(NUMBERED, "ol"),
  paragraph,
];

export function formatInline(str) {
  if (!str) return "";
  let s = escapeHtml(str);

  // 1. Tokenize inline code so underscores/asterisks inside code are preserved verbatim
  const codeTokens = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const token = `__INLINE_CODE_${codeTokens.length}__`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  // 2. Bold & Italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/(?:^|\s)_([^_]+)_(?:\s|$)/g, " <em>$1</em> ");

  // 3. Strikethrough
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 4. Images are never loaded or linked: a skill could log who opened it.
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt) => `<span class="image-stand-in">Image not loaded: ${alt || "no description"}</span>`,
  );

  // 5. Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => safeLink(text, href));

  // 6. Restore inline code
  s = s.replace(/__INLINE_CODE_(\d+)__/g, (_, idx) => codeTokens[parseInt(idx, 10)] || "");

  return s;
}
