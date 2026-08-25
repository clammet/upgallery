import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appStorageRoot = join(projectRoot, ".storage", "docker");
const userStorageRoot = join(projectRoot, ".user-storage");
const exampleStorageRoot = join(userStorageRoot, "example");
const localConfigPath = join(
  projectRoot,
  ".convex",
  "local",
  "default",
  "config.json",
);
const networkName = "upgallery-dev";
const temporaryVolumeName = "upgallery-dev-storage-tmp";
const storageImage = "upgallery-dev-storage:local";
const webImage = "upgallery-dev-web:local";
const containerNames = {
  api: "upgallery-dev-storage-api",
  worker: "upgallery-dev-storage-worker",
  web: "upgallery-dev-web",
};
const help = `Usage: pnpm dev:docker
       pnpm dev:docker:stop

Build and run Upgallery's production Docker image targets against the
project-local Convex deployment. Run pnpm devsetup once before this command.

The example user-backed mount is .user-storage/example. In Admin, create an
image gallery with Storage "User mount" and Internal storage path "example".
Files placed in that host directory remain there across container restarts and
pnpm devsetup resets.`;

const option = process.argv[2];
if (option === "--help" || option === "-h") {
  console.log(help);
  process.exit(0);
}
if (option === "--stop") {
  process.chdir(projectRoot);
  console.log("Stopping Docker development containers...");
  const publishedWebPort = containerPublishedPort(containerNames.web, "80/tcp");
  const stopped = stopAndRemoveContainers(Object.values(containerNames));
  const released =
    publishedWebPort === null ||
    (await waitForLocalPortRelease(publishedWebPort, 10_000));
  if (!released) {
    console.error(
      `dev:docker: port ${publishedWebPort} is still in use after container cleanup.`,
    );
  }
  if (!stopped || !released) process.exitCode = 1;
  process.exit();
}
if (option !== undefined) {
  fail(`Unknown option: ${option}\n\n${help}`);
}

process.chdir(projectRoot);

const browserEnv = readRequiredEnvFile(".env.local");
const storageEnv = readRequiredEnvFile(".env.storage.local");
const localConfig = readLocalConfig();
const publicConvexUrl = required(browserEnv, "VITE_CONVEX_URL", ".env.local");
const publicConvexSiteUrl = required(
  browserEnv,
  "VITE_CONVEX_SITE_URL",
  ".env.local",
);
const googleClientId = required(
  browserEnv,
  "VITE_GOOGLE_CLIENT_ID",
  ".env.local",
);
const siteUrl = required(browserEnv, "SITE_URL", ".env.local");
const browserSecret = required(
  browserEnv,
  "STORAGE_INTERNAL_SECRET",
  ".env.local",
);
const storageSecret = required(
  storageEnv,
  "STORAGE_INTERNAL_SECRET",
  ".env.storage.local",
);

if (browserSecret !== storageSecret) {
  fail(
    "STORAGE_INTERNAL_SECRET differs between .env.local and " +
      ".env.storage.local. Run pnpm devsetup to synchronize them.",
  );
}

const webPort = localWebPort(siteUrl);
const convexCloudPort = localConfig.ports.cloud;
const convexSitePort = localConfig.ports.site;
assertUrlPort(publicConvexUrl, convexCloudPort, "VITE_CONVEX_URL");
assertUrlPort(publicConvexSiteUrl, convexSitePort, "VITE_CONVEX_SITE_URL");
const storageConvexSiteUrl = containerHostUrl(publicConvexSiteUrl);

for (const [port, label] of [
  [webPort, "web app"],
  [8787, "storage API"],
  [8788, "storage worker"],
]) {
  if (await localPortIsInUse(port)) {
    fail(`${label} port ${port} is already in use. Stop pnpm dev and try again.`);
  }
}

