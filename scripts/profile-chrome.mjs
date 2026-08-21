import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, ".profiles");
const profileDirectory = join(outputDirectory, "chrome-profile");
const defaultDurationSeconds = 60;

// Kept deliberately narrow. Every category multiplies the event volume, and a
// trace that outgrows Chrome's buffer loses data (see the record mode below).
// "blink.user_timing" carries React's dev-mode component render measures,
// which is what makes the render counts visible.
const traceCategories = [
  "-*",
  "blink.console",
  "blink.user_timing",
  "loading",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-v8.cpu_profiler",
  "v8.execute",
  "navigation",
  "rail",
].join(",");

const help = `Usage: pnpm profile:chrome -- [seconds]

Launch an isolated Chrome window that records an upload trace directly to
.profiles/ without opening or processing it in DevTools. The duration defaults
to ${defaultDurationSeconds} seconds.

Close any previous Chrome window launched by this command before starting a new
capture.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("profile:chrome currently supports macOS.");
}

const commandArguments = process.argv.slice(2);
if (commandArguments[0] === "--") commandArguments.shift();
const durationSeconds = parseDuration(commandArguments[0]);
if (commandArguments.length > 1) {
  fail(`Unknown option: ${commandArguments[1]}\n\n${help}`);
}

mkdirSync(profileDirectory, { recursive: true });
const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(".", "-");
const outputPath = join(outputDirectory, `chrome-upload-${timestamp}.json`);

console.log(
  `Launching an isolated Chrome profile for ${durationSeconds} seconds.`,
);
console.log(
  "Do not open the DevTools Performance panel; Chrome will save the trace itself.",
);
console.log(`Trace destination: ${relative(projectRoot, outputPath)}`);

try {
  await run("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--trace-startup=${traceCategories}`,
    `--trace-startup-duration=${durationSeconds}`,
    `--trace-startup-file=${outputPath}`,
    "--trace-startup-format=json",
    // Keep the start of the recording and stop when the buffer fills. The
    // ring-buffer mode ("record-continuously") drops the oldest events, which
    // takes the CPU profile's call-tree definitions with it and leaves the
    // samples unreadable.
    "--trace-startup-record-mode=record-as-much-as-possible",
    "http://localhost:5173",
  ]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Chrome could not be launched: ${message}`);
}

console.log("Chrome trace started. Reproduce the upload in the new window now.");
console.log(
  "If the buffer fills before the duration ends, the tail is dropped; shorten the capture rather than lengthen it.",
);
await delay(durationSeconds * 1_000);

const saved = await waitForStableFile(outputPath, 30_000);
if (!saved) {
  fail(
    "Chrome did not finish writing the trace. Close the profiling Chrome window, confirm Google Chrome is installed, and retry.",
  );
}

const megabytes = statSync(outputPath).size / (1024 * 1024);
console.log(
  `Chrome trace saved directly to ${relative(projectRoot, outputPath)} (${megabytes.toFixed(1)} MB).`,
);

function parseDuration(raw) {
  if (raw === undefined) return defaultDurationSeconds;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 600) {
    fail(`Duration must be a whole number from 5 to 600 seconds.\n\n${help}`);
  }
  return parsed;
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(
          new Error(
            `${command} failed with ${signal === null ? `exit code ${code}` : `signal ${signal}`}`,
          ),
        );
      }
    });
  });
}

async function waitForStableFile(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let previousSize = -1;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      stableChecks = size > 0 && size === previousSize ? stableChecks + 1 : 0;
      previousSize = size;
      if (stableChecks >= 4) return true;
    }
    await delay(500);
  }
  return false;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
