import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localStateDir = join(projectRoot, ".convex", "local", "default");
const localConfigPath = join(localStateDir, "config.json");
const browserEnvPath = join(projectRoot, ".env.local");
const storageEnvPath = join(projectRoot, ".env.storage.local");
const storageRoot = join(projectRoot, ".storage");

const help = `Usage: pnpm devsetup

Create a fresh, local-only development environment.

This command preserves local Google OAuth and default-admin settings when
possible, then clears the project-local Convex database and .storage files.
It never targets a Convex cloud deployment. Stop pnpm dev before running it.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

if (process.argv.length > 2) {
  fail(`Unknown option: ${process.argv[2]}\n\n${help}`);
}

process.chdir(projectRoot);

let localConfig = readLocalConfig();
if (localConfig !== null) {
  await assertServicesStopped(localConfig);
} else {
  await assertServicesStopped({});
}

console.log("Installing dependencies...");
run("pnpm", ["install", "--frozen-lockfile"]);

if (localConfig === null) {
  console.log("Selecting a project-local Convex deployment...");
  run("pnpm", ["exec", "convex", "deployment", "select", "local"]);
  localConfig = readLocalConfig();
  if (localConfig === null) {
    fail(
      "Convex did not create project-local state in .convex/local/default. " +
        "Upgrade or migrate the local deployment, then run devsetup again.",
    );
  }
  await assertServicesStopped(localConfig);
}

const { deploymentName, ports } = validateLocalConfig(localConfig);
const previousBrowserEnv = readEnvFile(browserEnvPath);
const previousConvexEnv = readConvexEnvironment();
const googleClientId = firstConfiguredValue(
  previousBrowserEnv.VITE_GOOGLE_CLIENT_ID,
  previousConvexEnv.AUTH_GOOGLE_ID,
  "local-development-client-id",
);
const googleClientSecret = firstConfiguredValue(
  previousConvexEnv.AUTH_GOOGLE_SECRET,
  "local-development-secret-not-configured",
);
const storageSecret = randomBytes(32).toString("hex");

console.log("Clearing project-local Convex and storage data...");
for (const filename of [
  "convex_local_backend.sqlite3",
  "convex_local_backend.sqlite3-shm",
  "convex_local_backend.sqlite3-wal",
  "convex_local_backend.sqlite3-journal",
]) {
  rmSync(join(localStateDir, filename), { force: true });
}
rmSync(join(localStateDir, "convex_local_storage"), {
  force: true,
  recursive: true,
});
rmSync(storageRoot, { force: true, recursive: true });
mkdirSync(storageRoot, { recursive: true });

const convexUrl = `http://127.0.0.1:${ports.cloud}`;
const convexSiteUrl = `http://localhost:${ports.site}`;
writeEnvironmentFiles({
  convexUrl,
  convexSiteUrl,
  deploymentName,
  googleClientId,
  storageSecret,
});

console.log("Configuring the fresh local Convex deployment...");
const convexEnvironment = {
  AUTH_GOOGLE_ID: googleClientId,
  AUTH_GOOGLE_SECRET: googleClientSecret,
  SITE_URL: previousConvexEnv.SITE_URL || "http://localhost:5173",
  STORAGE_INTERNAL_SECRET: storageSecret,
};
if (previousConvexEnv.DEFAULT_ADMIN_EMAIL) {
  convexEnvironment.DEFAULT_ADMIN_EMAIL = previousConvexEnv.DEFAULT_ADMIN_EMAIL;
}
setConvexEnvironment(convexEnvironment);

console.log("Deploying Convex functions and generating types...");
run("pnpm", ["exec", "convex", "dev", "--once"]);

console.log("\nLocal development environment is blank and ready.");
console.log("Run: pnpm dev");
if (googleClientId === "local-development-client-id") {
  console.log(
    "Google sign-in uses placeholders; configure the OAuth values from README.md when needed.",
  );
}

