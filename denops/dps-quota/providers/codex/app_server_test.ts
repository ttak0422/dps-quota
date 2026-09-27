import {
  type AppServerOptions,
  type RateLimitsResponse,
  readRateLimits,
} from "./app_server.ts";
import { QuotaError } from "../../quota.ts";

const encoder = new TextEncoder();
const options: AppServerOptions = { binary: "codex", timeoutMs: 1_000 };

interface Message {
  [key: string]: unknown;
}

class FakeChild {
  readonly messages: Message[] = [];
  killSignals: Deno.Signal[] = [];
  reaped = false;
  ignoreTerminate = false;
  private output!: ReadableStreamDefaultController<Uint8Array>;
  private resolveStatus!: (status: Deno.CommandStatus) => void;

  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.output = controller;
    },
  });
  readonly stdin = new WritableStream<Uint8Array>({
    write: (chunk) => this.receive(chunk),
  });
  readonly status = new Promise<Deno.CommandStatus>((resolve) => {
    this.resolveStatus = resolve;
  });

  constructor(
    private readonly onMessage?: (
      message: Message,
      child: FakeChild,
    ) => void | Promise<void>,
  ) {}

  kill(signal: Deno.Signal = "SIGTERM"): void {
    this.killSignals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerminate) {
      return;
    }
    this.exit();
  }

  send(message: Message | string): void {
    const line = typeof message === "string"
      ? message
      : JSON.stringify(message);
    this.sendBytes(encoder.encode(`${line}\n`));
  }

  sendBytes(bytes: Uint8Array): void {
    this.output.enqueue(bytes);
  }

  exit(): void {
    if (this.reaped) {
      return;
    }
    this.reaped = true;
    try {
      this.output.close();
    } catch {
      // The stream may already be closed by a test fixture.
    }
    this.resolveStatus({ success: true, code: 0, signal: null });
  }

  private receive(chunk: Uint8Array): void {
    const message = JSON.parse(new TextDecoder().decode(chunk)) as Message;
    this.messages.push(message);
    const pending = this.onMessage?.(message, this);
    if (pending instanceof Promise) {
      void pending.catch(() => undefined);
    }
  }
}

function successfulChild(result: RateLimitsResponse): FakeChild {
  return new FakeChild((message, child) => {
    if (message.method === "initialize") {
      child.send({ method: "server/notice", params: { ignored: true } });
      child.send({ id: 99, result: { ignored: true } });
      child.send({ id: 1, result: { userAgent: "fixture" } });
    } else if (message.method === "account/rateLimits/read") {
      child.send({ method: "account/rateLimits/updated", params: {} });
      child.send({ id: 2, result });
    }
  });
}

function sampleResult(): RateLimitsResponse {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 25,
        windowDurationMins: 15,
        resetsAt: 1_730_947_200,
        futureWindowValue: "preserved",
      },
      secondary: null,
      planType: null,
      credits: null,
      futureBucketValue: true,
    },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 42, windowDurationMins: 60 },
        secondary: null,
      },
      codex_other: null,
    },
    futureResponseValue: { keep: true },
  };
}

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
  expectedText: string,
): Promise<QuotaError> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof QuotaError, "Expected a sanitized QuotaError");
    assert(
      error.message.includes(expectedText),
      `Unexpected message: ${error.message}`,
    );
    return error;
  }
  throw new Error("Expected the operation to reject");
}