for (const directory of [
  join(appStorageRoot, "shared"),
  join(appStorageRoot, "uploaders"),
  join(appStorageRoot, "derivatives", "gallery"),
  join(appStorageRoot, "derivatives", "up"),
  exampleStorageRoot,
]) {
  mkdirSync(directory, { recursive: true });
}

const mounts = {
  shared: join(appStorageRoot, "shared"),
  users: userStorageRoot,
  uploaders: join(appStorageRoot, "uploaders"),
  derivatives: join(appStorageRoot, "derivatives"),
};

let convexProcess;
let convexExitPromise;
const logProcesses = [];
const waitProcesses = [];
const startedContainers = [];
let receivedSignal;
const signalPromise = new Promise((resolveSignal) => {
  const handleSignal = (signal) => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    resolveSignal({ kind: "signal", signal });
  };
  // pnpm and the terminal may both forward Ctrl+C. Keep these handlers
  // installed so a duplicate signal cannot terminate cleanup halfway through.
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
});

try {
  console.log("Checking Docker...");
  run("docker", ["info"], { quiet: true });
  assertContainersAreAvailable();

  console.log("Building the production storage image...");
  run("docker", [
    "build",
    "--progress",
    "plain",
    "--target",
    "storage",
    "-t",
    storageImage,
    ".",
  ]);
  console.log("Building the production web image...");
  run("docker", [
    "build",
    "--progress",
    "plain",
    "--target",
    "web",
    "-t",
    webImage,
    ".",
  ]);

  ensureDockerObject("network", networkName);
  ensureDockerObject("volume", temporaryVolumeName);

  if (await canConnect(convexSitePort)) {
    console.log("Using the project-local Convex deployment already running.");
  } else {
    console.log("Starting the project-local Convex deployment...");
    convexProcess = spawnLogged(
      "convex",
      join(projectRoot, "node_modules", ".bin", "convex"),
      ["dev"],
      { env: process.env },
    );
    convexExitPromise = childExit(convexProcess).then((result) => ({
      kind: "process",
      label: "convex",
      ...result,
    }));
    await waitForPort(convexSitePort, convexProcess);
  }

  startStorageApi({ storageConvexSiteUrl, storageSecret, storageEnv });
  startStorageWorker({ storageConvexSiteUrl, storageSecret, storageEnv });
  startWeb({
    googleClientId,
    publicConvexSiteUrl,
    publicConvexUrl,
    webPort,
  });

  for (const [label, name] of Object.entries(containerNames)) {
    logProcesses.push(spawnLogged(label, "docker", ["logs", "--follow", name]));
    waitProcesses.push(waitForContainer(label, name));
  }

  await Promise.all([
    waitForHealthy("storage-api", containerNames.api, 180_000),
    waitForHealthy("storage-worker", containerNames.worker, 180_000),
    waitForHealthy("web", containerNames.web, 180_000),
  ]);

  console.log(`\nDocker development environment is ready at ${siteUrl}`);
  console.log(`Example user mount: ${relative(exampleStorageRoot)}`);
  console.log(
    'Admin settings: Storage "User mount", Internal storage path "example".',
  );
  console.log("Add, edit, or remove files in that host directory to test sync.\n");

  const monitoredProcesses = [
    signalPromise,
    ...waitProcesses,
  ];
  if (convexExitPromise !== undefined) {
    monitoredProcesses.push(convexExitPromise);
  }
  const outcome = await Promise.race(monitoredProcesses);

  if (outcome.kind === "process" && receivedSignal === undefined) {
    throw new Error(
      `${outcome.label} stopped unexpectedly with exit code ${outcome.code ?? "unknown"}.`,
    );
  }
} catch (error) {
  console.error(`dev:docker: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

function startStorageApi({ storageConvexSiteUrl, storageSecret, storageEnv }) {
  startContainer([
    "--name",
    containerNames.api,
    "--network",
    networkName,
    "--network-alias",
    "storage-api",
    "--read-only",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--cpus",
    "1.0",
    ...linuxHostGateway(),
    ...environmentArguments({
      ...pick(storageEnv, [
        "MAX_ABSOLUTE_UPLOAD_BYTES",
        "STORAGE_HEARTBEAT_INTERVAL_MS",
        "STORAGE_SHUTDOWN_GRACE_MS",
        "STORAGE_TEMP_MAX_AGE_MS",
        "STORAGE_WORKER_TASK_TIMEOUT_MS",
        "STORAGE_MAX_CONCURRENT_UPLOADS",
        "STORAGE_MAX_QUEUED_UPLOADS",
        "STORAGE_MAX_CONCURRENT_DOWNLOADS",
        "STORAGE_MAX_QUEUED_DOWNLOADS",
        "STORAGE_MAX_CONCURRENT_FILESYSTEM_OPERATIONS",
        "STORAGE_MAX_QUEUED_FILESYSTEM_OPERATIONS",
      ]),
      PORT: "8787",
      CONVEX_SITE_URL: storageConvexSiteUrl,
      STORAGE_INTERNAL_SECRET: storageSecret,
      STORAGE_ROOT: "/data/media",
    }),
    ...storageMountArguments(),
    "--mount",
    `type=volume,src=${temporaryVolumeName},dst=/data/media/.tmp`,
    "--tmpfs",
    "/tmp:rw,size=256m,mode=1777",
    "--health-cmd",
    "node -e \"fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"",
    "--health-interval",
    "10s",
    "--health-timeout",
    "5s",
    "--health-retries",
    "3",
    "--health-start-period",
    "15s",
    storageImage,
  ]);
}

function startStorageWorker({ storageConvexSiteUrl, storageSecret, storageEnv }) {
  startContainer([
    "--name",
    containerNames.worker,
    "--network",
    networkName,
    "--read-only",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2.0",
    ...linuxHostGateway(),
    ...environmentArguments({
      ...pick(storageEnv, [
        "STORAGE_POLL_INTERVAL_MS",
        "STORAGE_HEARTBEAT_INTERVAL_MS",
        "STORAGE_SHUTDOWN_GRACE_MS",
        "STORAGE_FFMPEG_TIMEOUT_MS",
        "STORAGE_WORKER_TASK_TIMEOUT_MS",
        "STORAGE_MEDIA_WORKER_CONCURRENCY",
        "STORAGE_SYNC_WORKER_CONCURRENCY",
        "STORAGE_SHARP_CONCURRENCY",
      ]),
      WORKER_HEALTH_PORT: "8788",
      CONVEX_SITE_URL: storageConvexSiteUrl,
      STORAGE_INTERNAL_SECRET: storageSecret,
      STORAGE_ROOT: "/data/media",
    }),
    ...storageMountArguments(),
    "--tmpfs",
    "/tmp:rw,size=512m,mode=1777",
    "--health-cmd",
    "node -e \"fetch('http://127.0.0.1:8788/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"",
    "--health-interval",
    "10s",
    "--health-timeout",
    "5s",
    "--health-retries",
    "3",
    "--health-start-period",
    "15s",
    storageImage,
    "node",
    "storage-dist/worker.js",
  ]);
}

function startWeb({
  googleClientId,
  publicConvexSiteUrl,
  publicConvexUrl,
  webPort,
}) {
  startContainer([
    "--name",
    containerNames.web,
    "--network",
    networkName,
    "--pids-limit",
    "128",
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--publish",
    `${webPort}:80`,
    ...environmentArguments({
      STORAGE_UPSTREAM: "storage-api:8787",
      PUBLIC_CONVEX_URL: publicConvexUrl,
      PUBLIC_CONVEX_SITE_URL: publicConvexSiteUrl,
      GOOGLE_CLIENT_ID: googleClientId,
    }),
    "--mount",
    `type=bind,src=${mounts.shared},dst=/data/media/public/shared,readonly`,
    "--mount",
    `type=bind,src=${mounts.users},dst=/data/media/public/users,readonly`,
    "--mount",
    `type=bind,src=${join(mounts.derivatives, "gallery")},dst=/data/media/derivatives/gallery,readonly`,
    "--health-cmd",
    "wget -q -O /dev/null http://127.0.0.1/healthz",
    "--health-interval",
    "10s",
    "--health-timeout",
    "5s",
    "--health-retries",
    "3",
    "--health-start-period",
    "10s",
    webImage,
  ]);
}

function storageMountArguments() {
  return [
    "--mount",
    `type=bind,src=${mounts.shared},dst=/data/media/public/shared`,
    "--mount",
    `type=bind,src=${mounts.users},dst=/data/media/public/users`,
    "--mount",
    `type=bind,src=${mounts.uploaders},dst=/data/media/protected/uploaders`,
    "--mount",
    `type=bind,src=${mounts.derivatives},dst=/data/media/derivatives`,
  ];
}

function startContainer(args) {
  run("docker", [
    "run",
    "--detach",
    "--label",
    "com.upgallery.environment=development",
    ...args,
  ]);
  const nameIndex = args.indexOf("--name");
  startedContainers.push(args[nameIndex + 1]);
}

function ensureDockerObject(kind, name) {
  const inspect = run("docker", [kind, "inspect", name], {
    allowFailure: true,
    quiet: true,
  });
  if (inspect.status !== 0) run("docker", [kind, "create", name]);
}

function assertContainersAreAvailable() {
  for (const name of Object.values(containerNames)) {
    const inspect = run(
      "docker",
      ["container", "inspect", "--format", "{{.State.Running}}", name],
      { allowFailure: true, quiet: true },
    );
    if (inspect.status !== 0) continue;
    if (inspect.stdout.trim() === "true") {
      fail(`${name} is already running. Stop the other pnpm dev:docker first.`);
    }
    run("docker", ["container", "rm", name], { quiet: true });
  }
}

async function cleanup() {
  for (const child of [...logProcesses, ...waitProcesses]) child.kill("SIGTERM");
  if (startedContainers.length > 0) {
    console.log("Stopping Docker development containers...");
    const stopped = stopAndRemoveContainers(startedContainers);
    if (!stopped) process.exitCode = 1;
  }
  if (convexProcess && convexProcess.exitCode === null) convexProcess.kill("SIGINT");
  if (startedContainers.includes(containerNames.web)) {
    const released = await waitForLocalPortRelease(webPort, 10_000);
    if (!released) {
      console.error(
        `dev:docker: port ${webPort} is still in use after container cleanup.`,
      );
      process.exitCode = 1;
    }
  }
}

function stopAndRemoveContainers(names) {
  const existing = names.filter((name) => containerExists(name));
  if (existing.length === 0) return true;

  const stop = run("docker", ["stop", "--timeout", "70", ...existing], {
    allowFailure: true,
    quiet: true,
  });
  if (stop.status !== 0) {
    console.error(
      `dev:docker: graceful container stop failed: ${commandError(stop)}`,
    );
  }

  const remove = run(
    "docker",
    ["container", "rm", ...(stop.status === 0 ? [] : ["--force"]), ...existing],
    { allowFailure: true, quiet: true },
  );
  if (remove.status !== 0) {
    console.error(`dev:docker: container removal failed: ${commandError(remove)}`);
    return false;
  }
  return true;
}

function containerExists(name) {
  return (
    run("docker", ["container", "inspect", name], {
      allowFailure: true,
      quiet: true,
    }).status === 0
  );
}

function containerPublishedPort(name, containerPort) {
  if (!containerExists(name)) return null;
  const result = run(
    "docker",
    [
      "container",
      "inspect",
      "--format",
      `{{(index (index .NetworkSettings.Ports "${containerPort}") 0).HostPort}}`,
      name,
    ],
    { allowFailure: true, quiet: true },
  );
  const port = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(port) ? port : null;
}

async function waitForHealthy(label, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = run(
      "docker",
      ["container", "inspect", "--format", "{{.State.Health.Status}}", name],
      { allowFailure: true, quiet: true },
    );
    const status = result.stdout.trim();
    if (status === "healthy") return;
    if (status === "unhealthy") {
      throw new Error(`${label} failed its Docker health check.`);
    }
    await delay(500);
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs / 1000}s.`);
}

