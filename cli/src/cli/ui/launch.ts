import { browserCommand } from "#core/console/actions.ts";
import { spawnDetached } from "#core/process.ts";

/** Watch launch failures instead of silently leaving the user with an empty browser. */
export function openBrowser(url: string): Promise<boolean> {
  const command = browserCommand(url);
  if (command === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawnDetached(...command);
      const timer = setTimeout(() => resolve(true), 1500);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}
