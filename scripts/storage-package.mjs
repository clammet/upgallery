// Produce the storage-only dependency manifest inside its Docker build stage.
// Versions stay sourced from the root manifest so Renovate maintains one pin.
import { readFileSync, writeFileSync } from "node:fs";

const source = JSON.parse(readFileSync("package.json", "utf8"));
const runtimePackages = ["busboy", "exifr", "express", "helmet", "mime-types", "sharp"];
const dependencies = Object.fromEntries(runtimePackages.map((name) => {
  const version = source.dependencies[name];
  if (typeof version !== "string") throw new Error(`Missing storage dependency: ${name}`);
  return [name, version];
}));
writeFileSync("package.json", JSON.stringify({
  name: source.name,
  version: source.version,
  private: true,
  type: "module",
  packageManager: source.packageManager,
  dependencies,
}, null, 2) + "\n");
