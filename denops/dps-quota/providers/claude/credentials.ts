import { QuotaError } from "../../quota.ts";

export const MAX_CREDENTIAL_BYTES = 256 * 1024;
const MAX_OAUTH_TOKEN_BYTES = 16 * 1024;
const KEYCHAIN_EXECUTABLE = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_GRACE_MS = 250;

export interface CredentialFileHandle {
  stat(): Promise<{ size: number; isFile: boolean }>;
  read(buffer: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface KeychainChild {
  stdout: ReadableStream<Uint8Array>;
  status: Promise<{ success: boolean; code: number }>;
  kill(signal?: Deno.Signal): void;
}

export type OpenCredentialFile = (
  path: string,
) => Promise<CredentialFileHandle>;

export type StatCredentialPath = (
  path: string,
) => Promise<{ size: number; isFile: boolean }>;

export type SpawnKeychain = (
  executable: string,
  args: string[],
) => KeychainChild;

export interface ClaudeCredentialDependencies {
  getEnv(name: string): string | undefined;
  readCredentialFile(path: string, maxBytes: number): Promise<string | null>;
  readKeychain(
    service: string,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<string>;
  now(): number;
}

export async function readTokenFromEnvironmentOrFile(
  dependencies: Pick<
    ClaudeCredentialDependencies,
    "getEnv" | "readCredentialFile" | "now"
  >,
): Promise<string | null> {
  const quotaToken = readEnvironmentValue(
    dependencies.getEnv,
    "QUOTA_CLAUDE_OAUTH_TOKEN",
  );
  if (isNonEmptyString(quotaToken)) {
    return validateOAuthToken(quotaToken);
  }

  const claudeCodeToken = readEnvironmentValue(
    dependencies.getEnv,
    "CLAUDE_CODE_OAUTH_TOKEN",
  );
  if (isNonEmptyString(claudeCodeToken)) {
    return validateOAuthToken(claudeCodeToken);
  }

  const configDir = readEnvironmentValue(
    dependencies.getEnv,
    "CLAUDE_CONFIG_DIR",
  );
  const home = isNonEmptyString(configDir)
    ? undefined
    : readEnvironmentValue(dependencies.getEnv, "HOME");
  const credentialPath = credentialFilePath(configDir, home);
  if (credentialPath === null) {
    return null;
  }

  const content = await dependencies.readCredentialFile(
    credentialPath,
    MAX_CREDENTIAL_BYTES,
  );
  if (content === null) {
    return null;
  }
  return parseClaudeCredentialDocument(content, dependencies.now());
}

export function parseClaudeCredentialDocument(
  content: string,
  nowMs: number,
): string | null {
  if (new TextEncoder().encode(content).byteLength > MAX_CREDENTIAL_BYTES) {
    throw new QuotaError("Claude Code credentials exceed the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new QuotaError("Claude Code credentials are not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new QuotaError("Claude Code credentials have an invalid format.");
  }
  if (!Object.hasOwn(value, "claudeAiOauth")) {
    return null;
  }

  const oauth = value.claudeAiOauth;
  if (!isRecord(oauth)) {
    throw new QuotaError(
      "Claude Code OAuth credentials have an invalid format.",
    );
  }
  if (!Object.hasOwn(oauth, "accessToken")) {
    return null;
  }
  if (!isNonEmptyString(oauth.accessToken)) {
    throw new QuotaError(
      "Claude Code OAuth credentials have an invalid format.",
    );
  }

  if (Object.hasOwn(oauth, "expiresAt")) {
    const expiresAt = oauth.expiresAt;
    if (
      typeof expiresAt !== "number" || !Number.isFinite(expiresAt) ||
      expiresAt < 0
    ) {
      throw new QuotaError(
        "Claude Code OAuth expiration has an invalid format.",
      );
    }
    if (expiresAt <= nowMs) {
      throw new QuotaError(
        "Claude Code OAuth credentials have expired. Run `claude auth login` and retry.",
      );
    }
  }

  return validateOAuthToken(oauth.accessToken);
}

export async function readBoundedCredentialFile(
  path: string,
  maxBytes: number,
  open: OpenCredentialFile = openCredentialFile,
  stat: StatCredentialPath = statCredentialPath,
): Promise<string | null> {
  try {
    const pathInfo = await stat(path);
    if (!pathInfo.isFile) {
      throw new QuotaError(
        "Claude Code credentials must be a regular file.",
      );
    }
    if (pathInfo.size > maxBytes) {
      throw new QuotaError("Claude Code credentials exceed the size limit.");
    }
  } catch (error) {
    if (error instanceof QuotaError) {
      throw error;
    }
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    if (isPermissionError(error)) {
      throw new QuotaError(
        "Deno cannot read Claude Code credentials. Grant denops read permission for the Claude config credentials file.",
      );
    }
    throw new QuotaError("Could not read Claude Code credentials.");
  }

  let file: CredentialFileHandle;
  try {
    file = await open(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    if (isPermissionError(error)) {
      throw new QuotaError(
        "Deno cannot read Claude Code credentials. Grant denops read permission for the Claude config credentials file.",
      );
    }
    throw new QuotaError("Could not read Claude Code credentials.");
  }

  try {
    const info = await file.stat();
    if (!info.isFile) {
      throw new QuotaError(
        "Claude Code credentials must be a regular file.",
      );
    }
    if (info.size > maxBytes) {
      throw new QuotaError("Claude Code credentials exceed the size limit.");
    }

    const bytes = new Uint8Array(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const count = await file.read(bytes.subarray(length));
      if (count === null) {
        break;
      }
      if (count === 0) {
        continue;
      }
      length += count;
      if (length > maxBytes) {
        throw new QuotaError("Claude Code credentials exceed the size limit.");
      }
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      );
    } catch {
      throw new QuotaError("Claude Code credentials are not valid UTF-8.");
    }
  } catch (error) {
    if (error instanceof QuotaError) {
      throw error;
    }
    if (isPermissionError(error)) {
      throw new QuotaError(
        "Deno cannot read Claude Code credentials. Grant denops read permission for the Claude config credentials file.",
      );
    }
    throw new QuotaError("Could not read Claude Code credentials.");
  } finally {
    try {
      file.close();
    } catch {
      // Closing a read-only credential file must not expose platform details.
    }
  }
}

export async function readMacOSKeychainCredential(
  service: string,
  timeoutMs: number,
  maxBytes: number,
  spawn: SpawnKeychain = spawnKeychain,
): Promise<string> {
  let child: KeychainChild;
  try {
    child = spawn(KEYCHAIN_EXECUTABLE, [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new QuotaError(
        "Deno cannot run the macOS Keychain lookup. Grant denops run permission for /usr/bin/security.",
      );
    }
    throw new QuotaError("Could not start the macOS Keychain lookup.");
  }

  const reader = child.stdout.getReader();
  const status = child.status.catch(() => ({ success: false, code: -1 }));
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The command may have exited concurrently.
      }
      reject(
        new QuotaError(
          `Claude Code Keychain lookup timed out after ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);
  });

  const operation = readKeychainOutput(reader, status, maxBytes);
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof QuotaError) {
      throw error;
    }
    throw new QuotaError(
      "Could not read Claude Code credentials from macOS Keychain.",
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (timedOut) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The command may have exited concurrently.
      }
    }
    await reader.cancel().catch(() => undefined);
    await stopKeychainChild(child, status);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have been released after a stream error.
    }
  }
}

export function credentialFilePath(
  configDir: string | undefined,
  home: string | undefined,
): string | null {
  const root = isNonEmptyString(configDir)
    ? configDir
    : isNonEmptyString(home)
    ? `${home.replace(/\/+$/, "")}/.claude`
    : null;
  if (root === null) {
    return null;
  }
  const normalizedRoot = root.trim().replace(/\/+$/, "");
  if (
    normalizedRoot === "" || normalizedRoot.length > 4096 ||
    normalizedRoot.includes("\0")
  ) {
    throw new QuotaError("Claude Code config directory is invalid.");
  }
  return `${normalizedRoot}/.credentials.json`;
}

function readEnvironmentValue(
  getEnv: ClaudeCredentialDependencies["getEnv"],
  name: string,
): string | undefined {
  try {
    return getEnv(name);
  } catch {
    throw new QuotaError(
      "Deno cannot read Claude authentication environment variables. Grant denops environment permission for Claude token and config variables.",
    );
  }
}

async function openCredentialFile(
  path: string,
): Promise<CredentialFileHandle> {
  return await Deno.open(path, { read: true });
}

async function statCredentialPath(
  path: string,
): Promise<{ size: number; isFile: boolean }> {
  return await Deno.stat(path);
}

function spawnKeychain(executable: string, args: string[]): KeychainChild {
  return new Deno.Command(executable, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
}

async function readKeychainOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  status: Promise<{ success: boolean; code: number }>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > maxBytes) {
      throw new QuotaError("Claude Code credentials exceed the size limit.");
    }
    chunks.push(value);
  }

  const result = await status;
  if (!result.success) {
    throw new QuotaError(
      "Could not read Claude Code credentials from macOS Keychain.",
    );
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
    throw new QuotaError("Claude Code credentials are not valid UTF-8.");
  }
}

async function stopKeychainChild(
  child: KeychainChild,
  status: Promise<{ success: boolean; code: number }>,
): Promise<void> {
  const exited = await waitForKeychainExit(status, KEYCHAIN_TIMEOUT_GRACE_MS);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The command may have exited concurrently.
    }
    await waitForKeychainExit(status, KEYCHAIN_TIMEOUT_GRACE_MS);
  }
}

async function waitForKeychainExit(
  status: Promise<{ success: boolean; code: number }>,
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    (error instanceof Error && error.name === "NotCapable");
}

function validateOAuthToken(value: string): string {
  const token = value.trim();
  if (
    new TextEncoder().encode(token).byteLength > MAX_OAUTH_TOKEN_BYTES ||
    /\s/.test(token)
  ) {
    throw new QuotaError("Claude OAuth token has an invalid format.");
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
