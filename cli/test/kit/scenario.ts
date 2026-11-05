import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { parse } from "yaml";
import { registry } from "#test/kit/builders/registry.ts";
import type { Aireg } from "./fixtures.ts";

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  aireg: Aireg;
  redact(text: string): string;
}

interface Step {
  command: string;
  code: number;
  expected: string[];
  /** The step as written, kept verbatim when it still matches. */
  source: string[];
}

type Block =
  | { kind: "console"; start: number; end: number; steps: Step[] }
  | { kind: "file"; path: string; start: number; end: number; expected: string[] }
  | { kind: "absent"; path: string };

interface Setup {
  registries?: Record<string, string[]>;
  dirs?: string[];
  files?: Record<string, string>;
}

function steps(body: string[]): Step[] {
  const found: Step[] = [];
  for (const line of body) {
    const step = found.at(-1);
    if (line.startsWith("$ ")) {
      found.push({ command: line.slice(2), code: 0, expected: [], source: [line] });
    } else if (step === undefined) {
      throw new Error(`Output before any command: "${line}"`);
    } else {
      const code = /^\? (\d+)$/.exec(line);
      if (code !== null && step.source.length === 1) step.code = Number(code[1]);
      else step.expected.push(line);
      step.source.push(line);
    }
  }
  return found;
}

function parseScenario(text: string): { setup: Setup; lines: string[]; blocks: Block[] } {
  const lines = text.split("\n");
  let at = 0;
  let setup: Setup = {};
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    setup = (parse(lines.slice(1, close).join("\n")) as Setup | null) ?? {};
    at = close + 1;
  }
  const blocks: Block[] = [];
  for (; at < lines.length; at += 1) {
    const line = lines[at] as string;
    const absent = /^!file\s+(\S+)\s*$/.exec(line);
    if (absent !== null) blocks.push({ kind: "absent", path: absent[1] as string });
    const fence = /^```(console|file)(?:\s+(\S+))?\s*$/.exec(line);
    if (fence === null) continue;
    const start = at + 1;
    const end = lines.indexOf("```", start);
    if (end === -1) throw new Error(`The fence on line ${start} is never closed.`);
    const body = lines.slice(start, end);
    if (fence[1] === "console") blocks.push({ kind: "console", start, end, steps: steps(body) });
    else if (fence[2] === undefined)
      throw new Error(`The file block on line ${start} names no path.`);
    else blocks.push({ kind: "file", path: fence[2], start, end, expected: body });
    at = end;
  }
  return { setup, lines, blocks };
}

/** Whitespace-separated words, with single or double quotes around a word that holds spaces. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? (match[3] as string),
  );
}

const literal = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `--json` prints one line; indented, a scenario can match and diff it field by field. */
function pretty(stdout: string): string {
  try {
    return JSON.stringify(JSON.parse(stdout), null, 2);
  } catch {
    return stdout;
  }
}

function lineMatches(expected: string, actual: string): boolean {
  if (!expected.includes("[..]")) return expected === actual;
  return new RegExp(`^${expected.split("[..]").map(literal).join(".*?")}$`).test(actual);
}

function matches(expected: readonly string[], actual: readonly string[]): boolean {
  const [head, ...rest] = expected;
  if (head === undefined) return actual.length === 0;
  if (head === "...") {
    for (let skip = 0; skip <= actual.length; skip += 1) {
      if (matches(rest, actual.slice(skip))) return true;
    }
    return false;
  }
  const [first] = actual;
  return first !== undefined && lineMatches(head, first) && matches(rest, actual.slice(1));
}

