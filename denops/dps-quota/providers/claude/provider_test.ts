import {
  type ClaudeProviderDependencies,
  createClaudeProvider,
} from "./provider.ts";
import { QuotaError } from "../../quota.ts";

const NOW = Date.parse("2025-01-02T03:04:05.000Z");
const TOKEN = "synthetic-oauth-token-do-not-leak";

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

async function assertRejects(
  action: () => Promise<unknown>,
  messageFragment: string,
  forbiddenText: string[] = [],
): Promise<QuotaError> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof QuotaError, "rejects with the common safe error");
    assert(
      error.message.includes(messageFragment),
      `Unexpected error message: ${error.message}`,
    );
    for (const text of forbiddenText) {
      assert(!error.message.includes(text), `Leaks sensitive text: ${text}`);
    }
    return error;
  }
  throw new Error("Expected the operation to reject");
}

function validUsage(): Record<string, unknown> {
  return {
    five_hour: {
      utilization: 30,
      resets_at: "2025-01-02T08:00:00Z",
      provider_extension: "kept raw",
    },
    seven_day: null,
    seven_day_sonnet: {
      utilization: 101.25,
      resets_at: null,
    },
    seven_day_opus: {
      utilization: null,
      resets_at: null,
    },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2500,
      used_credits: 17,
    },
    future_field: { utilization: 99 },
  };
}

class ProviderFixture {
  readonly env = new Map<string, string>();
  readonly envReads: string[] = [];
  readonly fileReads: Array<{ path: string; maxBytes: number }> = [];
  readonly keychainReads: Array<{
    service: string;
    timeoutMs: number;
    maxBytes: number;
  }> = [];
  readonly expressions: string[] = [];
  readonly fetchCalls: Array<{ input: string; init: RequestInit }> = [];
  credentialFile: string | null = null;
  keychainDocument = JSON.stringify({
    claudeAiOauth: { accessToken: "synthetic-keychain-token" },
  });
  keychainEnabled: unknown = 0;
  keychainService: unknown = "Claude Code-credentials";
  timeoutMs: unknown = 15_000;
  fetcher: ClaudeProviderDependencies["fetch"] = () =>
    Promise.resolve(
      new Response(JSON.stringify(validUsage()), { status: 200 }),
    );

  readonly dependencies: Partial<ClaudeProviderDependencies> = {
    getEnv: (name) => {
      this.envReads.push(name);
      return this.env.get(name);
    },
    readCredentialFile: (path, maxBytes) => {
      this.fileReads.push({ path, maxBytes });
      return Promise.resolve(this.credentialFile);
    },
    readKeychain: (service, timeoutMs, maxBytes) => {
      this.keychainReads.push({ service, timeoutMs, maxBytes });
      return Promise.resolve(this.keychainDocument);
    },
    now: () => NOW,
    fetch: (input, init) => {
      this.fetchCalls.push({ input: String(input), init: init ?? {} });
      return this.fetcher(input, init);
    },
  };

  provider() {
    return createClaudeProvider((expression) => {
      this.expressions.push(expression);
      if (expression.includes("quota_timeout_ms")) {
        return Promise.resolve(this.timeoutMs);
      }
      if (expression.includes("quota_claude_keychain_service")) {
        return Promise.resolve(this.keychainService);
      }
      if (expression.includes("quota_claude_keychain")) {
        return Promise.resolve(this.keychainEnabled);
      }
      return Promise.reject(new Error("unexpected config expression"));
    }, this.dependencies);
  }
}

function trackTimers(
  fixture: ProviderFixture,
  fireDelayMs?: number,
): Array<{ delayMs: number; cleared: boolean }> {
  const timers: Array<{
    handle: ReturnType<typeof setTimeout>;
    delayMs: number;
    cleared: boolean;
  }> = [];
  fixture.dependencies.setTimer = (callback, delayMs) => {
    const handle = { id: timers.length } as unknown as ReturnType<
      typeof setTimeout
    >;
    timers.push({ handle, delayMs, cleared: false });
    if (delayMs === fireDelayMs) {
      queueMicrotask(callback);
    }
    return handle;
  };
  fixture.dependencies.clearTimer = (handle) => {
    const timer = timers.find((candidate) => candidate.handle === handle);
    if (timer !== undefined) {
      timer.cleared = true;
    }
  };
  return timers;
}

