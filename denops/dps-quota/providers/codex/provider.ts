import {
  QuotaError,
  type QuotaProvider,
  type QuotaReadResult,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../../quota.ts";
import {
  type AppServerOptions,
  type RateLimitsResponse,
  readRateLimits,
} from "./app_server.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const CODEX_WINDOWS = ["primary", "secondary"] as const;

export type CodexConfigEvaluator = (expression: string) => Promise<unknown>;
export type RateLimitsReader = (
  options: AppServerOptions,
) => Promise<RateLimitsResponse>;

export function createCodexProvider(
  evaluate: CodexConfigEvaluator,
  fetchRateLimits: RateLimitsReader = readRateLimits,
): QuotaProvider {
  return {
    id: "codex",
    displayName: "Codex",
    async read(): Promise<QuotaReadResult> {
      const options = await readCodexOptions(evaluate);
      const raw = await fetchRateLimits(options);
      return { snapshot: mapCodexQuota(raw), raw };
    },
  };
}

export function mapCodexQuota(raw: RateLimitsResponse): QuotaSnapshot {
  const mappedBuckets = readBucketEntries(raw);
  return {
    provider: { id: "codex", displayName: "Codex" },
    buckets: mappedBuckets.map(({ id, value }) => mapBucket(value, id)),
  };
}

async function readCodexOptions(
  evaluate: CodexConfigEvaluator,
): Promise<AppServerOptions> {
  let binary: unknown;
  let timeoutMs: unknown;
  try {
    [binary, timeoutMs] = await Promise.all([
      evaluate("get(g:, 'quota_codex_path', 'codex')"),
      evaluate(`get(g:, 'quota_timeout_ms', ${DEFAULT_TIMEOUT_MS})`),
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

function readBucketEntries(
  raw: RateLimitsResponse,
): Array<{ id: string; value: unknown }> {
  const buckets = raw.rateLimitsByLimitId;
  if (isRecord(buckets) && Object.keys(buckets).length > 0) {
    return Object.entries(buckets).map(([id, value]) => ({ id, value }));
  }
  if (raw.rateLimits === null || raw.rateLimits === undefined) {
    return [];
  }
  return [{ id: "rateLimits", value: raw.rateLimits }];
}

function mapBucket(value: unknown, fallbackId: string) {
  if (!isRecord(value)) {
    return { id: fallbackId, displayName: fallbackId, windows: [] };
  }

  const id = nonEmptyString(value.limitId) ?? fallbackId;
  const displayName = nonEmptyString(value.limitName) ?? id;
  const windows: QuotaWindow[] = [];
  for (const name of CODEX_WINDOWS) {
    if (!Object.hasOwn(value, name)) {
      continue;
    }
    const source = value[name];
    if (!isRecord(source)) {
      continue;
    }
    const window: QuotaWindow = { name };
    const usedPercent = nullableNumber(source, "usedPercent");
    const remainingPercent = nullableNumber(source, "remainingPercent");
    const durationMinutes = nullableNumber(source, "windowDurationMins");
    const resetsAtEpochSeconds = nullableNumber(source, "resetsAt");
    if (usedPercent !== undefined) {
      window.usedPercent = usedPercent;
    }
    if (remainingPercent !== undefined) {
      window.remainingPercent = remainingPercent;
    }
    if (durationMinutes !== undefined) {
      window.durationMinutes = durationMinutes;
    }
    if (resetsAtEpochSeconds !== undefined) {
      window.resetsAtEpochSeconds = resetsAtEpochSeconds;
    }
    windows.push(window);
  }
  return { id, displayName, windows };
}

function nullableNumber(
  source: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!Object.hasOwn(source, key)) {
    return undefined;
  }
  const value = source[key];
  return value === null
    ? null
    : typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
