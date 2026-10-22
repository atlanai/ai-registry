import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import * as actions from "./actions.ts";

describe("a console action", () => {
  test("runs in the folder the console shows, not the one it was opened in", async ({ tmp }) => {
    const shown = tmp;
    const entry = join(shown, "entry.mjs");
    await writeFile(entry, "console.log(process.cwd());\n");
    const argv = process.argv[1];
    process.argv[1] = entry;
    try {
      const lines: string[] = [];
      const running = actions.start(actions.runJob("job_1"), shown, (line) => lines.push(line));
      expect(await running.done).toBe(0);
      expect(lines).toEqual([shown]);
    } finally {
      process.argv[1] = argv as string;
    }
  });
});

describe("opening a link", () => {
  it("hands the browser an http(s) URL as one argument, on every platform", () => {
    const url = "https://example.com/a?b=1&calc";
    expect(actions.browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(actions.browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
    expect(actions.browserCommand(url, "win32")).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
    ]);
  });

  it("opens nothing that is not a web page, such as a file, an app or a flag", () => {
    for (const link of [
      "file:///etc/passwd",
      "/Applications/Calculator.app",
      "-a Calculator",
      "javascript:alert(1)",
      "smb://example.com/share",
      "not a url",
    ]) {
      expect(actions.browserCommand(link, "darwin"), link).toBeUndefined();
    }
  });
});

describe("the command a console action shows", () => {
  it("quotes an argument a shell would split or expand, so it can be pasted as shown", () => {
    expect(actions.publish(["pr-review"], "acme/engineering", "user").display).toBe(
      "aireg publish -g --to acme/engineering --yes -- pr-review",
    );
    expect(actions.runJob("it's $HOME").display).toBe("aireg job start -- 'it'\\''s $HOME'");
  });
});
