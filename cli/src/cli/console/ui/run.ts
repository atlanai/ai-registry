import { render } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./app.ts";

/** Imports stay static: `await import("react")` of CommonJS has a bundler-dependent shape. */
export async function runApp(props: AppProps): Promise<void> {
  // patchConsole: a stray console write would push a frame into the scrollback.
  const instance = render(createElement(App, props), {
    exitOnCtrlC: true,
    patchConsole: true,
  });
  await instance.waitUntilExit();
}
