import { render } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./app.ts";

/**
 * Reached only by a dynamic import, so these stay static: `await import("react")`
 * on a CommonJS module hands back a namespace whose shape depends on the bundler.
 */
export async function runApp(props: AppProps): Promise<void> {
  // patchConsole: a stray console write would push a frame into the scrollback.
  const instance = render(createElement(App, props), {
    exitOnCtrlC: true,
    patchConsole: true,
  });
  await instance.waitUntilExit();
}
