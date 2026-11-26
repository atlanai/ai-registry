/** What started a run (file spec section 14.3). */
export const TRIGGERS = ["person", "model", "artifact", "unknown"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/**
 * One artifact a session loaded, as the session's record says. It carries where the artifact was
 * read from and when, never anything of the conversation.
 */
export interface Load {
  /** The session's own id; only ever hashed into a run id. */
  session: string;
  /** The turn it happened in, so loading one artifact twice in a turn counts once. */
  turn: string;
  /** ISO 8601. */
  at: string;
  /** Where the session ran, to find a project's lockfile; absent when the record leaves it out. */
  cwd: string | undefined;
  /** The absolute path of the folder the artifact was read from. */
  path: string;
  trigger: Trigger;
}

/** What a reader carries from one part of a file to the next, such as the current turn. */
export type ReaderState = Readonly<Record<string, string>>;

export interface Chunk {
  loads: Load[];
  state: ReaderState;
}

/** A time a session record gives that a run can carry: one `Date.parse` reads. */
export function isTime(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}
