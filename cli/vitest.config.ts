import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The e2e suites spawn the built binary, so a loaded machine needs a high ceiling.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "packaging/**/*.test.ts",
            "test/architecture.test.ts",
          ],
        },
      },
      { extends: true, test: { name: "integration", include: ["test/integration/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          globalSetup: ["test/kit/global-setup.ts"],
        },
      },
      { extends: true, test: { name: "contract", include: ["test/contract/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "conformance",
          include: ["test/conformance/**/*.test.ts"],
          globalSetup: ["test/kit/global-setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      // `test:coverage` runs only the in-process projects: V8 cannot see the CLI the e2e suites spawn.
      // Two points under what the suite covers, for platform skips; raise them as coverage grows.
      thresholds: { lines: 71, functions: 70, branches: 61, statements: 69 },
    },
  },
});