function credentialJson(token: string, expiresAt?: number): string {
  const oauth: Record<string, unknown> = { accessToken: token };
  if (expiresAt !== undefined) {
    oauth.expiresAt = expiresAt;
  }
  return JSON.stringify({ claudeAiOauth: oauth });
}

function responseWithTrackedCancellation(status: number): {
  response: Response;
  cancellationCount(): number;
} {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("private response body"));
    },
    cancel() {
      cancellations++;
    },
  });
  return {
    response: new Response(body, { status }),
    cancellationCount: () => cancellations,
  };
}

Deno.test("maps synthetic subscription windows and returns raw usage unchanged", async () => {
  const fixture = new ProviderFixture();
  fixture.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  const result = await fixture.provider().read();

  assertEquals(
    result.snapshot,
    {
      provider: { id: "claude", displayName: "Claude" },
      buckets: [{
        id: "subscription",
        displayName: "Subscription quota",
        windows: [
          {
            name: "five_hour",
            usedPercent: 30,
            remainingPercent: 70,
            durationMinutes: 300,
            resetsAtEpochSeconds: Date.parse("2025-01-02T08:00:00Z") / 1000,
          },
          {
            name: "seven_day_sonnet",
            usedPercent: 101.25,
            remainingPercent: -1.25,
            durationMinutes: 10_080,
            resetsAtEpochSeconds: null,
          },
          {
            name: "seven_day_opus",
            usedPercent: null,
            remainingPercent: null,
            durationMinutes: 10_080,
            resetsAtEpochSeconds: null,
          },
        ],
      }],
    },
    "maps recognized windows without clamping over-100 utilization",
  );
  assertEquals(result.raw, validUsage(), "preserves the complete raw response");
  assert(
    !JSON.stringify(result.snapshot).includes("extra_usage"),
    "does not label monetary extra-usage fields as subscription quota",
  );
  assert(
    !JSON.stringify(result.raw).includes(TOKEN),
    "does not add the token to the raw response",
  );

  const call = fixture.fetchCalls[0];
  assertEquals(
    call.input,
    "https://api.anthropic.com/api/oauth/usage",
    "uses the fixed Claude OAuth usage endpoint",
  );
  assertEquals(call.init.method, "GET", "uses GET");
  assertEquals(call.init.redirect, "error", "rejects redirects at fetch level");
  const headers = new Headers(call.init.headers);
  assertEquals(
    headers.get("Authorization"),
    `Bearer ${TOKEN}`,
    "sends bearer auth",
  );
  assertEquals(
    headers.get("anthropic-beta"),
    "oauth-2025-04-20",
    "sends the required beta header",
  );
  assert(call.init.signal instanceof AbortSignal, "passes a timeout signal");
});

