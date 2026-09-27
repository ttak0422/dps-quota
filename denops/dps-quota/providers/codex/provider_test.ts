import { QuotaError } from "../../quota.ts";
import {
  createCodexProvider,
  mapCodexQuota,
  type RateLimitsReader,
} from "./provider.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  assert(
    actualText === expectedText,
    `${message}\nExpected: ${expectedText}\nActual: ${actualText}`,
  );
}

Deno.test("maps multiple Codex buckets, null and missing fields, and ignores unknown fields", () => {
  const snapshot = mapCodexQuota({
    rateLimits: { limitId: "legacy", primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      alpha: {
        limitId: "alpha",
        limitName: "Alpha",
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          windowDurationMins: 60,
          resetsAt: 1_730_947_200,
          futureField: "ignored",
        },
        secondary: { usedPercent: null, remainingPercent: null },
        tertiary: { usedPercent: 5 },
        futureBucketField: true,
      },
      beta: null,
      gamma: { limitName: null, secondary: {} },
    },
    futureResponseField: "not normalized",
  });

  assertEquals(snapshot, {
    provider: { id: "codex", displayName: "Codex" },
    buckets: [
      {
        id: "alpha",
        displayName: "Alpha",
        windows: [
          {
            name: "primary",
            usedPercent: 20,
            remainingPercent: 80,
            durationMinutes: 60,
            resetsAtEpochSeconds: 1_730_947_200,
          },
          {
            name: "secondary",
            usedPercent: null,
            remainingPercent: null,
          },
        ],
      },
      { id: "beta", displayName: "beta", windows: [] },
      {
        id: "gamma",
        displayName: "gamma",
        windows: [{ name: "secondary" }],
      },
    ],
  }, "normalizes only known Codex quota fields");
});

Deno.test("uses Codex legacy bucket when the bucket map is empty or null", () => {
  assertEquals(
    mapCodexQuota({
      rateLimits: {
        limitId: "legacy",
        primary: { usedPercent: 30, remainingPercent: 70 },
      },
      rateLimitsByLimitId: {},
    }).buckets,
    [{
      id: "legacy",
      displayName: "legacy",
      windows: [{ name: "primary", usedPercent: 30, remainingPercent: 70 }],
    }],
    "falls back to the legacy rateLimits value",
  );
  assertEquals(
    mapCodexQuota({ rateLimits: null, rateLimitsByLimitId: null }).buckets,
    [],
    "represents a null legacy bucket as no normalized buckets",
  );
});

Deno.test("Codex adapter owns legacy configuration and timeout validation", async () => {
  const expressions: string[] = [];
  const requested: unknown[] = [];
  const raw = { rateLimits: null };
  const read: RateLimitsReader = (options) => {
    requested.push(options);
    return Promise.resolve(raw);
  };
  const provider = createCodexProvider((expression) => {
    expressions.push(expression);
    return Promise.resolve(
      expression.includes("quota_codex_path") ? "/custom/codex" : 20_000,
    );
  }, read);

  const result = await provider.read();
  assertEquals(
    expressions,
    [
      "get(g:, 'quota_codex_path', 'codex')",
      "get(g:, 'quota_timeout_ms', 15000)",
    ],
    "reads only Codex adapter settings",
  );
  assertEquals(
    requested,
    [{ binary: "/custom/codex", timeoutMs: 20_000 }],
    "passes validated settings to the app-server transport",
  );
  assertEquals(result.raw, raw, "retains the provider-specific response");
  assertEquals(result.snapshot.buckets, [], "returns normalized quota data");
});

Deno.test("Codex adapter rejects invalid configuration before invoking transport", async () => {
  let transportCalled = false;
  const provider = createCodexProvider(
    (expression) =>
      Promise.resolve(expression.includes("quota_codex_path") ? " " : 2),
    () => {
      transportCalled = true;
      return Promise.resolve({ rateLimits: null });
    },
  );

  try {
    await provider.read();
    throw new Error("Expected invalid Codex configuration to reject");
  } catch (error) {
    assert(error instanceof QuotaError, "throws the common safe error type");
    assert(
      error.message.includes("quota_codex_path"),
      "identifies the invalid setting without exposing its value",
    );
  }
  assert(!transportCalled, "does not start transport with invalid settings");
});