function waitForContainer(label, name) {
  const child = spawn("docker", ["wait", name], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  return Object.assign(
    childExit(child).then(({ code }) => ({
      kind: "process",
      label,
      code: code === 0 ? Number(output.trim()) : code,
    })),
    { kill: (signal) => child.kill(signal) },
  );
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Convex exited before port ${port} became ready.`);
    }
    if (await canConnect(port)) return;
    await delay(250);
  }
  throw new Error(`Convex did not open port ${port} within 60s.`);
}

function canConnect(port) {
  return canConnectHost("127.0.0.1", port);
}

async function localPortIsInUse(port) {
  return (
    (await canConnectHost("127.0.0.1", port)) ||
    (await canConnectHost("::1", port))
  );
}

async function waitForLocalPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await localPortIsInUse(port))) return true;
    await delay(100);
  }
  return !(await localPortIsInUse(port));
}

function canConnectHost(host, port) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function spawnLogged(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixLines(child.stdout, label, console.log);
  prefixLines(child.stderr, label, console.error);
  return child;
}

function prefixLines(stream, label, write) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(`[${label}] ${line}`);
  });
  stream.on("end", () => {
    if (pending.length > 0) write(`[${label}] ${pending}`);
  });
}

function childExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function readRequiredEnvFile(filename) {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) fail(`${filename} is missing. Run pnpm devsetup first.`);
  return parseEnv(readFileSync(path, "utf8"));
}

function readLocalConfig() {
  if (!existsSync(localConfigPath)) {
    fail("The project-local Convex deployment is missing. Run pnpm devsetup first.");
  }
  const config = JSON.parse(readFileSync(localConfigPath, "utf8"));
  if (
    !Number.isInteger(config.ports?.cloud) ||
    !Number.isInteger(config.ports?.site)
  ) {
    fail("The project-local Convex configuration has invalid ports.");
  }
  return config;
}

function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        // The required-value checks below report malformed empty values.
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function required(values, name, filename) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is missing from ${filename}. Run pnpm devsetup first.`);
  }
  return value;
}

