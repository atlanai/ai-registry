import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { render } from "./build.ts";

const PAGE = join(import.meta.dirname, "..", "..", "ui", "public");
const read = (file: string) => readFileSync(join(PAGE, file), "utf8");
const scripts = () =>
  readdirSync(join(PAGE, "js"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => read(join("js", file)))
    .join("\n");

describe("the web console's page", () => {
  test("holds every element its script looks up", () => {
    const html = read("index.html");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const wanted = [...scripts().matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    // Read from every module, so a script that moves cannot pass this by finding none.
    expect(wanted.length).toBeGreaterThan(50);
    expect(wanted.filter((id) => !ids.has(id))).toEqual([]);
  });

  test("gives each element one id", () => {
    const ids = [...read("index.html").matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.filter((id, at) => ids.indexOf(id) !== at)).toEqual([]);
  });

  test("gives each control one way to handle a click", () => {
    // An onclick beside an addEventListener runs both: that is how a second install ran once.
    expect(scripts()).not.toMatch(/\.onclick\s*=/);
  });

  test("loads nothing from another host", () => {
    const html = read("index.html");
    expect([...html.matchAll(/\b(?:src|href)="(https?:)?\/\//g)]).toEqual([]);
    expect(scripts()).not.toMatch(/\bfetch\(['"`]https?:/);
    expect(scripts()).not.toMatch(/\bimport\s*\(?\s*['"`]https?:/);
  });

  test("is carried byte for byte by the generated module", () => {
    const module = render(["<p>é</p>", "a", "b"]);
    const bodies = [...module.matchAll(/"([A-Za-z0-9+/=]+)",\n/g)].map((match) =>
      Buffer.from(match[1] ?? "", "base64").toString("utf8"),
    );
    expect(bodies).toEqual(["<p>é</p>", "a", "b"]);
  });
});
