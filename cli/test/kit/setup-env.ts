import { HOST_ENV } from "./home.ts";

// In-process tests read process.env, so the developer's own agent setup must not reach them.
for (const name of HOST_ENV) delete process.env[name];
