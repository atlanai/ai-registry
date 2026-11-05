/** `null` when not set, so the key is always present. */
type SettingValue = string | boolean | null;

export type ConfigList = Record<string, SettingValue>;

export interface ConfigPath {
  path: string;
}

/** `aireg config get`, `set` and `unset`: the setting as it now stands. */
export interface ConfigSetting {
  key: string;
  value: SettingValue;
}
