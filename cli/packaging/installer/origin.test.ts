import { describe, expect, test } from "vitest";
import { artifactBaseUrl, artifactsUrl, installerOrigin } from "./origin.ts";

// The origin reaches the rendered script inside double quotes, so anything that
// could close that quote or start a command has to be refused here.
describe("installer origin", () => {
  test("keeps an https origin with a plain path", () => {
    expect(installerOrigin("https://aireg.sh")).toBe("https://aireg.sh");
    expect(installerOrigin("https://releases.example.com/aireg/")).toBe(
      "https://releases.example.com/aireg",
    );
    expect(installerOrigin("https://localhost:8443/aireg")).toBe("https://localhost:8443/aireg");
  });

  test("refuses an origin the script could not quote safely, or that is not plain https", () => {
    for (const origin of [
      'https://aireg.sh/a"b',
      "https://aireg.sh/a;b",
      "https://aireg.sh/$(id)",
      "https://aireg.sh/a`id`",
      "https://aireg.sh/?channel=stable",
      "https://aireg.sh/#top",
      "https://user@aireg.sh",
      "http://aireg.sh",
      "aireg.sh",
    ]) {
      expect(installerOrigin(origin), origin).toBeUndefined();
      expect(artifactsUrl(origin), origin).toBeUndefined();
      expect(artifactBaseUrl(origin, "1.2.3"), origin).toBeUndefined();
    }
  });

  test("names one release's folder only for an exact SemVer", () => {
    expect(artifactBaseUrl("https://aireg.sh", "1.2.3")).toBe("https://aireg.sh/artifacts/v1.2.3");
    for (const version of ["latest", "v1.2.3", "1.2", "../../etc/passwd", "1.2.3+build"]) {
      expect(artifactBaseUrl("https://aireg.sh", version), version).toBeUndefined();
    }
  });
});
