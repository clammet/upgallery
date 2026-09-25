import { useState } from "react";
import { Clock } from "lucide-react";

function expiryLabel(expiresAt: number, now: number) {
  let seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds <= 0) return "Expired";

  const parts: string[] = [];
  for (const [unit, length] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ] as const) {
    const count = Math.floor(seconds / length);
    if (count > 0) {
      parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
      seconds %= length;
      if (parts.length === 2) break;
    }
  }
  return `Expires in: ${parts.join(", ")}`;
}

export function ExpiryIndicator(props: {
  expiresAt: number;
  showDate?: boolean;
  size?: number;
}) {
  const [now, setNow] = useState(Date.now);
  const label = expiryLabel(props.expiresAt, now);
  return (
    <span
      title={label}
      aria-label={props.showDate ? undefined : label}
      tabIndex={0}
      onMouseEnter={() => setNow(Date.now())}
      onFocus={() => setNow(Date.now())}
    >
      {props.showDate ? (
        <time dateTime={new Date(props.expiresAt).toISOString()}>
          {new Date(props.expiresAt).toLocaleString()}
        </time>
      ) : (
        <Clock aria-hidden="true" size={props.size ?? 14} />
      )}
    </span>
  );
}
