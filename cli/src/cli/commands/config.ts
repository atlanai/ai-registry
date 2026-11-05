import { list as listOf, quoted } from "#adapter/text.ts";
import { CONFIG_COMMAND } from "#cli/commands/config/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { closest, didYouMean } from "#cli/options/suggest.ts";
import type { RegistryConfig } from "#core/config/model.ts";
import { isNameCollision, isNamespaceAddress, nameCollisionOf } from "#core/config/model.ts";
import { configPath, readConfig, updateConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { table } from "#core/term/table.ts";
import { type CommandContext, runAction } from "./command.ts";

/**
 * Only the settings a person sets by hand. Accounts and jobs have their own
 * commands: writing them here would mean editing a credential or a schedule.
 */
const SETTINGS = {
  "defaults.namespace": {
    value: "<registry>/<namespace>",
    read: (config: RegistryConfig) => config.defaults.namespace,
    write: (config: RegistryConfig, value: string): RegistryConfig => {
      if (!isNamespaceAddress(value)) {
        throw new AiregError(
          `\`defaults.namespace\` takes <registry>/<namespace>, not ${quoted(value)}.`,
          {
            code: ErrorCode.Usage,
            hint:
              value === ""
                ? "Run `aireg config unset defaults.namespace` to clear it."
                : "Use a value such as acme/engineering, each part lowercase letters, digits and hyphens.",
          },
        );
      }
      return { ...config, defaults: { ...config.defaults, namespace: value } };
    },
    clear: (config: RegistryConfig): RegistryConfig => {
      const { namespace: _, ...rest } = config.defaults;
      return { ...config, defaults: rest };
    },
  },
  "defaults.name-collision": {
    value: "rename | report | fail",
    read: (config: RegistryConfig) => nameCollisionOf(config),
    write: (config: RegistryConfig, value: string): RegistryConfig => {
      if (!isNameCollision(value)) {
        throw new AiregError(
          `\`defaults.name-collision\` takes rename, report or fail, not ${quoted(value)}.`,
          { code: ErrorCode.Usage, hint: "Run `aireg config set defaults.name-collision rename`." },
        );
      }
      return { ...config, defaults: { ...config.defaults, nameCollision: value } };
    },
    clear: (config: RegistryConfig): RegistryConfig => {
      const { nameCollision: _, ...rest } = config.defaults;
      return { ...config, defaults: rest };
    },
  },
  paused: {
    value: "true | false",
    read: (config: RegistryConfig) => config.paused,
    write: (config: RegistryConfig, value: string): RegistryConfig => {
      if (value !== "true" && value !== "false") {
        throw new AiregError(`\`paused\` takes true or false, not ${quoted(value)}.`, {
          code: ErrorCode.Usage,
          hint: "Run `aireg config set paused true`, or `aireg job pause`.",
        });
      }
      return { ...config, paused: value === "true" };
    },
    clear: (config: RegistryConfig): RegistryConfig => ({ ...config, paused: false }),
  },
} as const;

type Key = keyof typeof SETTINGS;

export async function run(context: CommandContext): Promise<void> {
  const spec = CONFIG_COMMAND;
  const { positionals } = parse(context.argv, spec);
  const [action = "list", key, value] = positionals;
  return runAction(spec, action, {
    list: () => list(context),
    path: () => path(context),
    get: () => get(context, key),
    set: () => set(context, key, value),
    unset: () => unset(context, key),
  });
}

async function list(context: CommandContext): Promise<void> {
  const config = await readConfig();
  const rows = Object.entries(SETTINGS).map(
    ([key, setting]) => [key, setting.read(config)] as const,
  );

  if (context.printer.format === "json") {
    // `null`, not absent: a key that vanishes when unset makes the shape
    // depend on the value, and a consumer cannot tell it from a typo.
    context.printer.json({
      ok: true,
      data: Object.fromEntries(rows.map(([key, value]) => [key, value ?? null])),
    });
    return;
  }

  const style = context.printer.style;
  table(
    context.printer,
    [
      { header: "key", value: ([key]: (typeof rows)[number]) => key },
      {
        header: "value",
        value: ([, current]: (typeof rows)[number]) =>
          current === undefined ? style.dim("not set") : String(current),
      },
    ],
    rows,
  );
  context.printer.note("file", configPath());
}

async function set(
  context: CommandContext,
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  if (key === undefined) throw needsKey("set", "aireg config set <key> <value>");
  if (!isKey(key)) throw unknownSetting(key);
  if (value === undefined) {
    throw new AiregError(`\`aireg config set\` needs a value for ${key}.`, {
      code: ErrorCode.Usage,
      hint: `Name the value: \`aireg config set ${key} ${SETTINGS[key].value}\`.`,
    });
  }

  // Each setting checks its value; the file parser would name the file instead.
  SETTINGS[key].write(await readConfig(), value);
  const after = await updateConfig((current) => SETTINGS[key].write(current, value));

  const stored = SETTINGS[key].read(after);
  context.printer.format === "json"
    ? context.printer.json({ ok: true, data: { key, value: stored } })
    : context.printer.success(`Set ${key} to ${String(stored)}.`);
}

function needsKey(action: string, usage: string): AiregError {
  return new AiregError(`\`aireg config ${action}\` needs a setting name.`, {
    code: ErrorCode.Usage,
    hint: `Name the setting: \`${usage}\`. ${settings()}`,
  });
}

function settings(): string {
  return `The settings are ${listOf(Object.keys(SETTINGS))}.`;
}

function isKey(value: string): value is Key {
  return Object.hasOwn(SETTINGS, value);
}

function unknownSetting(key: string): AiregError {
  return new AiregError(`Unknown setting ${quoted(key)}.`, {
    code: ErrorCode.Usage,
    hint: didYouMean(closest(key, Object.keys(SETTINGS)), settings()),
  });
}

async function path(context: CommandContext): Promise<void> {
  context.printer.format === "json"
    ? context.printer.json({ ok: true, data: { path: configPath() } })
    : context.printer.info(configPath());
}

async function get(context: CommandContext, key: string | undefined): Promise<void> {
  if (key === undefined) throw needsKey("get", "aireg config get <key>");
  if (!isKey(key)) throw unknownSetting(key);

  const current = SETTINGS[key].read(await readConfig());
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { key, value: current ?? null } });
    return;
  }
  // Nothing but the value, so `$(aireg config get ...)` is usable.
  if (current !== undefined) context.printer.info(String(current));
}

/** Back to the default, which for a setting with none is not set at all. */
async function unset(context: CommandContext, key: string | undefined): Promise<void> {
  if (key === undefined) throw needsKey("unset", "aireg config unset <key>");
  if (!isKey(key)) throw unknownSetting(key);

  const after = await updateConfig((current) => SETTINGS[key].clear(current));
  const stored = SETTINGS[key].read(after);
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { key, value: stored ?? null } });
    return;
  }
  context.printer.success(
    stored === undefined ? `Cleared ${key}.` : `Set ${key} back to ${String(stored)}.`,
  );
}
