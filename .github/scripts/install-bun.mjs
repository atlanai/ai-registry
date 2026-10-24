import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const targets = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-amd64": "darwin-x64",
  "linux-arm64": "linux-aarch64",
  "linux-amd64": "linux-x64",
  "windows-arm64": "windows-aarch64",
  "windows-amd64": "windows-x64",
};
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

const pin = JSON.parse(await readFile(new URL("../../cli/packaging/bun-runtime.json", import.meta.url), "utf8"));
const expected = (await readFile(new URL("../../cli/.bun-version", import.meta.url), "utf8")).trim();
assert(/^\d+\.\d+\.\d+(-canary\.\d{8}\.\d+)?$/.test(pin.packageVersion), "Invalid Bun package version");
assert(/^[a-f0-9]{40}$/.test(pin.commit), "Invalid Bun source commit");
assert(
  /^\d+\.\d+\.\d+(-canary\.\d+)?\+[a-f0-9]{9}$/.test(expected) && expected.endsWith(`+${pin.commit.slice(0, 9)}`),
  "Bun revision must match the pinned source commit",
);
assert(
  pin.integrity && Object.keys(pin.integrity).sort().join() === Object.keys(targets).sort().join(),
  "Bun integrity pins must cover exactly the release platforms",
);
for (const integrity of Object.values(pin.integrity)) {
  assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), "Invalid Bun integrity pin");
}

const os = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "x64" ? "amd64" : process.arch;
const target = `${os}-${arch}`;
const packageTarget = targets[target];
assert(packageTarget, `Unsupported Bun host: ${target}`);
const { RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath } = process.env;
assert(runnerTemp && isAbsolute(runnerTemp), "RUNNER_TEMP must be an absolute path");
assert(githubPath && isAbsolute(githubPath), "GITHUB_PATH must be an absolute path");

const name = `bun-${packageTarget}`;
const url = `https://registry.npmjs.org/@oven/${name}/-/${name}-${pin.packageVersion}.tgz`;
const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
assert(response.ok && response.body, `Bun download failed: HTTP ${response.status}`);
const length = Number(response.headers.get("content-length"));
assert(Number.isFinite(length) && length >= 0 && length <= MAX_ARCHIVE_BYTES, "Bun archive exceeds the size limit");
const chunks = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  assert(size <= MAX_ARCHIVE_BYTES, "Bun archive exceeds the size limit");
  chunks.push(chunk);
}
const archive = Buffer.concat(chunks);
const actual = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
assert(actual === pin.integrity[target], "Bun archive integrity mismatch");

const bin = await mkdtemp(join(runnerTemp, "aireg-bun-"));
const executable = os === "windows" ? "bun.exe" : "bun";
execFileSync("tar", ["-xzf", "-", "--strip-components=2", `package/bin/${executable}`], {
  cwd: bin,
  input: archive,
  stdio: ["pipe", "inherit", "inherit"],
  timeout: 60_000,
});
const binary = join(bin, executable);
await chmod(binary, 0o755);
const revision = execFileSync(binary, ["--revision"], { encoding: "utf8", timeout: 10_000 }).trim();
assert(revision === expected, `Bun revision mismatch: expected ${expected}, got ${revision}`);
await appendFile(githubPath, `${bin}\n`);
console.log(`Installed Bun ${revision} (${target}) with verified SHA-512 integrity`);
