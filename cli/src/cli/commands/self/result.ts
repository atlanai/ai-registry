type UpdateAction =
  | "already-latest"
  | "update-available"
  | "would-update"
  | "updated"
  | "would-rollback"
  | "rolled-back";

/** After an update, `current` is the version now installed. */
export interface SelfUpdate {
  current: string;
  latest: string;
  action: UpdateAction;
  /** Only after an update: the executable PATH finds. */
  bin?: string;
  dryRun: boolean;
}

export interface SelfUninstall {
  action: "would-uninstall" | "uninstalled";
  dryRun: boolean;
  daemon: boolean;
  autostart: boolean;
  links: string[];
  startupFiles: string[];
  folders: string[];
  /** Left in place: a CLI aireg did not install, or a folder that holds your home. */
  kept: string[];
}
