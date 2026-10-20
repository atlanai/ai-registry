import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The e2e suites spawn the built binary, so they are slow by construction.
    // A ceiling here stops a loaded machine reading as a test failure.
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
      // Subprocess-based CLI tests are outside V8 instrumentation.
      thresholds: { lines: 45, functions: 45, branches: 42, statements: 44 },
    },
  },
});