function readLocalConfig() {
  if (!existsSync(localConfigPath)) return null;
  try {
    return JSON.parse(readFileSync(localConfigPath, "utf8"));
  } catch (error) {
    fail(`Could not read ${relative(localConfigPath)}: ${error.message}`);
  }
}

function validateLocalConfig(config) {
  if (
    typeof config.deploymentName !== "string" ||
    !config.deploymentName.startsWith("local-") ||
    !Number.isInteger(config.ports?.cloud) ||
    !Number.isInteger(config.ports?.site)
  ) {
    fail("The project-local Convex configuration is invalid or is not local.");
  }
  return config;
}

async function assertServicesStopped(config) {
  const checks = [
    [config.ports?.cloud, "Convex"],
    [8787, "storage API"],
    [8788, "storage worker"],
  ];
  for (const [port, name] of checks) {
    if (Number.isInteger(port) && (await respondsOn(port))) {
      fail(`${name} is running on port ${port}. Stop pnpm dev and try again.`);
    }
  }
}

async function respondsOn(port) {
  return await new Promise((resolveResponse) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (isOpen) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveResponse(isOpen);
    };
    const timeout = setTimeout(() => finish(false), 300);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readConvexEnvironment() {
  const result = spawnSync(
    "pnpm",
    ["exec", "convex", "env", "--deployment", "local", "list"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) return {};
  return parseEnv(result.stdout);
}

function setConvexEnvironment(values) {
  const temporaryDir = mkdtempSync(join(tmpdir(), "upgallery-devsetup-"));
  const temporaryEnv = join(temporaryDir, "convex.env");
  try {
    writeFileSync(
      temporaryEnv,
      Object.entries(values)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    run("pnpm", [
      "exec",
      "convex",
      "env",
      "--deployment",
      "local",
      "set",
      "--from-file",
      temporaryEnv,
      "--force",
    ]);
  } finally {
    rmSync(temporaryDir, { force: true, recursive: true });
  }
}

function writeEnvironmentFiles({
  convexUrl,
  convexSiteUrl,
  deploymentName,
  googleClientId,
  storageSecret,
}) {
  const browserTemplate = readFileSync(join(projectRoot, ".env.example"), "utf8");
  const browserEnv = updateEnv(browserTemplate, {
    CONVEX_DEPLOYMENT: `local:${deploymentName}`,
    CONVEX_URL: convexUrl,
    CONVEX_SITE_URL: convexSiteUrl.replace("localhost", "127.0.0.1"),
    VITE_CONVEX_URL: convexUrl.replace("127.0.0.1", "localhost"),
    VITE_CONVEX_SITE_URL: convexSiteUrl,
    VITE_GOOGLE_CLIENT_ID: googleClientId,
    VITE_STORAGE_API_URL: "",
  });
  writeFileSync(browserEnvPath, browserEnv, { mode: 0o600 });

  const storageTemplate = readFileSync(
    join(projectRoot, ".env.storage.example"),
    "utf8",
  );
  const storageEnv = updateEnv(storageTemplate, {
    CONVEX_SITE_URL: convexSiteUrl,
    STORAGE_INTERNAL_SECRET: storageSecret,
    STORAGE_ROOT: ".storage",
  });
  writeFileSync(storageEnvPath, storageEnv, { mode: 0o600 });
}

function updateEnv(template, values) {
  const remaining = new Map(Object.entries(values));
  const lines = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  const additions = [...remaining].map(([name, value]) => `${name}=${value}`);
  return [...additions, ...lines].join("\n").replace(/\n*$/, "\n");
}

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
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
        // Keep malformed quoted values verbatim; Convex will validate them.
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function firstConfiguredValue(...values) {
  return values.find(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      !value.startsWith("your-") &&
      !value.startsWith("<"),
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function relative(path) {
  return path.slice(projectRoot.length + 1);
}

function fail(message) {
  console.error(`devsetup: ${message}`);
  process.exit(1);
}