async function prepare(setup: Setup, sandbox: Sandbox, resolve: (file: string) => string) {
  for (const [alias, refs] of Object.entries(setup.registries ?? {})) {
    const built = registry(join(sandbox.root, alias));
    for (const ref of refs) {
      const [, kind, name] = /^(?:(skill|agent)\s+)?(\S+)$/.exec(ref) ?? [];
      if (name === undefined)
        throw new Error(`Cannot read "${ref}" as [skill|agent] ns/name@version.`);
      if (kind === "agent") built.agent(name);
      else built.skill(name);
    }
    await built.write();
  }
  for (const dir of setup.dirs ?? []) await mkdir(resolve(dir), { recursive: true });
  for (const [file, text] of Object.entries(setup.files ?? {})) {
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(resolve(file), text);
  }
}

/** Runs a block's commands; returns the block rewritten when any output or code differed. */
async function runCommands(
  steps: readonly Step[],
  sandbox: Sandbox,
  expand: (text: string) => string,
  normalize: (text: string) => string[],
  update: boolean,
): Promise<string[] | undefined> {
  const body: string[] = [];
  let changed = false;
  for (const step of steps) {
    const [program, ...args] = words(step.command).map(expand);
    if (program !== "aireg") throw new Error(`Only aireg runs in a scenario: $ ${step.command}`);
    const ran = await sandbox.aireg(args);
    const actual = [...normalize(pretty(ran.stdout)), ...normalize(ran.stderr)];
    if (ran.code === step.code && matches(step.expected, actual)) {
      body.push(...step.source);
      continue;
    }
    changed = true;
    body.push(`$ ${step.command}`, ...(ran.code === 0 ? [] : [`? ${ran.code}`]), ...actual);
    if (update) continue;
    expect({ code: ran.code, output: actual.join("\n") }, `$ ${step.command}`).toEqual({
      code: step.code,
      output: step.expected.join("\n"),
    });
  }
  return changed ? body : undefined;
}

function checkAbsent(path: string, shown: string): void {
  expect(existsSync(path), `!file ${shown}`).toBe(false);
}

/** The file's lines when they differ from the block and `update` is on. */
async function checkFile(
  block: Extract<Block, { kind: "file" }>,
  path: string,
  normalize: (text: string) => string[],
  update: boolean,
): Promise<string[] | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  expect(text, `file ${block.path} is missing`).toBeDefined();
  const actual = normalize(text ?? "");
  if (matches(block.expected, actual)) return undefined;
  if (update) return actual;
  expect(actual.join("\n"), `file ${block.path}`).toBe(block.expected.join("\n"));
  return actual;
}

/** Runs one Markdown scenario; the format is in test/scenarios/README.md. */
export async function runScenario(path: string, sandbox: Sandbox): Promise<void> {
  const { setup, lines, blocks } = parseScenario(await readFile(path, "utf8"));
  const places: [string, string][] = [
    ["[ROOT]", sandbox.root],
    ["[HOME]", sandbox.home],
    ["[PROJECT]", sandbox.project],
  ];
  const expand = (text: string) =>
    places.reduce((out, [label, dir]) => out.replaceAll(label, dir), text);
  const resolve = (file: string) =>
    places.some(([label]) => file.startsWith(label)) ? expand(file) : join(sandbox.project, file);
  const normalize = (text: string) => {
    const out = sandbox
      .redact(text)
      .split("\n")
      .map((line) => line.trimEnd());
    while (out.at(-1) === "") out.pop();
    return out;
  };

  await prepare(setup, sandbox, resolve);

  const update = process.env.UPDATE_SCENARIOS === "1";
  const rewrites: { start: number; end: number; body: string[] }[] = [];
  for (const block of blocks) {
    if (block.kind === "absent") {
      checkAbsent(resolve(block.path), block.path);
      continue;
    }
    const body =
      block.kind === "file"
        ? await checkFile(block, resolve(block.path), normalize, update)
        : await runCommands(block.steps, sandbox, expand, normalize, update);
    if (body !== undefined) rewrites.push({ start: block.start, end: block.end, body });
  }
  if (rewrites.length === 0) return;
  for (const { start, end, body } of rewrites.reverse()) lines.splice(start, end - start, ...body);
  await writeFile(path, lines.join("\n"));
}
