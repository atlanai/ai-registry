import { expect, test } from "vitest";
import { yamlDocument } from "./document.ts";

test("drops an entry below a YAML mapping that is not there, then sets it", () => {
  const doc = yamlDocument(undefined, {}, "config.yaml");
  doc.drop(["mcp_servers", "srv"]);
  doc.set(["mcp_servers", "srv"], { command: "x" });
  expect(doc.value()).toEqual({ mcp_servers: { srv: { command: "x" } } });
});
