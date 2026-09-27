import { createDispatcher, type DispatcherHost } from "./dispatcher.ts";
import { formatQuota } from "./formatter.ts";
import {
  QuotaError,
  type QuotaProvider,
  type QuotaReadResult,
  type QuotaSnapshot,
} from "./quota.ts";

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

class FakeHost implements DispatcherHost {
  readonly evaluations: string[] = [];
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly commands: string[] = [];
  configuredProvider: unknown = "";

  eval(expression: string): Promise<unknown> {
    this.evaluations.push(expression);
    return Promise.resolve(
      expression.includes("quota_provider") ? this.configuredProvider : null,
    );
  }

  call(functionName: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push([functionName, ...args]);
    return Promise.resolve(
      functionName === "string" ? JSON.stringify(args[0]) : null,
    );
  }

  cmd(command: string): Promise<void> {
    this.commands.push(command);
    return Promise.resolve();
  }
}

function makeSnapshot(
  providerId: string,
  displayName = providerId,
): QuotaSnapshot {
  return {
    provider: { id: providerId, displayName },
    buckets: [{
      id: "account",
      displayName: "Account",
      windows: [
        {
          name: "rolling-hour",
          usedPercent: 25,
          remainingPercent: 75,
          durationMinutes: 60,
          resetsAtEpochSeconds: 1_730_947_200,
        },
        { name: "monthly", usedPercent: null, remainingPercent: null },
        { name: "future-window" },
      ],
    }],
  };
}

function makeResult(providerId: string): QuotaReadResult {
  return {
    snapshot: makeSnapshot(providerId),
    raw: {
      rateLimits: {
        limitId: providerId,
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
          windowDurationMins: 60,
        },
      },
      rateLimitsByLimitId: {},
    },
  };
}

function makeProvider(
  id: string,
  onRead: () => Promise<QuotaReadResult> = () =>
    Promise.resolve(makeResult(id)),
): QuotaProvider {
  return { id, displayName: id, read: onRead };
}

function providers(
  ...entries: QuotaProvider[]
): ReadonlyMap<string, QuotaProvider> {
  return new Map(entries.map((provider) => [provider.id, provider]));
}

async function assertRejects(
  action: () => Promise<unknown>,
  messageFragment: string,
): Promise<QuotaError> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof QuotaError, "rejects with the common safe error");
    assert(
      error.message.includes(messageFragment),
      `Unexpected error message: ${error.message}`,
    );
    return error;
  }
  throw new Error("Expected the operation to reject");
}

Deno.test("get preserves the raw provider response for the legacy API", async () => {
  const host = new FakeHost();
  const result = makeResult("fake");
  const dispatcher = createDispatcher(
    host,
    providers(makeProvider("fake", () => Promise.resolve(result))),
    "fake",
  );

  const raw = await dispatcher.get();
  assertEquals(raw, result.raw, "returns the legacy raw response unchanged");
  assertEquals(
    Object.keys(raw),
    ["rateLimits", "rateLimitsByLimitId"],
    "keeps the rateLimits response shape",
  );
  assertEquals(
    (raw.rateLimits as Record<string, unknown>).primary,
    {
      usedPercent: 25,
      remainingPercent: 75,
      windowDurationMins: 60,
    },
    "retains Codex's derived remaining percentage in the raw result",
  );
});

Deno.test("getQuota returns the provider-neutral normalized snapshot", async () => {
  const host = new FakeHost();
  const expected = makeSnapshot("fake", "A Fake Provider");
  const dispatcher = createDispatcher(
    host,
    providers(
      makeProvider(
        "fake",
        () => Promise.resolve({ snapshot: expected, raw: {} }),
      ),
    ),
    "fake",
  );

  assertEquals(
    await dispatcher.getQuota(),
    expected,
    "returns the normalized provider snapshot",
  );
});

Deno.test("uses the injected default when no provider setting or argument is supplied", async () => {
  const host = new FakeHost();
  const reads: string[] = [];
  const registry = providers(
    makeProvider("fake", () => {
      reads.push("fake");
      return Promise.resolve(makeResult("fake"));
    }),
    makeProvider("other", () => {
      reads.push("other");
      return Promise.resolve(makeResult("other"));
    }),
  );
  const dispatcher = createDispatcher(host, registry, "fake");

  await dispatcher.get();
  assertEquals(reads, ["fake"], "uses the composed default provider");
  assertEquals(
    host.evaluations,
    ["get(g:, 'quota_provider', '')"],
    "reads only the generic provider selection setting",
  );
  assert(
    !host.evaluations.some((expression) => expression.includes("quota_codex")),
    "does not read Codex-specific configuration in the dispatcher",
  );
});

Deno.test("honors g:quota_provider and lets an explicit provider argument override it", async () => {
  const host = new FakeHost();
  host.configuredProvider = "other";
  const reads: string[] = [];
  const dispatcher = createDispatcher(
    host,
    providers(
      makeProvider("fake", () => {
        reads.push("fake");
        return Promise.resolve(makeResult("fake"));
      }),
      makeProvider("other", () => {
        reads.push("other");
        return Promise.resolve(makeResult("other"));
      }),
    ),
    "fake",
  );

  await dispatcher.get();
  await dispatcher.get("fake");
  assertEquals(
    reads,
    ["other", "fake"],
    "uses the configured provider by default and explicit argument on request",
  );
});

