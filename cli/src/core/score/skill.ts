import { createHash } from "node:crypto";
import { frontmatterRecord, markdownBody } from "#core/frontmatter.ts";

interface SkillCheck {
  id: string;
  label: string;
  points: number;
  earned: number;
  evidence: string;
  improvement: string;
}

export interface SkillScore {
  rubric: "authoring-signals-v1";
  status: "scored" | "unavailable";
  score: number | null;
  digest: string;
  checks: SkillCheck[];
  review: string[];
  safety: "not-assessed";
  performance: "not-measured";
}

interface Section {
  heading: string;
  text: string;
  line: number;
}

const REVIEW = [
  "Does the skill add domain knowledge the agent would otherwise lack?",
  "Are the instructions correct, coherent, and appropriate for this task?",
  "Does it activate for the right requests and stay out of unrelated work?",
  "Does it improve real outputs compared with running without the skill?",
];

/** Deterministic authoring signals, not a semantic review, security scan or execution benchmark. */
export function scoreSkill(markdown: string): SkillScore {
  const base = {
    rubric: "authoring-signals-v1" as const,
    digest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
    review: REVIEW,
    safety: "not-assessed" as const,
    performance: "not-measured" as const,
  };
  if (markdown.trim() === "" || Buffer.byteLength(markdown, "utf8") > 256 * 1024) {
    return { ...base, status: "unavailable", score: null, checks: [] };
  }
  const checks = authoringChecks(markdown);
  return {
    ...base,
    status: "scored",
    score: checks.reduce((total, check) => total + check.earned, 0),
    checks,
  };
}

function check(
  id: string,
  label: string,
  points: number,
  evidence: string | undefined,
  improvement: string,
): SkillCheck {
  return {
    id,
    label,
    points,
    earned: evidence === undefined ? 0 : points,
    evidence: evidence ?? "No matching evidence found in SKILL.md.",
    improvement,
  };
}

function authoringChecks(markdown: string): SkillCheck[] {
  const record = frontmatterRecord(markdown);
  const description = typeof record?.description === "string" ? record.description.trim() : "";
  const name = typeof record?.name === "string" ? record.name : "";
  const body = markdownBody(markdown).replace(/<!--[\s\S]*?-->/g, "");
  const sections = sectionsOf(markdown);
  const prose = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
  const steps = prose.split(/\r?\n/).filter((line) => /^\s*(?:\d+[.)]|[-*])\s+\S.{15,}/.test(line));
  const lines = markdown.split(/\r?\n/).length;
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return [
    check(
      "metadata",
      "Readable metadata",
      5,
      record ? "YAML front matter parses as a mapping." : undefined,
      "Add a valid YAML front-matter block with name and description.",
    ),
    check(
      "name",
      "Portable skill name",
      5,
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64
        ? "Name uses lowercase words separated by hyphens (at most 64 characters)."
        : undefined,
      "Use a short lowercase name with hyphens, matching the skill folder.",
    ),
    check(
      "description",
      "Discovery description",
      15,
      description.length >= 40 && description.length <= 1024
        ? "Description is present and within this rubric's 40–1024 character range."
        : undefined,
      "Describe the specific job and when to use the skill in the description field. Length alone does not establish clarity.",
    ),
    check(
      "trigger",
      "Activation guidance",
      10,
      /\b(?:when|whenever|use for|triggers? on)\b/i.test(description)
        ? "Description contains an explicit activation cue; relevance still needs review."
        : sectionEvidence(sections, /when to use|triggers?|activation|use cases?/i),
      "State which user requests should activate this skill, with a concrete boundary example.",
    ),
    check(
      "procedure",
      "Actionable structure",
      15,
      steps.length >= 2
        ? `${steps.length} substantive list steps found; their correctness needs review.`
        : undefined,
      "Describe the sequence or decision rules an agent should follow. Use concrete actions rather than generic advice.",
    ),
    check(
      "output",
      "Output contract",
      10,
      sectionEvidence(sections, /outputs?|deliverables?|response format|result format/i),
      "Add an output section naming the deliverable, format, and what a complete result contains.",
    ),
    check(
      "example",
      "Worked example",
      10,
      sectionEvidence(sections, /examples?|sample|walkthrough/i),
      "Add a realistic example with input and expected output. A heading alone is not enough.",
    ),
    check(
      "validation",
      "Verification guidance",
      15,
      sectionEvidence(
        sections,
        /validat|verif|test|quality|success criteria|acceptance|checklist/i,
      ),
      "Explain how to check the result against observable success criteria before returning it.",
    ),
    check(
      "recovery",
      "Failure guidance",
      5,
      sectionEvidence(
        sections,
        /errors?|failures?|fallback|troubleshoot|edge cases?|limitations?/i,
      ),
      "Describe a likely failure or missing input and the recovery or escalation step.",
    ),
    check(
      "context",
      "Manageable entry point",
      10,
      words >= 30 && lines <= 500 && markdown.length <= 20_000
        ? `${lines} lines in SKILL.md; within this rubric's 500-line / 20,000-character review budget.`
        : undefined,
      "Keep the core workflow in SKILL.md; move optional detail into references and explain when to read each. This is a size heuristic, not a token count.",
    ),
  ];
}

/** Ignore example code and HTML comments when recognizing headings. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  let fence = "";
  const lines = markdown
    .replace(/<!--[\s\S]*?-->/g, (text) => text.replace(/[^\n]/g, " "))
    .split(/\r?\n/);
  for (const [at, line] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === "") fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      continue;
    }
    const heading = fence === "" ? /^#{1,6}\s+(.+)/.exec(line)?.[1] : undefined;
    if (heading !== undefined) {
      current = { heading, text: "", line: at + 1 };
      sections.push(current);
    } else if (current !== undefined) current.text += `${line}\n`;
  }
  return sections;
}

function sectionEvidence(sections: Section[], pattern: RegExp): string | undefined {
  const found = sections.find(
    (section) =>
      pattern.test(section.heading) &&
      section.text.trim().length >= 40 &&
      !/\b(?:TODO|TBD|FIXME)\b/.test(section.text),
  );
  return found === undefined
    ? undefined
    : `Substantive section at line ${found.line}; content quality needs review.`;
}
