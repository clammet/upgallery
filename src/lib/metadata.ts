import exifr from "exifr";

export type MediaMetadata = Record<string, string | number>;

export type MediaLocation = {
  latitude: number;
  longitude: number;
};

export type MetadataRow = {
  key: string;
  label: string;
  value: string;
};

type MetadataInput = Parameters<typeof exifr.gps>[0];

type ExifrFileProbe = {
  getString: (offset: number, length: number) => string;
  getUint16: (offset: number) => number;
};

type ExifrFileParser = {
  canHandle: (file: ExifrFileProbe, firstTwoBytes: number) => boolean;
  upgalleryHeicPatched?: boolean;
};

const preferredOrder = [
  "Title",
  "Artist",
  "Album",
  "AlbumArtist",
  "Track",
  "Disc",
  "Genre",
  "Date",
  "Resolution",
  "DateTimeOriginal",
  "Make",
  "Model",
  "LensModel",
  "Software",
  "Format",
  "VideoCodec",
  "AudioCodec",
  "Duration",
  "SampleRate",
  "Channels",
  "ChannelLayout",
  "BitDepth",
  "BitRate",
  "FrameRate",
  "Rotation",
  "ExposureTime",
  "FNumber",
  "ISO",
  "FocalLength",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
  "GPSHorizontalAccuracy",
];

const labels: Record<string, string> = {
  Album: "Album",
  AlbumArtist: "Album artist",
  Artist: "Artist",
  AudioCodec: "Audio codec",
  BitDepth: "Bit depth",
  BitRate: "Bit rate",
  ChannelLayout: "Channel layout",
  Channels: "Channels",
  Date: "Date",
  DateTimeOriginal: "Captured",
  Duration: "Duration",
  ExposureTime: "Exposure time",
  FNumber: "Aperture",
  FocalLength: "Focal length",
  Format: "Format",
  FrameRate: "Frame rate",
  GPSAltitude: "Altitude",
  GPSHorizontalAccuracy: "Location accuracy",
  GPSLatitude: "Latitude",
  GPSLongitude: "Longitude",
  ISO: "ISO",
  LensModel: "Lens",
  Make: "Make",
  Model: "Model",
  Disc: "Disc",
  Genre: "Genre",
  Resolution: "Resolution",
  Rotation: "Rotation",
  Software: "Software",
  SampleRate: "Sample rate",
  Title: "Title",
  Track: "Track",
  VideoCodec: "Video codec",
};

export function parseMetadataJson(json: string): MediaMetadata | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const metadata: MediaMetadata = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        (typeof value === "string" && value.trim() !== "") ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        metadata[key] = value;
      }
    }
    return Object.keys(metadata).length === 0 ? null : metadata;
  } catch {
    return null;
  }
}

export function metadataRows(metadata: MediaMetadata): MetadataRow[] {
  const rank = new Map(preferredOrder.map((key, index) => [key, index]));
  return Object.entries(metadata)
    .sort(
      ([left], [right]) =>
        (rank.get(left) ?? preferredOrder.length) -
          (rank.get(right) ?? preferredOrder.length) ||
        left.localeCompare(right),
    )
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? humanizeKey(key),
      value: formatValue(key, value),
    }));
}

export function metadataLocation(
  metadata: MediaMetadata,
): MediaLocation | null {
  const latitude = numericValue(metadata.GPSLatitude);
  const longitude = numericValue(metadata.GPSLongitude);
  if (
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

export function openStreetMapUrls(location: MediaLocation): {
  embed: string;
  full: string;
} {
  const latitude = decimalCoordinate(location.latitude);
  const longitude = decimalCoordinate(location.longitude);
  const latitudeDelta = 0.006;
  const longitudeDelta =
    latitudeDelta /
    Math.max(0.2, Math.cos((location.latitude * Math.PI) / 180));
  const bbox = [
    Math.max(-180, location.longitude - longitudeDelta),
    Math.max(-90, location.latitude - latitudeDelta),
    Math.min(180, location.longitude + longitudeDelta),
    Math.min(90, location.latitude + latitudeDelta),
  ]
    .map(decimalCoordinate)
    .join(",");
  const query = new URLSearchParams({
    bbox,
    layer: "mapnik",
    marker: `${latitude},${longitude}`,
  });
  return {
    embed: `https://www.openstreetmap.org/export/embed.html?${query}`,
    full:
      `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}` +
      `#map=16/${latitude}/${longitude}`,
  };
}

export async function fileHasLocationMetadata(
  file: MetadataInput,
): Promise<boolean> {
  installModernHeicDetection();
  const location = await exifr.gps(file).catch(() => undefined);
  return (
    location !== undefined &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

function formatValue(key: string, value: string | number): string {
  if (typeof value === "string") return value;
  switch (key) {
    case "Duration":
      return `${trimmedDecimal(value, 2)} s`;
    case "SampleRate":
      return value >= 1_000
        ? `${trimmedDecimal(value / 1_000, 2)} kHz`
        : `${trimmedDecimal(value, 0)} Hz`;
    case "BitDepth":
      return `${trimmedDecimal(value, 0)}-bit`;
    case "BitRate":
      return value >= 1_000_000
        ? `${trimmedDecimal(value / 1_000_000, 2)} Mb/s`
        : `${trimmedDecimal(value / 1_000, 0)} kb/s`;
    case "ExposureTime":
      return value > 0 && value < 1
        ? `1/${Math.round(1 / value)} s`
        : `${trimmedDecimal(value, 3)} s`;
    case "FNumber":
      return `f/${trimmedDecimal(value, 2)}`;
    case "FocalLength":
      return `${trimmedDecimal(value, 2)} mm`;
    case "FrameRate":
      return `${trimmedDecimal(value, 2)} fps`;
    case "GPSAltitude":
    case "GPSHorizontalAccuracy":
      return `${trimmedDecimal(value, 2)} m`;
    case "GPSLatitude":
    case "GPSLongitude":
      return `${decimalCoordinate(value)}°`;
    case "Rotation":
      return `${trimmedDecimal(value, 1)}°`;
    default:
      return String(value);
  }
}

function numericValue(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function humanizeKey(key: string): string {
  return key
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function decimalCoordinate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function trimmedDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function installModernHeicDetection(): void {
  const parser = exifr.fileParsers.get("heic") as
    | ExifrFileParser
    | undefined;
  if (parser === undefined || parser.upgalleryHeicPatched === true) return;

  const originalCanHandle = parser.canHandle;
  parser.canHandle = function (
    file: ExifrFileProbe,
    firstTwoBytes: number,
  ): boolean {
    if (originalCanHandle.call(this, file, firstTwoBytes)) return true;
    if (firstTwoBytes !== 0) return false;
    const ftypLength = file.getUint16(2);
    if (ftypLength < 16 || ftypLength > 4096) return false;
    for (let offset = 8; offset + 4 <= ftypLength; offset += 4) {
      if (
        new Set([
          "heic",
          "heix",
          "hevc",
          "hevx",
          "heim",
          "heis",
          "hevm",
          "hevs",
        ]).has(file.getString(offset, 4))
      ) {
        return true;
      }
    }
    return false;
  };
  parser.upgalleryHeicPatched = true;
}
