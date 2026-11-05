/** Modes aireg creates files and folders with, named by who may use them. */
export const PRIVATE_FILE = 0o600;
export const PRIVATE_DIR = 0o700;

/** Masks over a mode: any group or other bit, and group or other write. */
export const OPEN_TO_OTHERS = 0o077;
export const WRITABLE_BY_OTHERS = 0o022;
