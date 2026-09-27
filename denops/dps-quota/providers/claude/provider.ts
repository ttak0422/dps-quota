import {
  type ClaudeCredentialDependencies,
  MAX_CREDENTIAL_BYTES,
  parseClaudeCredentialDocument,
  readBoundedCredentialFile,
  readMacOSKeychainCredential,
  readTokenFromEnvironmentOrFile,
} from "./credentials.ts";
import {
  QuotaError,
  type QuotaProvider,
  type QuotaReadResult,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../../quota.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_USAGE_RESPONSE_BYTES = 1_048_576;
const RESPONSE_BODY_CLEANUP_TIMEOUT_MS = 250;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USAGE_BETA = "oauth-2025-04-20";
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

export type ClaudeConfigEvaluator = (expression: string) => Promise<unknown>;
export type ClaudeFetcher = typeof fetch;

export interface ClaudeProviderDependencies
  extends ClaudeCredentialDependencies {
  fetch: ClaudeFetcher;
  setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export function createClaudeProvider(
  evaluate: ClaudeConfigEvaluator,
  injected: Partial<ClaudeProviderDependencies> = {},
): QuotaProvider {
  const dependencies: ClaudeProviderDependencies = {
    getEnv: (name) => Deno.env.get(name),
    readCredentialFile: readBoundedCredentialFile,
    readKeychain: readMacOSKeychainCredential,
    now: () => Date.now(),
    fetch,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle),
    ...injected,
  };

  return {
    id: "claude",
    displayName: "Claude",
    async read(): Promise<QuotaReadResult> {
      const timeoutMs = await readTimeout(evaluate);
      let token = await readTokenFromEnvironmentOrFile(dependencies);
      if (token === null) {
        const keychain = await readKeychainOptions(evaluate);
        if (keychain.enabled) {
          const credentialJson = await dependencies.readKeychain(
            keychain.service,
            timeoutMs,
            MAX_CREDENTIAL_BYTES,
          );
          token = parseClaudeCredentialDocument(
            credentialJson,
            dependencies.now(),
          );
        }
      }
      if (token === null) {
        throw new QuotaError(
          "No Claude OAuth token is available. Set a Claude quota token or sign in with `claude auth login`.",
        );
      }

      const raw = await readClaudeUsage(
        dependencies.fetch,
        token,
        timeoutMs,
        dependencies.setTimer,
        dependencies.clearTimer,
      );
      return { snapshot: mapClaudeQuota(raw), raw };
    },
  };
}

function mapClaudeQuota(raw: Record<string, unknown>): QuotaSnapshot {
  const windows: QuotaWindow[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isClaudeWindowName(name) || value === null) {
      continue;
    }
    const window = value as Record<string, unknown>;
    const usedPercent = window.utilization as number | null;
    const resetsAt = window.resets_at as string | null;
    windows.push({
      name,
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      durationMinutes: durationMinutes(name),
      resetsAtEpochSeconds: resetsAt === null
        ? null
        : Date.parse(resetsAt) / 1000,
    });
  }

  return {
    provider: { id: "claude", displayName: "Claude" },
    buckets: [{
      id: "subscription",
      displayName: "Subscription quota",
      windows,
    }],
  };
}

async function readTimeout(
  evaluate: ClaudeConfigEvaluator,
): Promise<number> {
  let value: unknown;
  try {
    value = await evaluate(
      `get(g:, 'quota_timeout_ms', ${DEFAULT_TIMEOUT_MS})`,
    );
  } catch {
    throw new QuotaError("Could not read g:quota_timeout_ms.");
  }
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 100 ||
    value > 120_000
  ) {
    throw new QuotaError(
      "g:quota_timeout_ms must be an integer from 100 to 120000.",
    );
  }
  return value;
}

async function readKeychainOptions(
  evaluate: ClaudeConfigEvaluator,
): Promise<{ enabled: boolean; service: string }> {
  let enabled: unknown;
  try {
    enabled = await evaluate("get(g:, 'quota_claude_keychain', 0)");
  } catch {
    throw new QuotaError("Could not read g:quota_claude_keychain.");
  }
  if (enabled !== 0 && enabled !== 1) {
    throw new QuotaError("g:quota_claude_keychain must be 0 or 1.");
  }
  if (enabled === 0) {
    return { enabled: false, service: DEFAULT_KEYCHAIN_SERVICE };
  }

  let service: unknown;
  try {
    service = await evaluate(
      `get(g:, 'quota_claude_keychain_service', '${DEFAULT_KEYCHAIN_SERVICE}')`,
    );
  } catch {
    throw new QuotaError("Could not read g:quota_claude_keychain_service.");
  }
  if (
    typeof service !== "string" || service.trim() === "" ||
    service.length > 256 || service.includes("\0")
  ) {
    throw new QuotaError(
      "g:quota_claude_keychain_service must be a non-empty service name.",
    );
  }
  return { enabled: true, service };
}