Deno.test("prefers explicit and standard OAuth environment variables over files", async () => {
  const explicit = new ProviderFixture();
  explicit.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", " quota-specific-token ");
  explicit.env.set("CLAUDE_CODE_OAUTH_TOKEN", "standard-token");
  explicit.credentialFile = credentialJson("file-token");
  await explicit.provider().read();
  assertEquals(
    explicit.envReads,
    ["QUOTA_CLAUDE_OAUTH_TOKEN"],
    "stops after selecting the quota-specific token",
  );
  assertEquals(explicit.fileReads, [], "does not read a lower-priority file");
  assertEquals(explicit.keychainReads, [], "does not read Keychain");
  assertEquals(
    new Headers(explicit.fetchCalls[0].init.headers).get("Authorization"),
    "Bearer quota-specific-token",
    "trims surrounding environment whitespace before use",
  );

  const standard = new ProviderFixture();
  standard.env.set("CLAUDE_CODE_OAUTH_TOKEN", "standard-token");
  standard.credentialFile = credentialJson("file-token");
  await standard.provider().read();
  assertEquals(
    standard.envReads,
    ["QUOTA_CLAUDE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    "checks the standard token after the opt-in quota token is empty",
  );
  assertEquals(
    standard.fileReads,
    [],
    "standard token takes precedence over file",
  );
});

Deno.test("reads an existing credential file read-only and honors CLAUDE_CONFIG_DIR", async () => {
  const fixture = new ProviderFixture();
  fixture.env.set("CLAUDE_CONFIG_DIR", "/synthetic/custom-claude");
  fixture.env.set("HOME", "/synthetic/home");
  fixture.credentialFile = credentialJson("file-token", NOW + 60_000);
  await fixture.provider().read();

  assertEquals(
    fixture.fileReads,
    [{
      path: "/synthetic/custom-claude/.credentials.json",
      maxBytes: 256 * 1024,
    }],
    "reads only the selected Claude credentials file with a byte limit",
  );
  assertEquals(
    fixture.keychainReads,
    [],
    "does not read Keychain after file auth",
  );
  assertEquals(
    new Headers(fixture.fetchCalls[0].init.headers).get("Authorization"),
    "Bearer file-token",
    "uses the read-only OAuth access token",
  );
});

Deno.test("uses HOME fallback and does not expose expired credentials", async () => {
  const fixture = new ProviderFixture();
  fixture.env.set("HOME", "/synthetic/home");
  fixture.credentialFile = credentialJson("expired-file-token", NOW);
  const error = await assertRejects(
    () => fixture.provider().read(),
    "have expired",
    ["expired-file-token", "/synthetic/home"],
  );
  assert(
    error.message.includes("claude auth login"),
    "offers safe re-login guidance",
  );
  assertEquals(
    fixture.fileReads[0].path,
    "/synthetic/home/.claude/.credentials.json",
    "uses ~/.claude when CLAUDE_CONFIG_DIR is absent",
  );
  assertEquals(
    fixture.keychainReads,
    [],
    "does not fall back after expired file auth",
  );
  assertEquals(fixture.fetchCalls, [], "does not send an expired token");
});

Deno.test("requires credentials and leaves Keychain disabled by default", async () => {
  const fixture = new ProviderFixture();
  const error = await assertRejects(
    () => fixture.provider().read(),
    "No Claude OAuth token is available",
  );
  assert(!error.message.includes(TOKEN), "does not expose token text");
  assertEquals(
    fixture.keychainReads,
    [],
    "does not invoke Keychain by default",
  );
  assertEquals(
    fixture.fetchCalls,
    [],
    "does not make an unauthenticated request",
  );
  assert(
    fixture.expressions.includes("get(g:, 'quota_claude_keychain', 0)"),
    "reads the explicit Keychain opt-in after environment and file lookup",
  );
});

Deno.test("uses Keychain only after file lookup and only with explicit opt-in", async () => {
  const fixture = new ProviderFixture();
  fixture.keychainEnabled = 1;
  fixture.keychainService = "custom Claude config service";
  fixture.keychainDocument = credentialJson("keychain-token", NOW + 10_000);
  const result = await fixture.provider().read();

  assertEquals(
    fixture.keychainReads,
    [{
      service: "custom Claude config service",
      timeoutMs: 15_000,
      maxBytes: 256 * 1024,
    }],
    "uses the configured service, bounded by the common timeout and size limit",
  );
  assertEquals(
    result.raw,
    validUsage(),
    "returns only the server's quota response, not Keychain credentials",
  );
  assert(
    fixture.expressions.includes(
      "get(g:, 'quota_claude_keychain_service', 'Claude Code-credentials')",
    ),
    "supports a custom Keychain service name",
  );
});

Deno.test("environment and file credentials suppress Keychain configuration and access", async () => {
  const envFixture = new ProviderFixture();
  envFixture.env.set("CLAUDE_CODE_OAUTH_TOKEN", "env-token");
  envFixture.keychainEnabled = 1;
  await envFixture.provider().read();
  assertEquals(
    envFixture.keychainReads,
    [],
    "does not touch Keychain for env auth",
  );
  assert(
    !envFixture.expressions.some((expression) =>
      expression.includes("quota_claude_keychain")
    ),
    "does not even inspect opt-in settings when environment auth is selected",
  );

  const fileFixture = new ProviderFixture();
  fileFixture.env.set("HOME", "/synthetic/home");
  fileFixture.credentialFile = credentialJson("file-token");
  fileFixture.keychainEnabled = 1;
  await fileFixture.provider().read();
  assertEquals(
    fileFixture.keychainReads,
    [],
    "does not touch Keychain for file auth",
  );
});

Deno.test("rejects unrecognized and malformed response shapes without exposing bodies", async () => {
  const cases: Array<{ value: unknown; message: string }> = [
    {
      value: { error: { message: "private server detail" } },
      message: "unrecognized",
    },
    { value: { extra_usage: { monthly_limit: 123 } }, message: "unrecognized" },
    {
      value: { five_hour: { message: "private server detail" } },
      message: "incomplete",
    },
    {
      value: { seven_day: { utilization: -1, resets_at: null } },
      message: "invalid utilization",
    },
    {
      value: { seven_day: { utilization: 1, resets_at: "not-a-date" } },
      message: "invalid reset timestamp",
    },
  ];

  for (const testCase of cases) {
    const fixture = new ProviderFixture();
    fixture.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
    fixture.fetcher = () =>
      Promise.resolve(
        new Response(JSON.stringify(testCase.value), { status: 200 }),
      );
    await assertRejects(
      () => fixture.provider().read(),
      testCase.message,
      ["private server detail", TOKEN],
    );
  }

  const malformedJson = new ProviderFixture();
  malformedJson.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  malformedJson.fetcher = () =>
    Promise.resolve(
      new Response('{"five_hour": "private server detail"', { status: 200 }),
    );
  await assertRejects(
    () => malformedJson.provider().read(),
    "malformed JSON",
    ["private server detail", TOKEN],
  );
});

Deno.test("handles safe HTTP errors without reading or exposing server bodies", async () => {
  const cases = [
    { status: 401, message: "HTTP 401" },
    { status: 403, message: "HTTP 403" },
    { status: 429, message: "HTTP 429" },
    { status: 503, message: "HTTP 503" },
    { status: 400, message: "HTTP 400" },
  ];
  for (const testCase of cases) {
    const fixture = new ProviderFixture();
    fixture.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
    fixture.fetcher = () =>
      Promise.resolve(
        new Response("private HTTP response body", { status: testCase.status }),
      );
    await assertRejects(
      () => fixture.provider().read(),
      testCase.message,
      ["private HTTP response body", TOKEN],
    );
  }
});

Deno.test("cancels unauthorized and rate-limited response bodies on failure", async () => {
  for (const status of [401, 429]) {
    const fixture = new ProviderFixture();
    const timers = trackTimers(fixture);
    fixture.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
    const tracked = responseWithTrackedCancellation(status);
    fixture.fetcher = () => Promise.resolve(tracked.response);

    await assertRejects(
      () => fixture.provider().read(),
      `HTTP ${status}`,
      ["private response body", TOKEN],
    );
    assertEquals(
      tracked.cancellationCount(),
      1,
      `cancels the HTTP ${status} body without consuming it`,
    );
    assert(
      fixture.fetchCalls[0].init.signal?.aborted,
      `aborts the HTTP ${status} request signal after failure`,
    );
    assertEquals(
      timers.map(({ delayMs, cleared }) => ({ delayMs, cleared })),
      [
        { delayMs: 15_000, cleared: true },
        { delayMs: 250, cleared: true },
      ],
      `clears request and bounded body-cleanup timers for HTTP ${status}`,
    );
  }
});

Deno.test("bounds error-body cleanup without replacing the original HTTP error", async () => {
  const fixture = new ProviderFixture();
  const timers = trackTimers(fixture, 250);
  fixture.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  fixture.fetcher = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("private response body"),
            );
          },
          cancel: () => new Promise(() => undefined),
        }),
        { status: 401 },
      ),
    );

  await assertRejects(
    () => fixture.provider().read(),
    "HTTP 401",
    ["private response body", TOKEN],
  );
  assertEquals(
    timers.map(({ delayMs, cleared }) => ({ delayMs, cleared })),
    [
      { delayMs: 15_000, cleared: true },
      { delayMs: 250, cleared: true },
    ],
    "bounds cancellation and clears both timers",
  );
});

