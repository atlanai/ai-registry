import { defineConfig } from "tsup";
import { releaseDefines } from "#packaging/defines.ts";

export default defineConfig({
  entry: { main: "src/main.ts", adapter: "src/adapter/index.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  bundle: true,
  noExternal: [
    "yaml",
    // The console imports these dynamically, and a packed CLI has no node_modules to resolve them.
    "ink",
    "react",
    "react/jsx-runtime",
    "react-devtools-core",
  ],
  splitting: true,
  treeshake: true,
  minify: true,
  clean: true,
  sourcemap: false,
  define: releaseDefines(),
  // yaml is CJS; without this, esbuild's ESM shim throws on `require("process")`.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
