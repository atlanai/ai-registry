import { Type } from "@sinclair/typebox";
import type { UiResult } from "#cli/commands/ui/result.ts";
import { matching, outputDocument } from "./match.ts";

const Ui = matching<UiResult>()(
  Type.Object(
    {
      url: Type.String({
        description:
          "The page's address. It carries this session's token after `#`, so treat it as a password.",
      }),
      port: Type.Integer({ description: "The port on 127.0.0.1 it serves from." }),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("ui", { ui: Ui });
