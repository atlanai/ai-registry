import { agents } from "./agents.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import { cursor } from "./cursor.ts";
import { gemini } from "./gemini.ts";

/** Every harness aireg installs into; the order is the order defaults are listed in. */
export const BUILTIN_HARNESSES = [claude, codex, cursor, copilot, gemini, agents] as const;
