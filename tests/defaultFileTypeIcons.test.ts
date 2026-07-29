import { describe, expect, test } from "vitest";
import {
  defaultFileTypeIcons,
  resolveDefaultFileTypeIcon,
  unknownFileTypeIcon,
} from "../src/lib/defaultFileTypeIcons";

describe("default file-type icon mapping", () => {
  test("maps representative extensions to the bundled assets", () => {
    expect(resolveDefaultFileTypeIcon(".ZIP")).toBe(defaultFileTypeIcons.zip);
    expect(resolveDefaultFileTypeIcon("mp3")).toBe(defaultFileTypeIcons.mp3);
    expect(resolveDefaultFileTypeIcon("tsx")).toBe(defaultFileTypeIcons.tsx);
    expect(resolveDefaultFileTypeIcon("pdf")).toBe(defaultFileTypeIcons.pdf);
    expect(resolveDefaultFileTypeIcon("swf")).toBe(defaultFileTypeIcons.swf);
    expect(resolveDefaultFileTypeIcon("txt")).toBe(defaultFileTypeIcons.txt);
    expect(resolveDefaultFileTypeIcon("m3u8")).toBe(defaultFileTypeIcons.m3u8);
    expect(resolveDefaultFileTypeIcon("mp4")).toBe(defaultFileTypeIcons.mp4);
  });

  test("uses the bundled unknown icon for unmapped extensions", () => {
    expect(resolveDefaultFileTypeIcon("notmapped")).toBe(unknownFileTypeIcon);
    expect(resolveDefaultFileTypeIcon("")).toBe(unknownFileTypeIcon);
  });
});
