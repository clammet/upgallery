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
        VideoResolution: "1080 × 1920",
        VideoBitRate: 7000000,
        AudioBitRate: 192000,
        AudioChannels: "2 (stereo)",
        GPSLatitude: -37.8109,
      }),
    );

    expect(metadata).not.toBeNull();
    expect(metadataRows(metadata!)).toEqual([
      {
        key: "Duration",
        label: "Duration",
        value: "2.77 s",
      },
      {
        key: "VideoResolution",
        label: "Video resolution",
        value: "1080 × 1920",
      },
      {
        key: "VideoBitRate",
        label: "Video bitrate",
        value: "7 Mb/s",
      },
      {
        key: "AudioBitRate",
        label: "Audio bitrate",
        value: "192 kb/s",
      },
      {
        key: "AudioChannels",
        label: "Audio channels",
        value: "2 (stereo)",
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

  test("orders and labels numbered streams and subtitle languages", () => {
    expect(
      metadataRows({
        Subtitles: "eng, jpn",
        Audio2Channels: "6 (5.1)",
        Video2Codec: "H.265 / HEVC",
        Audio1Codec: "AAC",
        Video1Codec: "H.264 / AVC",
        Audio1SampleRate: 48000,
        Video1BitRate: 5000000,
      }),
    ).toEqual([
      {
        key: "Video1Codec",
        label: "Video 1 codec",
        value: "H.264 / AVC",
      },
      {
        key: "Video1BitRate",
        label: "Video 1 bitrate",
        value: "5 Mb/s",
      },
      {
        key: "Video2Codec",
        label: "Video 2 codec",
        value: "H.265 / HEVC",
      },
      {
        key: "Audio1Codec",
        label: "Audio 1 codec",
        value: "AAC",
      },
      {
        key: "Audio1SampleRate",
        label: "Audio 1 sample rate",
        value: "48 kHz",
      },
      {
        key: "Audio2Channels",
        label: "Audio 2 channels",
        value: "6 (5.1)",
      },
      {
        key: "Subtitles",
        label: "Subtitles",
        value: "eng, jpn",
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
