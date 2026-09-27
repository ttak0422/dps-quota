import type { QuotaSnapshot, QuotaWindow } from "./quota.ts";

export function formatQuota(snapshot: QuotaSnapshot): string {
  const providerName = safeLabel(snapshot.provider.displayName);
  const lines = [
    `${providerName} usage quota (percentages, not token counts):`,
  ];

  if (snapshot.buckets.length === 0) {
    lines.push("No quota windows were returned.");
    return lines.join("\n");
  }

  for (const bucket of snapshot.buckets) {
    const label = safeLabel(bucket.displayName || bucket.id || "Quota");
    lines.push(`${label}:`);
    if (bucket.windows.length === 0) {
      lines.push("  no quota windows");
      continue;
    }
    for (const window of bucket.windows) {
      lines.push(formatWindow(window));
    }
  }
  return lines.join("\n");
}

function formatWindow(window: QuotaWindow): string {
  const details: string[] = [];
  if (typeof window.remainingPercent === "number") {
    details.push(`${window.remainingPercent}% remaining`);
  } else if (window.remainingPercent === null) {
    details.push("remaining unavailable");
  }
  if (typeof window.usedPercent === "number") {
    details.push(`${window.usedPercent}% used`);
  } else if (window.usedPercent === null) {
    details.push("used unavailable");
  }
  if (typeof window.durationMinutes === "number") {
    details.push(`${window.durationMinutes} min window`);
  } else if (window.durationMinutes === null) {
    details.push("window duration unavailable");
  }
  if (typeof window.resetsAtEpochSeconds === "number") {
    details.push(`resets at ${formatTimestamp(window.resetsAtEpochSeconds)}`);
  } else if (window.resetsAtEpochSeconds === null) {
    details.push("reset time unavailable");
  }

  const name = safeLabel(window.name);
  return `  ${name}: ${details.length > 0 ? details.join(", ") : "available"}`;
}

function formatTimestamp(epochSeconds: number): string {
  const timestamp = new Date(epochSeconds * 1000);
  return Number.isNaN(timestamp.getTime())
    ? String(epochSeconds)
    : timestamp.toISOString();
}

function safeLabel(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").slice(0, 120);
}
