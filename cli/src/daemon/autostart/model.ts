import { envName } from "#core/env.ts";
import type { ExecResult } from "#core/process.ts";

/** Set in a service definition, so the daemon knows a supervisor will start it again. */
export const SUPERVISOR_ENV = envName("DAEMON_SUPERVISOR");

/** EX_TEMPFAIL: a supervised daemon exits with it to be started again, on the updated binary. */
export const RESTART_EXIT_CODE = 75;

type Mechanism = "launchd" | "systemd" | "run-key";

/** Never throws for a non-zero exit; callers read `code`. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

export interface ServiceSpec {
  /** Empty for the default home; otherwise tells two homes' services apart. */
  suffix: string;
  /** Runs the daemon in the foreground, for a supervisor. */
  daemon: readonly string[];
  /** Starts the daemon and returns, for a login hook that cannot supervise. */
  starter: readonly string[];
  env: Readonly<Record<string, string>>;
  stderrLog: string;
  home: string;
  configHome: string;
  uid: number;
}

export interface AutostartState {
  mechanism: Mechanism;
  /** The file or registry value holding the definition. */
  location: string;
  registered: boolean;
  /** The service manager knows the definition; a login-only hook is loaded when registered. */
  loaded: boolean;
  /** The definition on disk is the one `enable` would write now. */
  current: boolean;
}

export interface AutostartBackend {
  readonly mechanism: Mechanism;
  /** Restarts the daemon after a crash, so a self-update can exit and be started again. */
  readonly supervises: boolean;
  state(): Promise<AutostartState>;
  /** Writes the definition, loads it, and starts the daemon under it. */
  install(): Promise<void>;
  /** Unloads and deletes the definition; false when there was none. */
  uninstall(): Promise<boolean>;
  /** Starts the daemon through the manager; false when nothing is registered. */
  start(): Promise<boolean>;
  /** The definition on disk runs `program`. */
  starts(program: string): Promise<boolean>;
  /** Writes the definition without reloading it, so the manager runs it from its next start. */
  rewrite(): Promise<void>;
}
