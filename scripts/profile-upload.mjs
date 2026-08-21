import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
const outputDirectory = join(projectRoot, ".profiles");
const defaultDurationSeconds = 60;
const countdownSeconds = 5;

const help = `Usage: pnpm profile:upload -- [seconds]

Capture a CPU sample of this project's local Convex backend while reproducing
an upload. The duration defaults to ${defaultDurationSeconds} seconds.

Run pnpm dev first. During the ${countdownSeconds}-second countdown, switch to
the browser, start a Chrome DevTools Performance recording, and begin the
upload.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("profile:upload currently uses the macOS sample profiler.");
}

const durationSeconds = parseDuration(process.argv[2]);
if (process.argv.length > 3) {
  fail(`Unknown option: ${process.argv[3]}\n\n${help}`);
}

const config = readLocalConfig();
const cloudPort = config?.ports?.cloud;
if (!Number.isInteger(cloudPort)) {
  fail("Local Convex configuration is missing. Run pnpm devsetup first.");
}

const pid = processListeningOn(cloudPort);
if (pid === null) {
  fail(
    `No local Convex backend is listening on port ${cloudPort}. Run pnpm dev first.`,
  );
}

mkdirSync(outputDirectory, { recursive: true });
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(".", "-");
const outputPath = join(outputDirectory, `convex-upload-${timestamp}.txt`);

console.log(`Found this project's Convex backend on port ${cloudPort}.`);
console.log(
  `Sampling for ${durationSeconds} seconds after a ${countdownSeconds}-second countdown.`,
);
console.log(
  "Switch to the browser now: start Performance recording, then upload the files.",
);
for (let remaining = countdownSeconds; remaining > 0; remaining -= 1) {
  console.log(`Starting in ${remaining}…`);
  await delay(1_000);
}
console.log("Backend CPU capture started.");

let result;
try {
  result = await runSample(pid, durationSeconds, outputPath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`The macOS sample profiler could not start: ${message}`);
}
if (result !== 0) {
  fail(
    "The macOS sample profiler failed. If macOS denied access, allow your terminal under Privacy & Security > Developer Tools and retry.",
  );
}

console.log(`Backend CPU capture saved to ${relative(projectRoot, outputPath)}.`);
console.log("Stop and save the browser Performance recording in the same folder.");

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

function runSample(pid, durationSeconds, outputPath) {
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(
      "sample",
      [pid, String(durationSeconds), "5", "-file", outputPath],
      { stdio: "inherit" },
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