Deno.test("injected non-Codex provider displays arbitrary windows without Codex configuration", async () => {
  const host = new FakeHost();
  const fakeSnapshot = makeSnapshot("independent", "Independent");
  const dispatcher = createDispatcher(
    host,
    providers(
      makeProvider(
        "independent",
        () => Promise.resolve({ snapshot: fakeSnapshot, raw: { own: "raw" } }),
      ),
    ),
    "independent",
  );

  await dispatcher.Quota();
  const output = host.commands.join("\n");
  assert(
    output.includes("Independent usage quota"),
    "prints provider metadata",
  );
  assert(
    output.includes("rolling-hour: 75% remaining, 25% used"),
    "formats a named window",
  );
  assert(output.includes("60 min window"), "formats duration in minutes");
  assert(
    output.includes("monthly: remaining unavailable, used unavailable"),
    "formats nullable percentages",
  );
  assert(
    output.includes("future-window: available"),
    "formats missing metrics",
  );
  assert(
    !host.evaluations.some((expression) => expression.includes("quota_codex")),
    "never reads Codex configuration for an injected provider",
  );
  assert(
    !host.evaluations.some((expression) =>
      expression.includes("quota_timeout_ms")
    ),
    "does not impose Codex timeout configuration on another provider",
  );
});

Deno.test("formatter handles arbitrary buckets and window names", () => {
  const formatted = formatQuota({
    provider: { id: "test", displayName: "Test Provider" },
    buckets: [
      {
        id: "one",
        displayName: "First\nBucket",
        windows: [
          { name: "short", remainingPercent: 81, durationMinutes: 37 },
          {
            name: "long",
            usedPercent: 60,
            resetsAtEpochSeconds: 1_730_947_200,
          },
          { name: "not-available", usedPercent: null },
        ],
      },
      { id: "two", displayName: "Second", windows: [] },
    ],
  });

  assert(formatted.includes("First Bucket:"), "sanitizes bucket labels");
  assert(
    formatted.includes("short: 81% remaining, 37 min window"),
    "does not assume a fixed window length",
  );
  assert(
    formatted.includes("long: 60% used, resets at 2024-11-07T02:40:00.000Z"),
    "formats reset epoch seconds",
  );
  assert(
    formatted.includes("not-available: used unavailable"),
    "formats nullable metrics",
  );
  assert(
    formatted.includes("no quota windows"),
    "handles buckets with no windows",
  );
});

Deno.test("rejects invalid argument count and provider argument types", async () => {
  const host = new FakeHost();
  const dispatcher = createDispatcher(
    host,
    providers(makeProvider("fake")),
    "fake",
  );

  await assertRejects(
    () => dispatcher.get("fake", "other"),
    "no arguments or one",
  );
  await assertRejects(() => dispatcher.get(1), "non-empty string");
  await assertRejects(() => dispatcher.getQuota(null), "non-empty string");
  assertEquals(
    host.evaluations,
    [],
    "does not read configuration for invalid explicit arguments",
  );
});

Deno.test("unknown providers fail safely without invoking any provider", async () => {
  const host = new FakeHost();
  let reads = 0;
  const dispatcher = createDispatcher(
    host,
    providers(makeProvider("fake", () => {
      reads++;
      return Promise.resolve(makeResult("fake"));
    })),
    "fake",
  );

  const error = await assertRejects(
    () => dispatcher.get("secret-provider-value"),
    "Unknown quota provider",
  );
  assert(
    !error.message.includes("secret-provider-value"),
    "does not echo unknown input",
  );
  await dispatcher.Quota("secret-provider-value");
  assertEquals(reads, 0, "never fetches through an unknown provider");
  assert(
    host.commands.join("\n").includes("Unknown quota provider"),
    "reports a sanitized command error",
  );
});

Deno.test("sanitizes unexpected provider failures and preserves common safe errors", async () => {
  const host = new FakeHost();
  const failed = createDispatcher(
    host,
    providers(
      makeProvider(
        "fake",
        () => Promise.reject(new Error("private-token-must-not-be-shown")),
      ),
    ),
    "fake",
  );

  await failed.Quota();
  const message = host.commands.join("\n");
  assert(
    message.includes("Could not read usage quotas"),
    "shows generic guidance",
  );
  assert(
    !message.includes("private-token"),
    "hides unexpected provider details",
  );

  const safe = createDispatcher(
    host,
    providers(
      makeProvider(
        "fake",
        () => Promise.reject(new QuotaError("Provider sign-in is required.")),
      ),
    ),
    "fake",
  );
  await safe.Quota();
  assert(
    host.commands.join("\n").includes("Provider sign-in is required"),
    "preserves safe provider guidance",
  );
});
