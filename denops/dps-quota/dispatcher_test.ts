import {
  createDispatcher,
  type DispatcherHost,
  formatQuota,
} from "./dispatcher.ts";
import {
  type AppServerOptions,
  QuotaError,
  type RateLimitsResponse,
} from "./codex_app_server.ts";

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

function response(): RateLimitsResponse {
  return {
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 20,
        remainingPercent: 80,
        windowDurationMins: 120,
        resetsAt: 1_730_947_200,
      },
      secondary: null,
    },
    rateLimitsByLimitId: {},
  };
}

class FakeHost implements DispatcherHost {
  readonly evaluations: string[] = [];
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly commands: string[] = [];
  binary: unknown = "codex-custom";
  timeoutMs: unknown = 20_000;

  eval(expression: string): Promise<unknown> {
    this.evaluations.push(expression);
    return Promise.resolve(
      expression.includes("quota_codex_path") ? this.binary : this.timeoutMs,
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

Deno.test("get dispatcher returns quota data using Vim global configuration", async () => {
  const host = new FakeHost();
  const expected = response();
  const requested: AppServerOptions[] = [];
  const dispatcher = createDispatcher(host, (options) => {
    requested.push(options);
    return Promise.resolve(expected);
  });

  const result = await dispatcher.get();
  assertEquals(result, expected, "returns the dictionary from the quota read");
  assertEquals(
    requested,
    [{ binary: "codex-custom", timeoutMs: 20_000 }],
    "uses configured executable and timeout",
  );
  assertEquals(host.calls, [], "get does not print or mutate editor state");
  assertEquals(host.commands, [], "get does not execute editor commands");
});

Deno.test("Quota asynchronously prints readable usage percentages", async () => {
  const host = new FakeHost();
  const dispatcher = createDispatcher(host, () => Promise.resolve(response()));

  assertEquals(
    await dispatcher.Quota(),
    null,
    "command dispatcher returns no payload",
  );
  assertEquals(host.commands.length, 4, "prints each line separately");
  assert(
    host.calls.every(([, text]) => !String(text).includes("\n")),
    "does not embed newline literals in Vim commands",
  );
  const command = host.commands[0];
  assert(command.startsWith("echomsg "), "prints through Vim message history");
  const text = host.commands.join("\n");
  assert(text.includes("80% remaining"), "prints remaining percentage");
  assert(text.includes("20% used"), "prints used percentage");
  assert(
    text.includes("120 min window"),
    "prints the server-provided window duration",
  );
  assert(
    text.includes("not token counts"),
    "labels quota as usage rather than tokens",
  );
});

Deno.test("Quota surfaces actionable safe errors and suppresses raw failures", async () => {
  const host = new FakeHost();
  const dispatcher = createDispatcher(
    host,
    () =>
      Promise.reject(
        new QuotaError("Codex is not signed in. Run `codex login`."),
      ),
  );

  await dispatcher.Quota();
  assert(
    host.commands[0].startsWith("echomsg "),
    "reports an error in Vim",
  );
  assert(
    host.commands[0].includes("codex login"),
    "keeps the safe guidance",
  );
});

Deno.test("dispatcher does not surface unexpected exception contents", async () => {
  const host = new FakeHost();
  const dispatcher = createDispatcher(
    host,
    () => Promise.reject(new Error("private-token-should-not-be-displayed")),
  );

  await dispatcher.Quota();
  const message = host.commands[0];
  assert(
    message.includes("Could not read Codex"),
    "prints generic safe guidance",
  );
  assert(
    !message.includes("private-token"),
    "does not print raw exception text",
  );
});

Deno.test("formats server-provided buckets without assuming fixed window lengths", () => {
  const formatted = formatQuota({
    rateLimits: {
      primary: {
        usedPercent: 50,
        remainingPercent: 50,
        windowDurationMins: 37,
      },
      secondary: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 50,
          remainingPercent: 50,
          windowDurationMins: 37,
        },
      },
      codex_other: {
        limitName: "Other\nBucket",
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          windowDurationMins: 2_880,
        },
      },
    },
  });
  assert(
    formatted.includes("37 min window"),
    "prints actual server window length",
  );
  assert(
    formatted.includes("2880 min window"),
    "does not hardcode quota periods",
  );
  assert(
    formatted.includes("Other Bucket"),
    "removes control characters from labels",
  );
});

Deno.test("prefers a nonempty bucket map instead of printing the legacy bucket twice", () => {
  const formatted = formatQuota({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 5, remainingPercent: 95 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 5, remainingPercent: 95 },
      },
      codex_other: {
        limitId: "codex_other",
        primary: { usedPercent: 15, remainingPercent: 85 },
      },
    },
  });

  assertEquals(
    formatted.split("\ncodex:\n").length - 1,
    1,
    "prints the duplicate codex bucket only once",
  );
  assert(formatted.includes("codex_other:"), "keeps all mapped buckets");
});

Deno.test("falls back to the legacy bucket when the bucket map is empty", () => {
  const formatted = formatQuota({
    rateLimits: {
      limitId: "legacy",
      primary: { usedPercent: 30, remainingPercent: 70 },
    },
    rateLimitsByLimitId: {},
  });

  assert(formatted.includes("legacy:"), "prints the legacy quota bucket");
  assert(formatted.includes("70% remaining"), "formats its window data");
});

Deno.test("rejects invalid Vim configuration with an actionable message", async () => {
  const host = new FakeHost();
  host.timeoutMs = 2;
  const dispatcher = createDispatcher(
    host,
    () => Promise.resolve(response()),
  );
  try {
    await dispatcher.get();
    throw new Error("Expected invalid timeout configuration to reject");
  } catch (error) {
    assert(error instanceof QuotaError, "throws a safe configuration error");
    assert(
      error.message.includes("100 to 120000"),
      "documents the accepted range",
    );
  }
});