function localWebPort(siteUrl) {
  const url = parseLocalUrl(siteUrl, "SITE_URL");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("SITE_URL must contain a valid local port.");
  }
  return port;
}

function assertUrlPort(value, expectedPort, name) {
  const url = parseLocalUrl(value, name);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port !== expectedPort) {
    fail(`${name} must use the project-local Convex site port ${expectedPort}.`);
  }
}

function containerHostUrl(value) {
  const url = parseLocalUrl(value, "VITE_CONVEX_SITE_URL");
  url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/, "");
}

function parseLocalUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be a valid URL.`);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    fail(`${name} must target the project-local environment, not ${url.host}.`);
  }
  return url;
}

function environmentArguments(values) {
  return Object.entries(values).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
}

function pick(values, names) {
  return Object.fromEntries(
    names
      .filter((name) => values[name] !== undefined && values[name] !== "")
      .map((name) => [name, values[name]]),
  );
}

function linuxHostGateway() {
  return process.platform === "linux"
    ? ["--add-host", "host.docker.internal:host-gateway"]
    : [];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args[0]} failed with exit code ${result.status}.`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandError(result) {
  return result.stderr.trim() || `exit code ${result.status}`;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function relative(path) {
  return path.slice(projectRoot.length + 1);
}

function fail(message) {
  console.error(`dev:docker: ${message}`);
  process.exit(1);
}
