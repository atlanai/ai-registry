/** What `aireg ui --json` prints once, before it serves until stopped. */
export interface UiResult {
  /** Carries the page's token after `#`, so treat it as a password for this session. */
  url: string;
  port: number;
}
