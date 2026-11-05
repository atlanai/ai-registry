/** One adapter installed from the release server, by the module path aireg loads. */
interface InstalledAdapter {
  id: string;
  specifier: string;
}

export interface AdapterList {
  adapters: InstalledAdapter[];
}

/** With `--dry-run`, what it would do. */
export interface AdapterInstall {
  dryRun: boolean;
  action: "already-installed" | "would-install" | "installed";
  id: string;
  version: string;
  specifier: string;
}

export interface AdapterRemove {
  dryRun: boolean;
  action: "would-remove" | "removed";
  id: string;
  specifier: string;
}

/** The files it wrote, or with `--dry-run` would write. */
export interface AdapterInit {
  id: string;
  dir: string;
  files: string[];
  dryRun: boolean;
}
