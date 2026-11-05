import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { telemetryState } from "./state.ts";

describe("telemetryState", () => {
  test("is on only for a stamped build, and off once a switch holds a value", () => {
    expect(telemetryState({}, undefined)).toEqual({ on: false, why: "source-build" });
    expect(telemetryState({}, "https://aireg.sh")).toEqual({ on: true, url: "https://aireg.sh/t" });
    expect(telemetryState({}, "https://aireg.sh", false)).toEqual({ on: false, why: "config" });
    for (const name of ["DO_NOT_TRACK", "AIREG_DISABLE_TELEMETRY"]) {
      expect(telemetryState({ [name]: "1" }, "https://aireg.sh")).toMatchObject({ switch: name });
    }
  });
});