Deno.test("uses app-server initialize/read protocol and enriches all quota windows", async () => {
  const child = successfulChild(sampleResult());
  const response = await readRateLimits(options, (binary) => {
    assertEquals(binary, "codex", "uses the configured executable");
    return child;
  });

  assertEquals(
    child.messages,
    [
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "dps_quota",
            version: "0.1.0",
            title: "dps-quota",
          },
        },
      },
      { method: "initialized", params: {} },
      { method: "account/rateLimits/read", id: 2, params: {} },
    ],
    "sends only the required protocol messages in order",
  );
  const mainBucket = response.rateLimits as Record<string, unknown>;
  const primary = mainBucket.primary as Record<string, unknown>;
  assertEquals(primary.remainingPercent, 75, "derives remaining percent");
  assertEquals(
    primary.futureWindowValue,
    "preserved",
    "preserves unknown window values",
  );
  assertEquals(mainBucket.secondary, null, "preserves a null window");
  assertEquals(mainBucket.planType, null, "preserves unknown null values");
  assertEquals(
    mainBucket.futureBucketValue,
    true,
    "preserves unknown bucket values",
  );
  assertEquals(
    response.futureResponseValue,
    { keep: true },
    "preserves future response fields",
  );
  const buckets = response.rateLimitsByLimitId as Record<string, unknown>;
  const other = buckets.codex_other as Record<string, unknown> | null;
  assertEquals(other, null, "preserves null bucket values");
  assertEquals(
    child.killSignals.length,
    1,
    "terminates the app-server process",
  );
  assert(child.reaped, "waits for the app-server process to exit");
});

Deno.test("keeps coalesced lines buffered across protocol response phases", async () => {
  const result = {
    rateLimits: {
      primary: { usedPercent: 12 },
      secondary: null,
    },
  };
  const child = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      // Prequeue the next correlated line to exercise one read containing both phases.
      const coalesced = [
        { id: 1, result: { userAgent: "fixture" } },
        { id: 2, result },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      server.sendBytes(encoder.encode(coalesced));
    }
  });

  const response = await readRateLimits(
    { ...options, timeoutMs: 100 },
    () => child,
  );
  const primary = (response.rateLimits as Record<string, unknown>)
    .primary as Record<string, unknown>;
  assertEquals(
    primary.usedPercent,
    12,
    "preserves the coalesced next response",
  );
  assertEquals(child.messages.map((message) => message.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ], "still completes the handshake and quota request");
});

Deno.test("decodes split multibyte output independently for concurrent requests", async () => {
  let signalSecondPartial!: () => void;
  let signalFirstPartial!: () => void;
  let signalSecondRemainder!: () => void;
  const secondPartial = new Promise<void>((resolve) => {
    signalSecondPartial = resolve;
  });
  const firstPartial = new Promise<void>((resolve) => {
    signalFirstPartial = resolve;
  });
  const secondRemainder = new Promise<void>((resolve) => {
    signalSecondRemainder = resolve;
  });
  const firstText = "first-😀-quota";
  const secondText = "second-✓-quota";
  const first = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send({ id: 1, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      return (async () => {
        await secondPartial;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const bytes = encoder.encode(
          `${
            JSON.stringify({
              id: 2,
              result: { rateLimits: null, future: firstText },
            })
          }\n`,
        );
        const splitAt = bytes.findIndex((byte) => byte === 0xf0) + 1;
        server.sendBytes(bytes.slice(0, splitAt));
        signalFirstPartial();
        await secondRemainder;
        await new Promise((resolve) => setTimeout(resolve, 10));
        server.sendBytes(bytes.slice(splitAt));
      })();
    }
  });
  const second = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send({ id: 1, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      return (async () => {
        const bytes = encoder.encode(
          `${
            JSON.stringify({
              id: 2,
              result: { rateLimits: null, future: secondText },
            })
          }\n`,
        );
        const splitAt = bytes.findIndex((byte) => byte === 0xe2) + 1;
        server.sendBytes(bytes.slice(0, splitAt));
        signalSecondPartial();
        await firstPartial;
        await new Promise((resolve) => setTimeout(resolve, 10));
        server.sendBytes(bytes.slice(splitAt));
        signalSecondRemainder();
      })();
    }
  });

  const firstRequest = readRateLimits(options, () => first);
  const secondRequest = readRateLimits(options, () => second);
  const [firstResponse, secondResponse] = await Promise.all([
    firstRequest,
    secondRequest,
  ]);
  assertEquals(
    firstResponse.future,
    firstText,
    "decodes the first process output",
  );
  assertEquals(
    secondResponse.future,
    secondText,
    "decodes the second process output",
  );
});

