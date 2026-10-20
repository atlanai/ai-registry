import { frontmatterRecord, markdownBody } from "#core/catalog/frontmatter.ts";
import type { Rendered } from "#core/harness/codecs/index.ts";

/** The longest description a skill takes, as the Agent Skills spec sets it. */
const MAX_DESCRIPTION = 1024;

/**
 * A plugin's command as a skill a person invokes: its name and description, with the model kept
 * from running it on its own, which is what makes a command a command.
 */
export function commandSkill(name: string, source: string): Rendered {
  const record = frontmatterRecord(source) ?? {};
  const body = markdownBody(source).replace(/\r\n/g, "\n").trim();
  if (body === "") return { problem: "it has no instructions" };
  const described = typeof record.description === "string" ? record.description.trim() : "";
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  const description = (described || first.replace(/^#+\s*/, "")).slice(0, MAX_DESCRIPTION);
  const front = [
    `name: ${name}`,
    // JSON quotes a string the way YAML reads a double-quoted scalar.
    `description: ${JSON.stringify(description)}`,
    "disable-model-invocation: true",
  ];
  return { text: `---\n${front.join("\n")}\n---\n${body}\n` };
}
