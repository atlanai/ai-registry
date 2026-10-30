import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { geminiCli } from "./gemini-cli.ts";
import { githubCopilot } from "./github-copilot.ts";
import { grok } from "./grok.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import { universal } from "./universal.ts";

/** Every target aireg installs into; the order is the order defaults are listed in. */
export const BUILTIN_TARGETS = [
  claudeCode,
  codex,
  cursor,
  githubCopilot,
  geminiCli,
  opencode,
  grok,
  pi,
  universal,
] as const;
