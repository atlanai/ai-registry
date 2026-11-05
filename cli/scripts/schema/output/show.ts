import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import type { ShowResult } from "#cli/commands/show/result.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const CARRIED = ["hooks", "mcpServers", "lspServers", "monitors", "bin"] as const;

const Carries = Type.Array(oneOf(CARRIED), {
  description: "What a target that loads it starts on its own, by plugin manifest key.",
});

const Artifact = Type.Object(
  {
    name: Type.String(),
    kind: oneOf(KINDS),
    version: Type.Optional(Type.String({ description: "The version the registry serves." })),
    body: Type.String({ description: "The Markdown file as written." }),
    carries: Carries,
  },
  { additionalProperties: false, description: "An artifact a registry serves." },
);

const File = Type.Object(
  {
    path: Type.String({ description: "The Markdown file read." }),
    body: Type.String({ description: "The file as written." }),
    carries: Carries,
  },
  { additionalProperties: false, description: "A file or folder named by its path." },
);

const Show = matching<ShowResult>()(Type.Union([Artifact, File]));

export const OUTPUT = outputDocument("show", { show: Show });
