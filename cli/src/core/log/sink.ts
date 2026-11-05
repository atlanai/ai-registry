import {
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { LOG_FILE } from "#core/product.ts";
import type { LogRecord, Sink } from "./model.ts";

interface FileSinkOptions {
  path: string;
  maxBytes?: number;
  keep?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 4;

/**
 * Writes are synchronous: a process that hands its tail to an async transport
 * loses the lines explaining why it exited.
 */
export function fileSink(options: FileSinkOptions): Sink {
  const { path, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = options;
  mkdirSync(dirname(path), { recursive: true });

  let fd: number | undefined;
  let written = 0;
  let closed = false;

  function open(): void {
    // Logs carry paths, arguments and redaction markers: owner-only, like credentials.json.
    fd = openSync(path, "a", PRIVATE_FILE);
    written = fstatSync(fd).size;
  }

  function release(): void {
    if (fd === undefined) return;
    const held = fd;
    fd = undefined;
    try {
      closeSync(held);
    } catch {
      // Already gone.
    }
  }

  /** False once another writer rotated or removed the file this one holds open. */
  function live(): boolean {
    if (fd === undefined) return false;
    try {
      return fstatSync(fd).ino === statSync(path).ino;
    } catch {
      return false;
    }
  }

  /**
   * Before the write, not after: rolling afterwards leaves the newest line in
   * the rolled file. A rotation another process holds the lock for is left to it.
   */
  function rollIfFull(incoming: number): void {
    if (written === 0 || written + incoming <= maxBytes) return;
    withRotateLock(path, () => {
      release();
      try {
        shift(path, keep);
      } finally {
        open();
      }
    });
  }

  try {
    open();
  } catch {
    return { write: () => {}, close: () => {} };
  }

  return {
    write(record: LogRecord): void {
      if (closed) return;
      try {
        if (!live()) {
          release();
          open();
        }
        const line = `${JSON.stringify(record)}\n`;
        const size = Buffer.byteLength(line);
        rollIfFull(size);
        if (fd === undefined) return;
        writeSync(fd, line);
        written += size;
      } catch {
        // A full or unwritable disk must not take the run down with it.
      }
    },
    close(): void {
      closed = true;
      release();
    },
  };
}

/** A directory is the portable atomic mutex; two rotations at once lose a rename. */
function withRotateLock(path: string, rotate: () => void): boolean {
  const lock = `${path}.rotating`;
  try {
    mkdirSync(lock);
  } catch {
    if (!reclaim(lock)) return false;
  }
  try {
    rotate();
    return true;
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Losing the lock directory would wedge every later rotation.
    }
  }
}

/** Far longer than a rotation takes, so a lock this old was left by a process that died in one. */
const ROTATE_STALE_MS = 60_000;

/** Takes over a lock left by a crash, which would otherwise stop rotation for good. */
function reclaim(lock: string): boolean {
  try {
    if (Math.abs(Date.now() - statSync(lock).mtimeMs) <= ROTATE_STALE_MS) return false;
    rmdirSync(lock);
    mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

function shift(path: string, keep: number): void {
  rmSync(`${path}.${keep}`, { force: true, recursive: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Absent rung.
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch (error) {
    // Removed under this process: there is nothing to roll, only a file to start.
    if (!isMissing(error)) throw error;
  }
}

/** Diagnostics on stderr, never stdout: stdout carries `--json` output. */
export function stderrSink(): Sink {
  return {
    write(record: LogRecord): void {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  };
}

export function multiSink(...sinks: readonly Sink[]): Sink {
  return {
    write: (record) => {
      for (const sink of sinks) sink.write(record);
    },
    close: () => {
      for (const sink of sinks) sink.close?.();
    },
  };
}

/**
 * Copies a file past `maxBytes` to `.1` and empties it in place, as logrotate's copytruncate
 * does: a service manager holding it open for appending keeps writing to the same file.
 */
export function trimCapture(path: string, maxBytes = DEFAULT_MAX_BYTES): void {
  try {
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) <= maxBytes) return;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
  } catch {
    // A capture that cannot be trimmed must not keep the daemon from starting.
  }
}

export const DAEMON_LOG_FILE = "daemon.log";
/** What escaped the daemon's logger, such as a crash before it opened its log. */
export const DAEMON_STDERR_FILE = "daemon-stderr.log";

/** Beside the rest of the CLI's state, so `AIREG_HOME` isolates tests too. */
export function logPath(home: string, name = LOG_FILE): string {
  return join(home, "logs", name);
}
