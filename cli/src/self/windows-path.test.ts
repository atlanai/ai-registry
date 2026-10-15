import { describe, expect, it } from "vitest";
import { withEntry, withoutEntry } from "./windows-path.ts";

const env = { USERPROFILE: "C:\\Users\\ada" };
const bin = "C:\\Users\\ada\\.aireg\\bin";

describe("withEntry", () => {
  it("puts the folder first, once", () => {
    expect(withEntry("C:\\tools;%USERPROFILE%\\bin", bin, env)).toBe(
      `${bin};C:\\tools;%USERPROFILE%\\bin`,
    );
    expect(withEntry("", bin, env)).toBe(bin);
  });

  it("finds the folder however Windows would spell it", () => {
    expect(withEntry("c:\\users\\ADA\\.aireg\\bin;C:\\tools", bin, env)).toBeUndefined();
    expect(withEntry("%userprofile%\\.aireg\\bin", bin, env)).toBeUndefined();
  });
});

describe("withoutEntry", () => {
  it("takes out every spelling of the folder and keeps the rest as written", () => {
    expect(withoutEntry(`C:\\tools;${bin};%USERPROFILE%\\.aireg\\bin;%PATHEXT%`, bin, env)).toBe(
      "C:\\tools;%PATHEXT%",
    );
  });

  it("says when there is nothing to take out", () => {
    expect(withoutEntry("C:\\tools", bin, env)).toBeUndefined();
  });
});
