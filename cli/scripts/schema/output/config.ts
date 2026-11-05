import { Type } from "@sinclair/typebox";
import type { ConfigList, ConfigPath, ConfigSetting } from "#cli/commands/config/result.ts";
import { matching, outputDocument } from "./match.ts";

const Value = Type.Union([Type.String(), Type.Boolean(), Type.Null()], {
  description: "`null` when the setting is not set.",
});

const List = matching<ConfigList>()(Type.Record(Type.String(), Value));

const Path = matching<ConfigPath>()(
  Type.Object({ path: Type.String() }, { additionalProperties: false }),
);

const Setting = matching<ConfigSetting>()(
  Type.Object({ key: Type.String(), value: Value }, { additionalProperties: false }),
);

export const OUTPUT = outputDocument("config", {
  list: List,
  path: Path,
  get: Setting,
  set: Setting,
  unset: Setting,
});
