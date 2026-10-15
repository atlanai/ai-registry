/**
 * Every name aireg leaves on disk, in the OS or in a release. Messages write
 * "aireg" as text; only a name the system or a file holds is built from NAME.
 */
export const NAME = "aireg";

/** The tool's home under `$HOME`. */
export const HOME_DIR = `.${NAME}`;

/** What the background service is registered as, per service manager; launchd wants a reverse-DNS label. */
export const SERVICE = {
  launchd: `sh.${NAME}.daemon`,
  systemd: `${NAME}-daemon`,
  runKey: `${NAME[0]?.toUpperCase()}${NAME.slice(1)}Daemon`,
} as const;

/** Files under the home whose names carry the tool's. */
export const DATABASE_FILE = `${NAME}.db`;
export const LOG_FILE = `${NAME}.log`;

/** The CLI's executable on disk; Windows finds a program by its extension. */
export function executableFile(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${NAME}.exe` : NAME;
}

export function releaseBinary(platform: string): string {
  return `${NAME}-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`;
}

/**
 * A user variable set and cleared again, so Windows tells running programs, such as
 * Explorer, that the user PATH changed.
 */
export const PATH_REFRESH_VARIABLE = `${NAME.toUpperCase()}_PATH_REFRESH`;
/** An adapter's file on the release server; the path already says it is aireg's, so no prefix. */
export const RELEASE_ADAPTER_FILE = "adapter.mjs";
/** What an installed adapter is saved as, under `adapters/<id>/<version>/`. */
export const ADAPTER_MODULE_FILE = "adapter.mjs";

/** The git tag a release is made under, as the release workflow writes it. */
export function releaseTag(version: string): string {
  return `${NAME}-v${version}`;
}

/** Who publishes aireg, as NOTICE says and a Windows binary's properties show. */
export const PUBLISHER = "Atlan Pte. Ltd.";

/** The npm package that publishes the adapter contract an adapter builds on. */
export const PACKAGE = `@atlanai/${NAME}`;

const OWNER = "atlanai";
export const REPOSITORY_NAME = "ai-registry";

/** The project's repository, as a git registry address; it also holds the `/aireg` skills. */
export const REPOSITORY = `github.com/${OWNER}/${REPOSITORY_NAME}`;

/** The documentation site, as `site_url` in mkdocs.yml publishes it. */
export const DOCS_URL = `https://${OWNER}.github.io/${REPOSITORY_NAME}/`;

/** The native entry file for an A2A agent in a registry. */
export const AGENT_CARD_ENTRY = "agent-card.json";