async function readClaudeUsage(
  fetcher: ClaudeFetcher,
  token: string,
  timeoutMs: number,
  setTimer: ClaudeProviderDependencies["setTimer"],
  clearTimer: ClaudeProviderDependencies["clearTimer"],
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let responseForCleanup: Response | undefined;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimer(() => {
      timedOut = true;
      controller.abort();
      reject(
        new QuotaError(
          `Claude quota request timed out after ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
  });

  const request = async (): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetcher(USAGE_ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": USAGE_BETA,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new QuotaError(
        "Claude quota request failed or was redirected. Check denops network permission for api.anthropic.com.",
      );
    }
    responseForCleanup = response;

    if (response.status >= 300 && response.status < 400) {
      throw new QuotaError(
        "Claude quota endpoint returned an unexpected redirect; credentials were not forwarded.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new QuotaError(
        `Claude quota request was unauthorized (HTTP ${response.status}). Run ` +
          "`claude auth login` and retry.",
      );
    }
    if (response.status === 429) {
      throw new QuotaError(
        "Claude quota service is rate limiting requests (HTTP 429). Try again later.",
      );
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new QuotaError(
        `Claude quota service returned a server error (HTTP ${response.status}). Try again later.`,
      );
    }
    if (!response.ok) {
      throw new QuotaError(
        `Claude quota request failed (HTTP ${response.status}).`,
      );
    }

    const content = await readBoundedResponse(
      response.body,
      timeout,
      MAX_USAGE_RESPONSE_BYTES,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new QuotaError("Claude quota endpoint returned malformed JSON.");
    }
    return validateClaudeUsage(raw);
  };

  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (timedOut) {
      throw new QuotaError(
        `Claude quota request timed out after ${timeoutMs} ms.`,
      );
    }
    if (error instanceof QuotaError) {
      throw error;
    }
    throw new QuotaError(
      "Could not read the Claude quota response.",
    );
  } finally {
    if (timeoutId !== undefined) {
      try {
        clearTimer(timeoutId);
      } catch {
        // Cleanup must not replace a safe provider error.
      }
    }
    try {
      controller.abort();
    } catch {
      // Cleanup must not replace a safe provider error.
    }
    await cancelUnreadResponseBody(responseForCleanup, setTimer, clearTimer);
  }
}

async function cancelUnreadResponseBody(
  response: Response | undefined,
  setTimer: ClaudeProviderDependencies["setTimer"],
  clearTimer: ClaudeProviderDependencies["clearTimer"],
): Promise<void> {
  if (response === undefined) {
    return;
  }
  const body = response.body;
  if (body === null || body.locked || response.bodyUsed) {
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body.cancel(),
      new Promise<void>((resolve) => {
        timeoutId = setTimer(resolve, RESPONSE_BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Keep the original fetch, HTTP, or parsing error; cancellation is best effort.
  } finally {
    if (timeoutId !== undefined) {
      try {
        clearTimer(timeoutId);
      } catch {
        // Cleanup must not replace a safe provider error.
      }
    }
  }
}

async function readBoundedResponse(
  body: ReadableStream<Uint8Array> | null,
  timeout: Promise<never>,
  maxBytes: number,
): Promise<string> {
  if (body === null) {
    throw new QuotaError("Claude quota endpoint returned an empty response.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maxBytes) {
        throw new QuotaError("Claude quota response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A timed-out stream may already have released its reader.
    }
  }

  if (length === 0) {
    throw new QuotaError("Claude quota endpoint returned an empty response.");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QuotaError("Claude quota endpoint returned invalid UTF-8.");
  }
}

function validateClaudeUsage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new QuotaError("Claude quota endpoint returned an invalid response.");
  }
  const windowNames = Object.keys(value).filter(isClaudeWindowName);
  if (windowNames.length === 0) {
    throw new QuotaError(
      "Claude quota endpoint returned an unrecognized response.",
    );
  }

  for (const name of windowNames) {
    const window = value[name];
    if (window === null) {
      continue;
    }
    if (!isRecord(window)) {
      throw new QuotaError(
        "Claude quota endpoint returned an invalid quota window.",
      );
    }
    if (
      !Object.hasOwn(window, "utilization") ||
      !Object.hasOwn(window, "resets_at")
    ) {
      throw new QuotaError(
        "Claude quota endpoint returned an incomplete quota window.",
      );
    }
    const utilization = window.utilization;
    if (
      utilization !== null &&
      (typeof utilization !== "number" || !Number.isFinite(utilization) ||
        utilization < 0)
    ) {
      throw new QuotaError(
        "Claude quota endpoint returned an invalid utilization percentage.",
      );
    }
    const resetsAt = window.resets_at;
    if (
      resetsAt !== null &&
      (typeof resetsAt !== "string" || !isISODate(resetsAt))
    ) {
      throw new QuotaError(
        "Claude quota endpoint returned an invalid reset timestamp.",
      );
    }
  }
  return value;
}

function isClaudeWindowName(name: string): boolean {
  return name === "five_hour" || name === "seven_day" ||
    (name.startsWith("seven_day_") && name.length > "seven_day_".length);
}

function durationMinutes(name: string): number {
  return name === "five_hour" ? 300 : 10_080;
}

function isISODate(value: string): boolean {
  const match =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/
      .exec(
        value,
      );
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : [4, 6, 9, 11].includes(month)
    ? 30
    : 31;
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 ||
    minute > 59 || second > 59
  ) {
    return false;
  }
  if (match[8] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
