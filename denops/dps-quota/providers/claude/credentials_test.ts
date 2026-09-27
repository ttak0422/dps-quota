import {
  type CredentialFileHandle,
  credentialFilePath,
  type KeychainChild,
  MAX_CREDENTIAL_BYTES,
  parseClaudeCredentialDocument,
  readBoundedCredentialFile,
  readMacOSKeychainCredential,
} from "./credentials.ts";
import { QuotaError } from "../../quota.ts";

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

function credentialText(token: string, expiresAt?: number): string {
  const oauth: Record<string, unknown> = { accessToken: token };
  if (expiresAt !== undefined) {
    oauth.expiresAt = expiresAt;
  }
  return JSON.stringify({ claudeAiOauth: oauth });
}

function fileHandleFor(
  text: string,
  reportedSize = new TextEncoder().encode(text).byteLength,
  reportedIsFile = true,
) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let closed = false;
  let reads = 0;
  const file: CredentialFileHandle = {
    stat: () => Promise.resolve({ size: reportedSize, isFile: reportedIsFile }),
    read: (buffer) => {
      reads++;
      if (offset >= bytes.byteLength) {
        return Promise.resolve(null);
      }
      const length = Math.min(buffer.byteLength, bytes.byteLength - offset);
      buffer.set(bytes.subarray(offset, offset + length));
      offset += length;
      return Promise.resolve(length);
    },
    close: () => {
      closed = true;
    },
  };
  return {
    file,
    isClosed: () => closed,
    readCount: () => reads,
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function keychainChild(
  stdout: ReadableStream<Uint8Array>,
  status: Promise<{ success: boolean; code: number }> = Promise.resolve({
    success: true,
    code: 0,
  }),
  kill: (signal?: Deno.Signal) => void = () => undefined,
): KeychainChild {
  return { stdout, status, kill };
}

Deno.test("parses only the OAuth access token and rejects expired credentials", () => {
  assertEquals(
    parseClaudeCredentialDocument(
      credentialText("synthetic-token", 20_000),
      10_000,
    ),
    "synthetic-token",
    "reads accessToken from claudeAiOauth",
  );
  assertEquals(
    parseClaudeCredentialDocument(credentialText("non-expiring-token"), 10_000),
    "non-expiring-token",
    "accepts an optional expiration field",
  );
  assertEquals(
    parseClaudeCredentialDocument(JSON.stringify({ other: "value" }), 10_000),
    null,
    "does not infer another credential type",
  );
});

Deno.test("rejects expired and malformed credential JSON without exposing contents", async () => {
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseClaudeCredentialDocument(
          credentialText("private-expired-token", 10_000),
          10_000,
        )
      ),
    "have expired",
    ["private-expired-token"],
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseClaudeCredentialDocument('{"claudeAiOauth":{"accessToken":42}}', 0)
      ),
    "invalid format",
    ["42"],
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseClaudeCredentialDocument("private-token: not json", 0)
      ),
    "not valid JSON",
    ["private-token"],
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseClaudeCredentialDocument("private-token".repeat(50_000), 0)
      ),
    "exceed the size limit",
    ["private-token"],
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseClaudeCredentialDocument(
          JSON.stringify({
            claudeAiOauth: { accessToken: "x", expiresAt: "soon" },
          }),
          0,
        )
      ),
    "expiration has an invalid format",
    ["soon"],
  );
});

Deno.test("selects the configured credentials path without reading another path", () => {
  assertEquals(
    credentialFilePath("/synthetic/config/", "/synthetic/home"),
    "/synthetic/config/.credentials.json",
    "CLAUDE_CONFIG_DIR takes precedence over HOME",
  );
  assertEquals(
    credentialFilePath(undefined, "/synthetic/home/"),
    "/synthetic/home/.claude/.credentials.json",
    "falls back to HOME/.claude",
  );
  assertEquals(
    credentialFilePath(undefined, undefined),
    null,
    "handles absent roots",
  );
});

