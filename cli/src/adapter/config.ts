import { AdapterError } from "./errors.ts";
import { list } from "./text.ts";

/** JSON Schema subset for `source.config`. Extra keys are refused when `properties` is set. */
export interface AdapterConfigSchema {
  required?: readonly string[];
  properties?: Readonly<Record<string, { type: "string" }>>;
}

export function assertAdapterConfig(
  adapter: string,
  schema: AdapterConfigSchema | undefined,
  config: Readonly<Record<string, string>>,
): void {
  if (schema === undefined) return;
  const required = schema.required ?? [];
  const missing = required.filter((key) => config[key] === undefined || config[key] === "");
  if (missing.length > 0) {
    const title = `The ${adapter} adapter needs ${keys(missing)} in its config.`;
    throw new AdapterError(adapter, "invalid", title, {
      problem: { code: "CONFIG_INVALID", title },
    });
  }
  const properties = schema.properties;
  if (properties === undefined) return;
  const extra = Object.keys(config).filter((key) => properties[key] === undefined);
  if (extra.length > 0) {
    const title = `The ${adapter} adapter does not take ${keys(extra)} in its config.`;
    const taken = Object.keys(properties);
    throw new AdapterError(adapter, "invalid", title, {
      problem: { code: "CONFIG_INVALID", title },
      hint:
        taken.length === 0
          ? `Leave out --config: the ${adapter} adapter takes no settings.`
          : `Leave it out: the ${adapter} adapter takes ${list(taken.map((key) => `\`${key}\``))}.`,
    });
  }
  for (const [key, value] of Object.entries(config)) {
    if (properties[key]?.type === "string" && typeof value !== "string") {
      const title = `\`${key}\` in the ${adapter} adapter's config must be text.`;
      throw new AdapterError(adapter, "invalid", title, {
        problem: { code: "CONFIG_INVALID", title },
      });
    }
  }
}

function keys(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}
