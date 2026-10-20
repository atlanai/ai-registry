import { agents } from "./agents.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { devin } from "./devin.ts";

/** Every harness aireg installs into; the order is the order defaults are listed in. */
export const BUILTIN_HARNESSES = [claude, codex, cursor, devin, agents] as const;
