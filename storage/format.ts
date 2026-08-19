export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = value
    .toFixed(value >= 10 ? 1 : 2)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
  return `${rounded} ${units[index]}`;
}
