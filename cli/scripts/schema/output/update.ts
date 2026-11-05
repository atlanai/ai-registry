import { Type } from "@sinclair/typebox";
import type { UpdateResult } from "#cli/commands/update/result.ts";
import { OUTCOME } from "./install.ts";
import { matching, outputDocument } from "./match.ts";

const Update = matching<UpdateResult>()(Type.Object(OUTCOME, { additionalProperties: false }));

export const OUTPUT = outputDocument("update", { update: Update });
