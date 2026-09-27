export interface AppServerOptions {
  binary: string;
  timeoutMs: number;
}

export type RateLimitsResponse = Record<string, unknown>;

export class QuotaError extends Error {
  override name = "QuotaError";
}

interface AppServerChild {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}

type SpawnAppServer = (binary: string) => AppServerChild;

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;
const MAX_MESSAGE_LENGTH = 1_000_000;
const TERMINATE_GRACE_MS = 250;
const encoder = new TextEncoder();

export async function readRateLimits(
  options: AppServerOptions,
  spawn: SpawnAppServer = spawnAppServer,
): Promise<RateLimitsResponse> {
  const normalized = validateOptions(options);
  let child: AppServerChild;

  try {
    child = spawn(normalized.binary);
  } catch (error) {
    throw spawnError(error);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let operation: Promise<RateLimitsResponse> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new QuotaError(
          `Codex app-server timed out after ${normalized.timeoutMs} ms. ` +
            "Increase g:quota_timeout_ms or check Codex sign-in.",
        ),
      );
    }, normalized.timeoutMs);
  });

  try {
    reader = child.stdout.getReader();
    writer = child.stdin.getWriter();
    operation = runProtocol(new JsonLineReader(reader), writer);
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof QuotaError) {
      throw error;
    }
    throw new QuotaError(
      "Codex app-server communication failed. Check the Codex CLI installation and sign-in.",
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    await stopAndReap(child, reader, writer, operation);
  }
}

function validateOptions(options: AppServerOptions): AppServerOptions {
  if (typeof options.binary !== "string" || options.binary.trim() === "") {
    throw new QuotaError(
      "g:quota_codex_path must be a non-empty Codex executable path.",
    );
  }
  if (
    !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 ||
    options.timeoutMs > 120_000
  ) {
    throw new QuotaError(
      "g:quota_timeout_ms must be an integer from 100 to 120000.",
    );
  }
  return options;
}

