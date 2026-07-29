import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const heifInput = sharp.format.heif?.input;
const suffixes = heifInput?.fileSuffix ?? [];

if (
  heifInput?.file !== true ||
  heifInput.buffer !== true ||
  !suffixes.includes(".heic") ||
  !suffixes.includes(".heif")
) {
  throw new Error(
    "Sharp was built without HEIC/HEIF decoding. Rebuild it against a libvips installation that includes libheif.",
  );
}

console.log(
  `Sharp ${sharp.versions.sharp} is using libvips ${sharp.versions.vips} with HEIC/HEIF input support.`,
);

if (process.argv.includes("--decode-smoke")) {
  const directory = await mkdtemp(join(tmpdir(), "upgallery-heic-check-"));
  const pngPath = join(directory, "source.png");
  const heicPath = join(directory, "source.heic");
  try {
    await sharp({
      create: {
        width: 128,
        height: 96,
        channels: 3,
        background: "#6842a8",
      },
    })
      .png()
      .toFile(pngPath);
    await run("heif-enc", ["-q", "70", "-o", heicPath, pngPath]);
    const jpeg = await sharp(heicPath).jpeg().toBuffer();
    const metadata = await sharp(jpeg).metadata();
    if (
      metadata.format !== "jpeg" ||
      metadata.width !== 128 ||
      metadata.height !== 96
    ) {
      throw new Error("HEIC decode smoke test returned unexpected dimensions");
    }
    console.log("Decoded a generated HEIC image to JPEG successfully.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
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
