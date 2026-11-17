import type { CommandSpec } from "#cli/commands/command.ts";

const input = {
  flag: "--input-stdin" as const,
  describe: "Read a JSON object from a pipe; keeps keys and queries out of command arguments",
};
export const DISCOVER_COMMAND: CommandSpec = {
  name: "discover",
  summary: "Find and route skills with Gemini, or manage local discovery",
  group: "Install",
  docs: "discover",
  usage: ["aireg discover <action> [arguments] [--input-stdin]"],
  examples: [
    {
      command: 'aireg discover search "Review a pull request" --json',
      what: "retrieve candidates and recommend a skill",
    },
    {
      command: "aireg discover index --json",
      what: "build or refresh the saved index without a browser",
    },
  ],
  actions: [
    { name: "status", summary: "Show connection, index and local history", maxArguments: 0 },
    {
      name: "setup",
      usage: ["aireg discover setup --input-stdin"],
      summary: "Test and save consent, registries and an optional key from JSON stdin",
      options: [input],
      maxArguments: 0,
    },
    { name: "index", summary: "Build the index and wait for completion", maxArguments: 0 },
    {
      name: "search",
      usage: ["aireg discover search <query>", "aireg discover search --input-stdin"],
      summary: "Recommend a skill for a task",
      options: [input],
    },
    {
      name: "handoff",
      usage: ["aireg discover handoff <request-id>"],
      summary: "Prepare a handoff for a search request ID",
      maxArguments: 1,
    },
    {
      name: "feedback",
      usage: ["aireg discover feedback <request-id> helpful|not_helpful"],
      summary: "Record helpful or not_helpful feedback for a request ID",
      maxArguments: 2,
    },
    { name: "usage", summary: "Read local discovery usage", maxArguments: 0 },
    {
      name: "telemetry",
      usage: ["aireg discover telemetry on|off"],
      summary: "Turn local recording on or off",
      maxArguments: 1,
    },
    { name: "clear", summary: "Clear local history and recommendation receipts", maxArguments: 0 },
    { name: "disconnect", summary: "Remove the Gemini connection and index", maxArguments: 0 },
    {
      name: "score",
      usage: ["aireg discover score --input-stdin"],
      summary: "Score markdown supplied in a JSON object on stdin",
      options: [input],
      maxArguments: 0,
    },
  ],
};