function spawnAppServer(binary: string): AppServerChild {
  return new Deno.Command(binary, {
    args: ["app-server"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
}

async function runProtocol(
  reader: JsonLineReader,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<RateLimitsResponse> {
  await send(writer, {
    method: "initialize",
    id: INITIALIZE_ID,
    params: {
      clientInfo: {
        name: "dps_quota",
        version: "0.1.0",
        title: "dps-quota",
      },
    },
  });

  const initializeResult = await waitForResponse(
    reader,
    INITIALIZE_ID,
    "initialize",
  );
  if (!isRecord(initializeResult)) {
    throw new QuotaError(
      "Codex app-server returned an invalid initialize response.",
    );
  }

  await send(writer, { method: "initialized", params: {} });
  await send(writer, {
    method: "account/rateLimits/read",
    id: RATE_LIMITS_ID,
    params: {},
  });

  return enrichRateLimits(
    await waitForResponse(reader, RATE_LIMITS_ID, "quota"),
  );
}

async function send(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: Record<string, unknown>,
): Promise<void> {
  await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

class JsonLineReader {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  private ended = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async readMessage(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/, "");
        this.buffered = this.buffered.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        if (line.length > MAX_MESSAGE_LENGTH) {
          throw new QuotaError(
            "Codex app-server returned an oversized response.",
          );
        }
        return parseMessage(line);
      }

      if (this.buffered.length > MAX_MESSAGE_LENGTH) {
        throw new QuotaError(
          "Codex app-server returned an oversized response.",
        );
      }
      if (this.ended) {
        if (this.buffered.length > 0) {
          const line = this.buffered.replace(/\r$/, "");
          this.buffered = "";
          return parseMessage(line);
        }
        throw new QuotaError(
          "Codex app-server exited before replying. Check the Codex CLI version and sign-in.",
        );
      }

      const { done, value } = await this.reader.read();
      if (done) {
        this.buffered += this.decoder.decode();
        this.ended = true;
      } else {
        this.buffered += this.decoder.decode(value, { stream: true });
      }
    }
  }
}

async function waitForResponse(
  reader: JsonLineReader,
  expectedId: number,
  phase: "initialize" | "quota",
): Promise<unknown> {
  while (true) {
    const message = await reader.readMessage();
    if (!Object.hasOwn(message, "id") || message.id !== expectedId) {
      continue;
    }
    if (Object.hasOwn(message, "error")) {
      throw rpcError(message.error, phase);
    }
    if (!Object.hasOwn(message, "result")) {
      throw new QuotaError("Codex app-server returned an incomplete response.");
    }
    return message.result;
  }
}

function parseMessage(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new QuotaError("Codex app-server returned malformed JSON.");
  }
  if (!isRecord(value)) {
    throw new QuotaError(
      "Codex app-server returned an invalid protocol message.",
    );
  }
  return value;
}

function rpcError(value: unknown, phase: "initialize" | "quota"): QuotaError {
  const message = isRecord(value) && typeof value.message === "string"
    ? value.message.toLowerCase()
    : "";
  const code = isRecord(value) && Number.isInteger(value.code)
    ? value.code
    : undefined;

  if (/api[\s_-]*key|apikey/.test(message)) {
    return new QuotaError(
      "Codex usage quotas require ChatGPT sign-in; API-key authentication is unsupported. Run `codex login` and retry.",
    );
  }
  if (
    /not logged|logged out|not signed|not authenticated|unauthori[sz]ed|authentication|required.*login|sign(?:ed)?[ -]?in|chatgpt account|oauth|access token/
      .test(
        message,
      ) || code === 401 || code === 403
  ) {
    return new QuotaError(
      "Codex is not signed in to a ChatGPT account. Run `codex login` and retry.",
    );
  }

  const failedStep = phase === "initialize"
    ? "initialization"
    : "quota request";
  return new QuotaError(
    `Codex app-server rejected the ${failedStep}. Update the Codex CLI and check ChatGPT sign-in.`,
  );
}

function spawnError(error: unknown): QuotaError {
  if (error instanceof Deno.errors.NotFound) {
    return new QuotaError(
      "Codex executable not found. Install Codex CLI or set g:quota_codex_path.",
    );
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return new QuotaError(
      "Deno cannot run the configured Codex executable. Grant run permission to denops.",
    );
  }
  return new QuotaError(
    "Could not start Codex app-server. Check g:quota_codex_path and Deno run permission.",
  );
}

function enrichRateLimits(value: unknown): RateLimitsResponse {
  if (!isRecord(value) || !Object.hasOwn(value, "rateLimits")) {
    throw new QuotaError(
      "Codex app-server returned an invalid quota response.",
    );
  }

  const result: RateLimitsResponse = { ...value };
  result.rateLimits = enrichBucket(value.rateLimits);

  if (Object.hasOwn(value, "rateLimitsByLimitId")) {
    const buckets = value.rateLimitsByLimitId;
    if (buckets === null) {
      result.rateLimitsByLimitId = null;
    } else if (isRecord(buckets)) {
      result.rateLimitsByLimitId = Object.fromEntries(
        Object.entries(buckets).map(([key, bucket]) => [
          key,
          enrichBucket(bucket),
        ]),
      );
    } else {
      throw new QuotaError(
        "Codex app-server returned an invalid quota bucket map.",
      );
    }
  }

  return result;
}

function enrichBucket(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new QuotaError("Codex app-server returned an invalid quota bucket.");
  }

  const bucket = { ...value };
  for (const windowName of ["primary", "secondary"] as const) {
    if (!Object.hasOwn(value, windowName)) {
      continue;
    }
    const window = value[windowName];
    if (window === null) {
      bucket[windowName] = null;
      continue;
    }
    if (!isRecord(window)) {
      throw new QuotaError(
        "Codex app-server returned an invalid quota window.",
      );
    }

    const enrichedWindow = { ...window };
    if (Object.hasOwn(window, "usedPercent")) {
      if (window.usedPercent === null) {
        enrichedWindow.usedPercent = null;
      } else if (
        typeof window.usedPercent === "number" &&
        Number.isFinite(window.usedPercent)
      ) {
        enrichedWindow.remainingPercent = 100 - window.usedPercent;
      } else {
        throw new QuotaError(
          "Codex app-server returned an invalid quota usage percentage.",
        );
      }
    }
    bucket[windowName] = enrichedWindow;
  }
  return bucket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function stopAndReap(
  child: AppServerChild,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
  operation: Promise<unknown> | undefined,
): Promise<void> {
  const closeStdin = writer?.close().catch(() => undefined) ??
    Promise.resolve();
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }

  const exited = await waitForExit(child.status, TERMINATE_GRACE_MS);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A concurrent exit is harmless; status below still reaps the process.
    }
  }
  await child.status.catch(() => undefined);
  await closeStdin;
  await reader?.cancel().catch(() => undefined);
  await operation?.catch(() => undefined);
  if (writer) {
    try {
      writer.releaseLock();
    } catch {
      // The writer can already be released if setup failed partway through.
    }
  }
  if (reader) {
    try {
      reader.releaseLock();
    } catch {
      // The reader can already be released if setup failed partway through.
    }
  }
}

async function waitForExit(
  status: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = status.then(() => true as const);
  const result = await Promise.race([exited, timeout]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
  return result;
}
