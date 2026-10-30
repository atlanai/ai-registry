import { conformance } from "#test/conformance/kit.ts";

// RPC mode answers `get_commands` with every skill it loaded, and needs no sign-in. With no
// session and no extensions, it saves nothing and lists only what it found on disk.
const rpc = ["pi", "--mode", "rpc", "--no-session", "--no-extensions"];
const commands = '{"type":"get_commands"}\n';

conformance({
  id: "pi",
  env: (home) => ({
    PI_CODING_AGENT_DIR: `${home}/.pi/agent`,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  }),
  probes: [
    // A project's skills load only once it is trusted; `--approve` trusts it for one run.
    {
      scope: "project",
      argv: [...rpc, "--approve"],
      stdin: commands,
      expect: [/project\/\.agents\/skills\/lint\/SKILL\.md","source":"auto","scope":"project"/],
    },
    {
      scope: "user",
      argv: rpc,
      stdin: commands,
      expect: [
        /\.agents\/skills\/lint\/SKILL\.md","source":"auto","scope":"user"/,
        /\.agents\/skills\/ship\/SKILL\.md","source":"auto","scope":"user"/,
      ],
    },
  ],
});