Deno.test("does not carry an incomplete UTF-8 sequence into a later request", async () => {
  const interrupted = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send({ id: 1, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      server.sendBytes(encoder.encode('{"partial":"'));
      server.sendBytes(new Uint8Array([0xf0]));
    }
  });

  await assertRejects(
    () => readRateLimits({ ...options, timeoutMs: 100 }, () => interrupted),
    "timed out after 100 ms",
  );

  const next = successfulChild({ rateLimits: null });
  const response = await readRateLimits(options, () => next);
  assertEquals(
    response.rateLimits,
    null,
    "starts the next process with a clean UTF-8 decoder",
  );
});

Deno.test("sanitizes API-key RPC errors and always reaps the child", async () => {
  const secret = "sk-secret-that-must-not-appear";
  const child = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send({ id: 1, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      server.send({
        id: 2,
        error: { code: 401, message: `API key ${secret} unsupported` },
      });
    }
  });

  const error = await assertRejects(
    () => readRateLimits(options, () => child),
    "API-key authentication is unsupported",
  );
  assert(!error.message.includes(secret), "does not include the raw RPC error");
  assert(child.reaped, "reaps the child after an RPC error");
});

Deno.test("reports ChatGPT login requirements without exposing RPC details", async () => {
  const child = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send({ id: 1, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      server.send({
        id: 2,
        error: { code: 401, message: "not logged in: private detail" },
      });
    }
  });

  const error = await assertRejects(
    () => readRateLimits(options, () => child),
    "Run `codex login`",
  );
  assert(
    !error.message.includes("private detail"),
    "does not expose server error text",
  );
});

Deno.test("rejects malformed JSON without printing the malformed line", async () => {
  const child = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.send("{ credentials: private }");
    }
  });

  const error = await assertRejects(
    () => readRateLimits(options, () => child),
    "malformed JSON",
  );
  assert(
    !error.message.includes("credentials"),
    "does not expose raw protocol data",
  );
  assert(child.reaped, "reaps the child after malformed JSON");
});

Deno.test("rejects invalid quota shapes", async () => {
  const child = successfulChild({ rateLimits: { primary: "invalid" } });
  await assertRejects(
    () => readRateLimits(options, () => child),
    "invalid quota window",
  );
  assert(child.reaped, "reaps the child after response validation fails");
});

Deno.test("reports process exit before the expected response", async () => {
  const child = new FakeChild((message, server) => {
    if (message.method === "initialize") {
      server.exit();
    }
  });
  await assertRejects(
    () => readRateLimits(options, () => child),
    "exited before replying",
  );
  assert(child.reaped, "observes the process exit");
});

Deno.test("bounds initialization time and kills the process after timeout", async () => {
  const child = new FakeChild();
  const error = await assertRejects(
    () => readRateLimits({ ...options, timeoutMs: 100 }, () => child),
    "timed out after 100 ms",
  );
  assert(
    error.message.includes("g:quota_timeout_ms"),
    "gives an actionable timeout hint",
  );
  assert(child.reaped, "reaps the child after timeout");
});

Deno.test("force-kills and reaps a child that ignores SIGTERM", async () => {
  const child = new FakeChild();
  child.ignoreTerminate = true;
  await assertRejects(
    () => readRateLimits({ ...options, timeoutMs: 100 }, () => child),
    "timed out after 100 ms",
  );
  assertEquals(
    child.killSignals,
    ["SIGTERM", "SIGKILL"],
    "uses a bounded kill fallback",
  );
  assert(child.reaped, "waits for the forced exit");
});

Deno.test("classifies a missing Codex executable without echoing its path", async () => {
  const error = await assertRejects(
    () =>
      readRateLimits({ ...options, binary: "/private/path/codex" }, () => {
        throw new Deno.errors.NotFound("/private/path/codex");
      }),
    "Codex executable not found",
  );
  assert(
    !error.message.includes("/private/path"),
    "does not expose the configured path",
  );
});
