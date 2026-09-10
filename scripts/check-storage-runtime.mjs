// Exercise both entrypoints with only the dependencies shipped in the image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

// An unavailable local backend keeps the worker idle and prevents external I/O.
const backend = createServer((_request, response) => {
  response.writeHead(503).end();
});
const backendPort = await listen(backend);
const root = await mkdtemp(join(tmpdir(), "storage-smoke-"));
try {
  for (const entrypoint of ["server", "worker"]) {
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, [`storage-dist/${entrypoint}.js`], {
      env: {
        PATH: process.env.PATH,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        NODE_ENV: "production",
        CONVEX_SITE_URL: `http://127.0.0.1:${backendPort}`,
        STORAGE_INTERNAL_SECRET: "isolated-storage-smoke-test",
        STORAGE_ROOT: join(root, entrypoint),
        STORAGE_SHUTDOWN_GRACE_MS: "1000",
        PORT: String(port),
        WORKER_HEALTH_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(500),
          });
          healthy = response.ok && (await response.json()).ok === true;
          if (healthy) break;
        } catch { /* Startup has not bound the port yet. */ }
        await delay(100);
      }
      assert(healthy, `${entrypoint} failed to start:\n${output}`);
      console.log(`${entrypoint}: runtime health check passed`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(force);
    }
  }
} finally {
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await rm(root, { recursive: true, force: true });
}
