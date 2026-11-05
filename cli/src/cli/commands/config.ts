import { list as listOf, quoted } from "#adapter/text.ts";
import type { ConfigList, ConfigPath, ConfigSetting } from "#cli/commands/config/result.ts";
import { CONFIG_COMMAND } from "#cli/commands/config/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { closest, didYouMean } from "#cli/options/suggest.ts";
import type { RegistryConfig } from "#core/config/model.ts";
import { isNameCollision, isNamespaceAddress, nameCollisionOf } from "#core/config/model.ts";
import { configPath, readConfig, updateConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { table } from "#core/term/table.ts";
import { action, defineCommand } from "./define.ts";

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

interface Options {
  key: string | undefined;
  value: string | undefined;
}

export const { run } = defineCommand<Options>({
  spec: CONFIG_COMMAND,
  parse(argv) {
    const [verb = "list", key, value] = parse(argv, CONFIG_COMMAND).positionals;
    return { action: verb, options: { key, value } };
  },
  actions: {
    list: action({
      run: async (): Promise<ConfigList> => {
        const config = await readConfig();
        return Object.fromEntries(
          Object.entries(SETTINGS).map(([key, setting]) => [key, setting.read(config) ?? null]),
        );
      },
      text: (result, printer) => {
        const rows = Object.entries(result);
        table(
          printer,
          [
            { header: "key", value: ([key]: (typeof rows)[number]) => key },
            {
              header: "value",
              value: ([, current]: (typeof rows)[number]) =>
                current === null ? printer.style.dim("not set") : String(current),
            },
          ],
          rows,
        );
        printer.note("file", configPath());
      },
    }),
    path: action({
      run: async (): Promise<ConfigPath> => ({ path: configPath() }),
      text: (result, printer) => printer.info(result.path),
    }),
    get: action({
      run: async ({ key }): Promise<ConfigSetting> => {
        const known = knownKey("get", "aireg config get <key>", key);
        return { key: known, value: SETTINGS[known].read(await readConfig()) ?? null };
      },
      // Nothing but the value, so `$(aireg config get ...)` is usable.
      text: (result, printer) => {
        if (result.value !== null) printer.info(String(result.value));
      },
    }),
    set: action({
      run: async ({ key, value }): Promise<ConfigSetting> => {
        const known = knownKey("set", "aireg config set <key> <value>", key);
        if (value === undefined) {
          throw needsInput(
            "config set",
            `a value for ${known}`,
            `Name the value: \`aireg config set ${known} ${SETTINGS[known].value}\`.`,
          );
        }
        // Each setting checks its value; the file parser would name the file instead.
        SETTINGS[known].write(await readConfig(), value);
        const after = await updateConfig((current) => SETTINGS[known].write(current, value));
        return { key: known, value: SETTINGS[known].read(after) ?? null };
      },
      text: (result, printer) => printer.success(`Set ${result.key} to ${String(result.value)}.`),
    }),
    unset: action({
      run: async ({ key }): Promise<ConfigSetting> => {
        const known = knownKey("unset", "aireg config unset <key>", key);
        const after = await updateConfig((current) => SETTINGS[known].clear(current));
        return { key: known, value: SETTINGS[known].read(after) ?? null };
      },
      text: (result, printer) =>
        printer.success(
          result.value === null
            ? `Cleared ${result.key}.`
            : `Set ${result.key} back to ${String(result.value)}.`,
        ),
    }),
  },
});

function knownKey(verb: string, usage: string, key: string | undefined): Key {
  if (key === undefined) {
    throw needsInput(
      `config ${verb}`,
      "a setting name",
      `Name the setting: \`${usage}\`. ${settings()}`,
    );
  }
  if (!isKey(key)) throw unknownSetting(key);
  return key;
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
