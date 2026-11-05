import { Type } from "@sinclair/typebox";
import type {
  AdapterInit,
  AdapterInstall,
  AdapterList,
  AdapterRemove,
} from "#cli/commands/adapter/result.ts";
import { matching, outputDocument } from "./match.ts";

const Specifier = Type.String({ description: "The module aireg loads for it." });

const List = matching<AdapterList>()(
  Type.Object(
    {
      adapters: Type.Array(
        Type.Object({ id: Type.String(), specifier: Specifier }, { additionalProperties: false }),
      ),
    },
    { additionalProperties: false },
  ),
);

const Install = matching<AdapterInstall>()(
  Type.Object(
    {
      dryRun: Type.Boolean(),
      action: Type.Union([
        Type.Literal("already-installed"),
        Type.Literal("would-install"),
        Type.Literal("installed"),
      ]),
      id: Type.String(),
      version: Type.String(),
      specifier: Specifier,
    },
    { additionalProperties: false },
  ),
);

const Remove = matching<AdapterRemove>()(
  Type.Object(
    {
      dryRun: Type.Boolean(),
      action: Type.Union([Type.Literal("would-remove"), Type.Literal("removed")]),
      id: Type.String(),
      specifier: Specifier,
    },
    { additionalProperties: false },
  ),
);

const Init = matching<AdapterInit>()(
  Type.Object(
    {
      id: Type.String(),
      dir: Type.String({ description: "The package's folder, as an absolute path." }),
      files: Type.Array(Type.String(), { description: "Paths within the package's folder." }),
      dryRun: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("adapter", {
  list: List,
  install: Install,
  remove: Remove,
  init: Init,
});
