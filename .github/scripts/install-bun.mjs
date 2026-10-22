import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const pin = JSON.parse(await readFile(new URL("../../cli/packaging/bun-runtime.json", import.meta.url), "utf8"));
const expected = (await readFile(new URL("../../cli/.bun-version", import.meta.url), "utf8")).trim();
requireValue(/^\d+\.\d+\.\d+-canary\.\d{8}\.\d+$/.test(pin.packageVersion), "Invalid Bun package version");
requireValue(/^[a-f0-9]{40}$/.test(pin.commit), "Invalid Bun source commit");
requireValue(
  /^\d+\.\d+\.\d+-canary\.\d+\+[a-f0-9]{9}$/.test(expected) && expected.endsWith(`+${pin.commit.slice(0, 9)}`),
  "Bun revision must match the pinned source commit",
);
requireValue(
  pin.integrity && Object.keys(pin.integrity).sort().join() === Object.keys(targets).sort().join(),
  "Bun integrity pins must cover exactly the release platforms",
);
for (const integrity of Object.values(pin.integrity)) {
  requireValue(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), "Invalid Bun integrity pin");
}

const os = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "x64" ? "amd64" : process.arch;
const target = `${os}-${arch}`;
const packageTarget = targets[target];
requireValue(packageTarget, `Unsupported Bun host: ${target}`);
const { RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath } = process.env;
requireValue(runnerTemp && isAbsolute(runnerTemp), "RUNNER_TEMP must be an absolute path");
requireValue(githubPath && isAbsolute(githubPath), "GITHUB_PATH must be an absolute path");

const name = `bun-${packageTarget}`;
const url = `https://registry.npmjs.org/@oven/${name}/-/${name}-${pin.packageVersion}.tgz`;
const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
requireValue(response.ok && response.body, `Bun download failed: HTTP ${response.status}`);
const length = Number(response.headers.get("content-length"));
requireValue(Number.isFinite(length) && length >= 0 && length <= MAX_ARCHIVE_BYTES, "Bun archive exceeds the size limit");
const chunks = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  requireValue(size <= MAX_ARCHIVE_BYTES, "Bun archive exceeds the size limit");
  chunks.push(chunk);
}
const archive = Buffer.concat(chunks);
const actual = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
requireValue(actual === pin.integrity[target], "Bun archive integrity mismatch");

const directory = await mkdtemp(join(runnerTemp, "aireg-bun-"));
const tarball = join(directory, "bun.tgz");
const bin = join(directory, "bin");
const executable = os === "windows" ? "bun.exe" : "bun";
await mkdir(bin);
try {
  await writeFile(tarball, archive, { flag: "wx", mode: 0o600 });
  // GNU tar treats Windows drive letters in archive paths as remote hosts.
  execFileSync("tar", ["-xzf", "bun.tgz", "-C", "bin", "--strip-components=2", `package/bin/${executable}`], {
    cwd: directory,
    stdio: "inherit",
  });
  const binary = join(bin, executable);
  await chmod(binary, 0o755);
  const revision = execFileSync(binary, ["--revision"], { encoding: "utf8" }).trim();
  requireValue(revision === expected, `Bun revision mismatch: expected ${expected}, got ${revision}`);
  await appendFile(githubPath, `${bin}\n`);
  console.log(`Installed Bun ${revision} (${target}) with verified SHA-512 integrity`);
} finally {
  await rm(tarball, { force: true });
}