Deno.test("aborts and clears the request timer after fetch and body errors", async () => {
  const fetchFailure = new ProviderFixture();
  const fetchTimers = trackTimers(fetchFailure);
  fetchFailure.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  fetchFailure.fetcher = () => Promise.reject(new Error(`private: ${TOKEN}`));
  await assertRejects(
    () => fetchFailure.provider().read(),
    "request failed or was redirected",
    [TOKEN, "private"],
  );
  assert(
    fetchFailure.fetchCalls[0].init.signal?.aborted,
    "aborts the request after a fetch failure",
  );
  assertEquals(
    fetchTimers.map(({ cleared }) => cleared),
    [true],
    "clears the timer after a fetch failure",
  );

  const bodyFailure = new ProviderFixture();
  const bodyTimers = trackTimers(bodyFailure);
  bodyFailure.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  bodyFailure.fetcher = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(`private body failure: ${TOKEN}`));
          },
        }),
        { status: 200 },
      ),
    );
  await assertRejects(
    () => bodyFailure.provider().read(),
    "Could not read the Claude quota response",
    [TOKEN, "private body failure"],
  );
  assert(
    bodyFailure.fetchCalls[0].init.signal?.aborted,
    "aborts the request after a body-read failure",
  );
  assertEquals(
    bodyTimers.map(({ cleared }) => cleared),
    [true],
    "clears the timer after a body-read failure",
  );
});

