import { conformance } from "#test/conformance/kit.ts";

// Its CLI cannot be pinned to a release 7 days old, so this checks placements alone.
conformance({ id: "muse" });