Deno.test("reads synthetic credential files with a strict bounded byte limit", async () => {
  const text = credentialText("synthetic-file-token");
  const handle = fileHandleFor(text);
  const paths: string[] = [];
  const actual = await readBoundedCredentialFile(
    "/synthetic/.credentials.json",
    MAX_CREDENTIAL_BYTES,
    (path) => {
      paths.push(path);
      return Promise.resolve(handle.file);
    },
    () =>
      Promise.resolve({
        size: new TextEncoder().encode(text).byteLength,
        isFile: true,
      }),
  );
  assertEquals(actual, text, "reads content via an injected file handle");
  assertEquals(
    paths,
    ["/synthetic/.credentials.json"],
    "uses the selected file path",
  );
  assert(handle.isClosed(), "closes the file handle");

  const oversized = fileHandleFor("not read", MAX_CREDENTIAL_BYTES + 1);
  let oversizedOpened = false;
  await assertRejects(
    () =>
      readBoundedCredentialFile(
        "/synthetic/oversized",
        MAX_CREDENTIAL_BYTES,
        () => {
          oversizedOpened = true;
          return Promise.resolve(oversized.file);
        },
        () => Promise.resolve({ size: MAX_CREDENTIAL_BYTES + 1, isFile: true }),
      ),
    "exceed the size limit",
    ["/synthetic/oversized"],
  );
  assert(!oversizedOpened, "rejects oversized files before opening them");
  assertEquals(oversized.readCount(), 0, "does not read oversized files");
});

Deno.test("rejects non-regular credential paths before opening them", async () => {
  let opened = false;
  await assertRejects(
    () =>
      readBoundedCredentialFile(
        "/synthetic/fifo",
        MAX_CREDENTIAL_BYTES,
        () => {
          opened = true;
          return Promise.resolve(fileHandleFor("").file);
        },
        () => Promise.resolve({ size: 0, isFile: false }),
      ),
    "must be a regular file",
    ["/synthetic/fifo"],
  );
  assert(!opened, "does not open FIFO/device paths that could block");

  const swapped = fileHandleFor("must not be read", undefined, false);
  await assertRejects(
    () =>
      readBoundedCredentialFile(
        "/synthetic/swapped",
        MAX_CREDENTIAL_BYTES,
        () => Promise.resolve(swapped.file),
        () => Promise.resolve({ size: 1, isFile: true }),
      ),
    "must be a regular file",
  );
  assertEquals(
    swapped.readCount(),
    0,
    "checks the opened descriptor before reading",
  );
  assert(
    swapped.isClosed(),
    "closes a descriptor whose type changed after stat",
  );
});

Deno.test("runs an injected shell-free Keychain command with bounded output", async () => {
  let executable = "";
  let args: string[] = [];
  const output = credentialText("synthetic-keychain-token");
  const result = await readMacOSKeychainCredential(
    "Claude Code-credentials",
    1_000,
    1_024,
    (command, commandArgs) => {
      executable = command;
      args = commandArgs;
      return keychainChild(streamOf(output));
    },
  );
  assertEquals(
    result,
    output,
    "returns only bounded standard output for parsing",
  );
  assertEquals(
    executable,
    "/usr/bin/security",
    "uses the fixed system command",
  );
  assertEquals(
    args,
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    "passes service as an argument without a shell",
  );

  await assertRejects(
    () =>
      readMacOSKeychainCredential(
        "synthetic-service",
        1_000,
        4,
        () => keychainChild(streamOf("private-output-too-large")),
      ),
    "exceed the size limit",
    ["private-output-too-large"],
  );
});

Deno.test("sanitizes Keychain command failures and enforces a timeout", async () => {
  await assertRejects(
    () =>
      readMacOSKeychainCredential(
        "synthetic-service",
        1_000,
        1_024,
        () =>
          keychainChild(
            streamOf("private-keychain-error"),
            Promise.resolve({ success: false, code: 44 }),
          ),
      ),
    "Could not read Claude Code credentials from macOS Keychain",
    ["private-keychain-error", "44"],
  );

  let resolveStatus:
    | ((status: { success: boolean; code: number }) => void)
    | undefined;
  const status = new Promise<{ success: boolean; code: number }>((resolve) => {
    resolveStatus = resolve;
  });
  const signals: Array<Deno.Signal | undefined> = [];
  const child = keychainChild(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    }),
    status,
    (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        resolveStatus?.({ success: false, code: 143 });
      }
    },
  );
  await assertRejects(
    () =>
      readMacOSKeychainCredential(
        "synthetic-service",
        100,
        1_024,
        () => child,
      ),
    "timed out after 100 ms",
    ["synthetic-service"],
  );
  assert(signals.includes("SIGTERM"), "terminates a timed-out Keychain lookup");
});
