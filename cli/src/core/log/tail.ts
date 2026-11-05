import { statSync, watch } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

export interface TailOptions {
  path: string;
  /** Start here rather than at the end, for the lines already on disk. */
  fromByte?: number;
  signal?: AbortSignal;
}

const NEWLINE = 0x0a;

/**
 * `tail -F`, not `-f`: rotation renames the file out from under a reader, so
 * the path is followed. A smaller size means truncation, a new inode a roll.
 */
export async function* follow(options: TailOptions): AsyncGenerator<string> {
  const { path, signal } = options;
  let offset = options.fromByte ?? sizeOf(path);
  let inode = inodeOf(path);
  // A line the writer has not finished yet waits here for its newline.
  let pending = Buffer.alloc(0);

  let wake: (() => void) | undefined;
  const watcher = watch(dirname(path), () => wake?.());
  const stop = () => {
    watcher.close();
    wake?.();
  };
  signal?.addEventListener("abort", stop, { once: true });

  try {
    while (signal?.aborted !== true) {
      const read = await readPast(path, offset, inode);
      if (read !== undefined) {
        // Rolled or truncated: whatever was buffered past the cut is gone.
        if (read.restarted) pending = Buffer.alloc(0);
        inode = read.inode;
        offset = read.nextOffset;
        const bytes = Buffer.concat([pending, read.bytes]);
        const complete = bytes.lastIndexOf(NEWLINE) + 1;
        pending = bytes.subarray(complete);
        for (const line of bytes.subarray(0, complete).toString("utf8").split("\n").slice(0, -1)) {
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
        }
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
      });
    }
  } finally {
    watcher.close();
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function inodeOf(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

interface Read {
  inode: number;
  /** True when the file was rolled or truncated, so reading began again at its start. */
  restarted: boolean;
  nextOffset: number;
  bytes: Buffer;
}

async function readPast(
  path: string,
  offset: number,
  inode: number | undefined,
): Promise<Read | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const { ino, size } = await handle.stat();
    const restarted = ino !== inode || size < offset;
    const from = restarted ? 0 : offset;
    const bytes = Buffer.alloc(size - from);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from);
    return {
      inode: ino,
      restarted,
      nextOffset: from + bytesRead,
      bytes: bytes.subarray(0, bytesRead),
    };
  } finally {
    await handle.close();
  }
}
