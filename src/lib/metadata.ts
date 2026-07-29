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

const preferredOrder = [
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
  AudioCodec: "Audio codec",
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
  Resolution: "Resolution",
  Rotation: "Rotation",
  Software: "Software",
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

function formatValue(key: string, value: string | number): string {
  if (typeof value === "string") return value;
  switch (key) {
    case "Duration":
      return `${trimmedDecimal(value, 2)} s`;
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
