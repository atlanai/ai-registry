import { conformance } from "#test/conformance/kit.ts";

// No command of Cursor's lists skills, agents or plugins without signing in, so L1 only.
conformance({ id: "cursor" });