Deno.test("rejects redirect responses and safely handles fetch errors", async () => {
  const redirect = new ProviderFixture();
  redirect.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  redirect.fetcher = () =>
    Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.test" },
      }),
    );
  await assertRejects(
    () => redirect.provider().read(),
    "unexpected redirect",
    [TOKEN],
  );
  assertEquals(
    redirect.fetchCalls[0].init.redirect,
    "error",
    "never follows a redirect with the bearer token",
  );

  const network = new ProviderFixture();
  network.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  network.fetcher = () => Promise.reject(new Error(`private: ${TOKEN}`));
  await assertRejects(
    () => network.provider().read(),
    "request failed or was redirected",
    [TOKEN, "private"],
  );
});

Deno.test("applies the shared timeout to fetch and response-body reads", async () => {
  const requestTimeout = new ProviderFixture();
  requestTimeout.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  requestTimeout.timeoutMs = 100;
  requestTimeout.fetcher = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("private abort detail", "AbortError"));
      }, { once: true });
    });
  await assertRejects(
    () => requestTimeout.provider().read(),
    "timed out after 100 ms",
    [TOKEN, "private abort detail"],
  );
  assert(
    requestTimeout.fetchCalls[0].init.signal?.aborted,
    "aborts the request",
  );

  const bodyTimeout = new ProviderFixture();
  bodyTimeout.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  bodyTimeout.timeoutMs = 100;
  bodyTimeout.fetcher = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => undefined),
        }),
        { status: 200 },
      ),
    );
  await assertRejects(
    () => bodyTimeout.provider().read(),
    "timed out after 100 ms",
    [TOKEN],
  );
});

Deno.test("bounds response payloads and validates timeout configuration", async () => {
  const oversized = new ProviderFixture();
  oversized.env.set("QUOTA_CLAUDE_OAUTH_TOKEN", TOKEN);
  oversized.fetcher = () =>
    Promise.resolve(new Response(" ".repeat(1_048_577), { status: 200 }));
  await assertRejects(
    () => oversized.provider().read(),
    "exceeds the size limit",
    [TOKEN],
  );

  const invalidTimeout = new ProviderFixture();
  invalidTimeout.timeoutMs = 99;
  await assertRejects(
    () => invalidTimeout.provider().read(),
    "g:quota_timeout_ms must be an integer",
  );
});

Deno.test("validates explicit Keychain opt-in and service configuration", async () => {
  const invalidOptIn = new ProviderFixture();
  invalidOptIn.keychainEnabled = "1";
  await assertRejects(
    () => invalidOptIn.provider().read(),
    "g:quota_claude_keychain must be 0 or 1",
  );
  assertEquals(
    invalidOptIn.keychainReads,
    [],
    "rejects before invoking Keychain",
  );

  const invalidService = new ProviderFixture();
  invalidService.keychainEnabled = 1;
  invalidService.keychainService = "";
  await assertRejects(
    () => invalidService.provider().read(),
    "g:quota_claude_keychain_service must be a non-empty",
  );
  assertEquals(
    invalidService.keychainReads,
    [],
    "does not execute invalid service input",
  );
});
