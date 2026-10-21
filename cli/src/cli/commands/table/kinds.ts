import type { OptionSpec } from "#core/host/extend.ts";
import { NAMESPACE } from "./options.ts";
import type { CommandSpec } from "./spec.ts";

const KIND_NEW: readonly OptionSpec[] = [
  NAMESPACE,
  {
    flag: "--set",
    value: "<key>=<value>",
    multiple: true,
    describe: "A field to fill in, with dots for nested ones (repeatable)",
  },
  {
    flag: "--file",
    value: "<file>",
    describe: "For a kind with more than one layout, the file to create",
  },
  {
    flag: "--from",
    value: "<path>",
    multiple: true,
    describe: "An existing skill folder or agent file to copy in (repeatable)",
  },
  {
    flag: "--name",
    value: "<name>",
    describe: "With --from, a new name for the artifact copied in",
  },
];

/** A kind the registry here holds is a command of its own: `aireg agent new triage`. */
export async function kindCommands(cwd: string): Promise<CommandSpec[]> {
  const { findRegistry } = await import("#core/filespec/write/init.ts");
  const { kindsOf } = await import("#core/filespec/write/kinds.ts");
  return Object.entries(await kindsOf(findRegistry(cwd))).map(([name, manifest]) => {
    const a = /^[aeiou]/.test(name) ? "an" : "a";
    const spec: CommandSpec = {
      name,
      summary: `Create ${a} ${name}, or start its next version`,
      group: "Share",
      usage: [`aireg ${name} <action> [options]`],
      examples: [
        {
          command: `aireg ${name} new pr-review --namespace engineering`,
          what: `a new ${name}`,
        },
        { command: `aireg ${name} bump pr-review minor`, what: "start its next minor version" },
      ],
      docs: "kinds",
      actions: [
        {
          name: "new",
          summary: `Create ${a} ${name}`,
          usage: [
            `aireg ${name} new [<name>] [options]`,
            `aireg ${name} new --from <path>... [options]`,
          ],
          options: KIND_NEW,
        },
        {
          name: "bump",
          summary: `Start the next version of ${a} ${name}`,
          usage: [`aireg ${name} bump <name> [patch | minor | major | <version>] [options]`],
          maxArguments: 2,
          options: [NAMESPACE],
        },
      ],
      load: async () => {
        const { runKind } = await import("#cli/commands/kind.ts");
        return { run: (context) => runKind(spec, manifest, context) };
      },
    };
    return spec;
  });
}
