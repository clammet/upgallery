import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(
  projectRoot,
  ".convex",
  "local",
  "default",
  "config.json",
);
const storageEnvPath = join(projectRoot, ".env.storage.local");
const outputDirectory = join(projectRoot, ".profiles");
const defaultDurationSeconds = 60;
const countdownSeconds = 5;

const help = `Usage: pnpm profile:upload -- [seconds]

Capture CPU samples of this project's local backend processes while
reproducing an upload: the Convex backend, the storage API (busboy, hashing,
location-data stripping) and the storage worker (thumbnails, previews,
metadata). The duration defaults to ${defaultDurationSeconds} seconds.

Run pnpm dev and pnpm profile:chrome first. During the
${countdownSeconds}-second countdown, switch to the profiling Chrome window and
begin the upload.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("profile:upload currently uses the macOS sample profiler.");
}

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === "--") commandArguments.shift();
const durationSeconds = parseDuration(commandArguments[0]);
if (commandArguments.length > 1) {
  fail(`Unknown option: ${commandArguments[1]}\n\n${help}`);
}

const config = readLocalConfig();
const cloudPort = config?.ports?.cloud;
if (!Number.isInteger(cloudPort)) {
  fail("Local Convex configuration is missing. Run pnpm devsetup first.");
}

const convexPid = processListeningOn(cloudPort);
if (convexPid === null) {
  fail(
    `No local Convex backend is listening on port ${cloudPort}. Run pnpm dev first.`,
  );
}

const targets = [{ label: "convex", pid: convexPid }];
const storagePort = readStoragePort();
const storageApiPid = processListeningOn(storagePort);
if (storageApiPid === null) {
  console.warn(
    `No storage API is listening on port ${storagePort}; skipping its sample.`,
  );
} else {
  targets.push({ label: "storage-api", pid: storageApiPid });
}
const workerPid = scriptProcess("storage/worker.ts");
if (workerPid === null) {
  console.warn("No storage worker process found; skipping its sample.");
} else {
  targets.push({ label: "storage-worker", pid: workerPid });
}

mkdirSync(outputDirectory, { recursive: true });
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(".", "-");

console.log(
  `Sampling ${targets.map((target) => `${target.label} (pid ${target.pid})`).join(", ")}.`,
);
console.log(
  `Sampling for ${durationSeconds} seconds after a ${countdownSeconds}-second countdown.`,
);
console.log(
  "Switch to the profiling Chrome window now, then upload the files.",
);
for (let remaining = countdownSeconds; remaining > 0; remaining -= 1) {
  console.log(`Starting in ${remaining}…`);
  await delay(1_000);
}
console.log("Backend CPU capture started.");

const results = await Promise.all(
  targets.map(async (target) => {
    const outputPath = join(
      outputDirectory,
      `${target.label}-upload-${timestamp}.txt`,
    );
    try {
      const code = await runSample(target.pid, durationSeconds, outputPath);
      return { ...target, outputPath, code };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...target, outputPath, code: 1, message };
    }
  }),
);

let failed = false;
for (const result of results) {
  if (result.code === 0) {
    console.log(
      `${result.label} CPU capture saved to ${relative(projectRoot, result.outputPath)}.`,
    );
  } else {
    failed = true;
    console.error(
      `${result.label} sample failed${result.message ? `: ${result.message}` : ""}.`,
    );
  }
}
if (failed) {
  fail(
    "If macOS denied access, allow your terminal under Privacy & Security > Developer Tools and retry.",
  );
}
console.log(
  "Wait for pnpm profile:chrome to report its trace file, then run pnpm profile:analyze on it.",
);

function parseDuration(raw) {
  if (raw === undefined) return defaultDurationSeconds;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 600) {
    fail(`Duration must be a whole number from 5 to 600 seconds.\n\n${help}`);
  }
  return parsed;
}

function readLocalConfig() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function readStoragePort() {
  if (!existsSync(storageEnvPath)) return 8787;
  const match = readFileSync(storageEnvPath, "utf8").match(/^PORT=(\d+)/m);
  return match === null ? 8787 : Number.parseInt(match[1], 10);
}

function processListeningOn(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const pids = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value));
  if (pids.length !== 1) return null;
  return pids[0];
}

// tsx watch runs a supervisor and a child that executes the script; sample
// the child, which is the process whose parent is also a match.
function scriptProcess(scriptPath) {
  const result = spawnSync("pgrep", ["-f", scriptPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const pids = result.stdout
    .trim()
    .split(/\s+/)
    .filter((value) => /^\d+$/.test(value));
  if (pids.length === 0) return null;
  const matched = new Set(pids);
  const children = pids.filter((pid) => {
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", pid], {
      encoding: "utf8",
    }).stdout.trim();
    return matched.has(parent);
  });
  return (children[0] ?? pids[0]) || null;
}

function runSample(pid, durationSeconds, outputPath) {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(
      "sample",
      [pid, String(durationSeconds), "5", "-file", outputPath],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`sample stopped from signal ${signal}`));
      } else {
        resolveExitCode(code ?? 1);
      }
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
