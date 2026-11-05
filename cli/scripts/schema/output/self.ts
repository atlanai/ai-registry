import { Type } from "@sinclair/typebox";
import type { SelfUninstall, SelfUpdate } from "#cli/commands/self/result.ts";
import { matching, outputDocument } from "./match.ts";

const Update = matching<SelfUpdate>()(
  Type.Object(
    {
      current: Type.String({ description: "After an update, the version now installed." }),
      latest: Type.String(),
      action: Type.Union([
        Type.Literal("already-latest"),
        Type.Literal("update-available"),
        Type.Literal("would-update"),
        Type.Literal("updated"),
        Type.Literal("would-rollback"),
        Type.Literal("rolled-back"),
      ]),
      bin: Type.Optional(
        Type.String({ description: "Only after an update: the executable PATH finds." }),
      ),
      dryRun: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

const Paths = Type.Array(Type.String());

const Uninstall = matching<SelfUninstall>()(
  Type.Object(
    {
      action: Type.Union([Type.Literal("would-uninstall"), Type.Literal("uninstalled")]),
      dryRun: Type.Boolean(),
      daemon: Type.Boolean(),
      autostart: Type.Boolean(),
      links: Paths,
      startupFiles: Paths,
      folders: Paths,
      kept: Type.Array(Type.String(), {
        description:
          "Left in place: a CLI aireg did not install, or a folder that holds your home.",
      }),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("self", { update: Update, uninstall: Uninstall });
