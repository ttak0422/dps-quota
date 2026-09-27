import {
  type AppServerOptions,
  QuotaError,
  type RateLimitsResponse,
  readRateLimits,
} from "./codex_app_server.ts";

export interface DispatcherHost {
  eval(expression: string): Promise<unknown>;
  call(functionName: string, ...args: unknown[]): Promise<unknown>;
  cmd(command: string): Promise<void>;
}

export interface QuotaDispatcher
  extends Record<string, (...args: unknown[]) => unknown> {
  get(...args: unknown[]): Promise<RateLimitsResponse>;
  Quota(...args: unknown[]): Promise<null>;
}

export type RateLimitsReader = (
  options: AppServerOptions,
) => Promise<RateLimitsResponse>;

const DEFAULT_TIMEOUT_MS = 15_000;

export function createDispatcher(
  host: DispatcherHost,
  fetchRateLimits: RateLimitsReader = readRateLimits,
): QuotaDispatcher {
  const get = async (): Promise<RateLimitsResponse> => {
    try {
      const options = await readOptions(host);
      return await fetchRateLimits(options);
    } catch (error) {
      if (error instanceof QuotaError) {
        throw error;
      }
      throw new QuotaError(
        "Could not read Codex usage quotas. Check the plugin configuration and Codex sign-in.",
      );
    }
  };

  return {
    get,
    Quota: async (): Promise<null> => {
      try {
        const result = await get();
        await echoMessage(host, formatQuota(result));
      } catch (error) {
        const message = error instanceof QuotaError
          ? error.message
          : "Could not read Codex usage quotas. Check the Codex CLI and sign-in.";
        try {
          await echoMessage(host, `Quota: ${message}`);
        } catch {
          // Do not surface host errors that might include unrelated sensitive data.
        }
      }
      return null;
    },
  };
}

async function echoMessage(
  host: DispatcherHost,
  message: string,
): Promise<void> {
  for (const line of message.split("\n")) {
    const literal = await host.call("string", line);
    if (typeof literal !== "string") {
      throw new QuotaError("Could not safely format the editor message.");
    }
    await host.cmd(`echomsg ${literal}`);
  }
}

async function readOptions(host: DispatcherHost): Promise<AppServerOptions> {
  let binary: unknown;
  let timeoutMs: unknown;
  try {
    [binary, timeoutMs] = await Promise.all([
      host.eval("get(g:, 'quota_codex_path', 'codex')"),
      host.eval(`get(g:, 'quota_timeout_ms', ${DEFAULT_TIMEOUT_MS})`),
    ]);
  } catch {
    throw new QuotaError(
      "Could not read g:quota_codex_path or g:quota_timeout_ms.",
    );
  }

  if (typeof binary !== "string" || binary.trim() === "") {
    throw new QuotaError(
      "g:quota_codex_path must be a non-empty Codex executable path.",
    );
  }
  if (
    typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 || timeoutMs > 120_000
  ) {
    throw new QuotaError(
      "g:quota_timeout_ms must be an integer from 100 to 120000.",
    );
  }
  return { binary, timeoutMs };
}

export function formatQuota(response: RateLimitsResponse): string {
  const lines = ["Codex usage quota (percentages, not token counts):"];
  let bucketCount = 0;

  const buckets = response.rateLimitsByLimitId;
  if (isRecord(buckets) && Object.keys(buckets).length > 0) {
    for (const [key, value] of Object.entries(buckets)) {
      addBucket(lines, value, key);
      bucketCount++;
    }
  } else if (
    response.rateLimits !== null && response.rateLimits !== undefined
  ) {
    addBucket(lines, response.rateLimits, "rateLimits");
    bucketCount++;
  }

  if (bucketCount === 0) {
    lines.push("No quota windows were returned.");
  }
  return lines.join("\n");
}

function addBucket(
  lines: string[],
  value: unknown,
  fallbackLabel: string,
): void {
  if (value === null) {
    lines.push(`${safeLabel(fallbackLabel)}: no quota data`);
    return;
  }
  if (!isRecord(value)) {
    lines.push(`${safeLabel(fallbackLabel)}: quota data unavailable`);
    return;
  }

  const label = typeof value.limitName === "string" && value.limitName !== ""
    ? value.limitName
    : typeof value.limitId === "string" && value.limitId !== ""
    ? value.limitId
    : fallbackLabel;
  lines.push(`${safeLabel(label)}:`);

  let hasWindow = false;
  for (const name of ["primary", "secondary"] as const) {
    if (!Object.hasOwn(value, name)) {
      continue;
    }
    hasWindow = true;
    const window = value[name];
    if (window === null) {
      lines.push(`  ${name}: no quota window`);
      continue;
    }
    if (!isRecord(window)) {
      lines.push(`  ${name}: quota window unavailable`);
      continue;
    }

    const details: string[] = [];
    if (typeof window.remainingPercent === "number") {
      details.push(`${window.remainingPercent}% remaining`);
    }
    if (typeof window.usedPercent === "number") {
      details.push(`${window.usedPercent}% used`);
    }
    if (typeof window.windowDurationMins === "number") {
      details.push(`${window.windowDurationMins} min window`);
    }
    if (typeof window.resetsAt === "number") {
      details.push(`resets at ${formatTimestamp(window.resetsAt)}`);
    }
    lines.push(
      `  ${name}: ${details.length > 0 ? details.join(", ") : "available"}`,
    );
  }
  if (!hasWindow) {
    lines.push("  no quota windows");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
