import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export async function prepareTemporaryStorage(): Promise<void> {
  const temporaryRoot = join(config.storageRoot, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const now = Date.now();
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("upload-")) continue;
    const path = join(temporaryRoot, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (
      metadata !== null &&
      now - metadata.mtimeMs >= config.temporaryMaxAgeMs
    ) {
      await rm(path, { recursive: true, force: true });
    }
  }
}
