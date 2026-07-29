import { describe, expect, test } from "vitest";
import {
  metadataLocation,
  metadataRows,
  openStreetMapUrls,
  parseMetadataJson,
} from "../src/lib/metadata";

describe("media metadata presentation", () => {
  test("parses canonical metadata and formats table rows", () => {
    const metadata = parseMetadataJson(
      JSON.stringify({
        GPSLongitude: 144.999,
        Duration: 2.768333,
        Resolution: "1080 × 1920",
        GPSLatitude: -37.8109,
      }),
    );

    expect(metadata).not.toBeNull();
    expect(metadataRows(metadata!)).toEqual([
      {
        key: "Resolution",
        label: "Resolution",
        value: "1080 × 1920",
      },
      {
        key: "Duration",
        label: "Duration",
        value: "2.77 s",
      },
      {
        key: "GPSLatitude",
        label: "Latitude",
        value: "-37.8109°",
      },
      {
        key: "GPSLongitude",
        label: "Longitude",
        value: "144.999°",
      },
    ]);
  });

  test("builds an OpenStreetMap marker for valid coordinates", () => {
    const location = metadataLocation({
      GPSLatitude: -37.8109,
      GPSLongitude: 144.999,
    });

    expect(location).toEqual({
      latitude: -37.8109,
      longitude: 144.999,
    });
    const urls = openStreetMapUrls(location!);
    expect(urls.embed).toContain("openstreetmap.org/export/embed.html");
    expect(urls.embed).toContain("marker=-37.8109%2C144.999");
    expect(urls.full).toContain("#map=16/-37.8109/144.999");
  });

  test("rejects malformed metadata and out-of-range coordinates", () => {
    expect(parseMetadataJson("not json")).toBeNull();
    expect(
      metadataLocation({
        GPSLatitude: -91,
        GPSLongitude: 144.999,
      }),
    ).toBeNull();
  });
});
