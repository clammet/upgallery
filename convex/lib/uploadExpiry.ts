export const UPLOAD_EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "1day", label: "1 day" },
  { value: "3days", label: "3 days" },
  { value: "1week", label: "1 week" },
  { value: "3weeks", label: "3 weeks" },
  { value: "1month", label: "1 month" },
  { value: "3months", label: "3 months" },
  { value: "1year", label: "1 year" },
] as const;

export type UploadExpiry = (typeof UPLOAD_EXPIRY_OPTIONS)[number]["value"];

export const DEFAULT_UPLOAD_EXPIRY_OPTIONS: UploadExpiry[] =
  UPLOAD_EXPIRY_OPTIONS.map((option) => option.value);

// The separate Never preference distinguishes older saved duration lists from
// a deliberate opt-out, so existing galleries get the new option by default.
export function enabledUploadExpiryOptions(settings: {
  expiryOptions?: UploadExpiry[];
  expiryNeverEnabled?: boolean;
}): UploadExpiry[] {
  const saved = settings.expiryOptions ?? DEFAULT_UPLOAD_EXPIRY_OPTIONS;
  return DEFAULT_UPLOAD_EXPIRY_OPTIONS.filter((value) =>
    value === "never" ? settings.expiryNeverEnabled !== false : saved.includes(value),
  );
}

// Calendar months/years in UTC, clamped to the last day of the target month.
export function uploadExpiresAt(start: number, expiry: UploadExpiry): number | undefined {
  if (expiry === "never") return undefined;
  const days = { "1day": 1, "3days": 3, "1week": 7, "3weeks": 21 };
  if (expiry in days) {
    return start + days[expiry as keyof typeof days] * 24 * 60 * 60 * 1000;
  }
  const date = new Date(start);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + (expiry === "1month" ? 1 : expiry === "3months" ? 3 : 12));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
