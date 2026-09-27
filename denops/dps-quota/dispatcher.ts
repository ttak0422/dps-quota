import { formatQuota } from "./formatter.ts";
import { QuotaError, type QuotaProvider, type QuotaSnapshot } from "./quota.ts";

export interface DispatcherHost {
  eval(expression: string): Promise<unknown>;
  call(functionName: string, ...args: unknown[]): Promise<unknown>;
  cmd(command: string): Promise<void>;
}

export interface QuotaDispatcher
  extends Record<string, (...args: unknown[]) => unknown> {
  get(...args: unknown[]): Promise<Record<string, unknown>>;
  getQuota(...args: unknown[]): Promise<QuotaSnapshot>;
  Quota(...args: unknown[]): Promise<null>;
}

const DEFAULT_PROVIDER_VARIABLE = "get(g:, 'quota_provider', '')";
const SAFE_READ_ERROR =
  "Could not read usage quotas. Check the provider configuration and sign-in.";

export function createDispatcher(
  host: DispatcherHost,
  providers: ReadonlyMap<string, QuotaProvider>,
  defaultProviderId: string,
): QuotaDispatcher {
  const getQuota = async (...args: unknown[]): Promise<QuotaSnapshot> => {
    const provider = await selectProvider(
      host,
      providers,
      defaultProviderId,
      args,
    );
    const result = await readProvider(provider);
    return result.snapshot;
  };

  const get = async (...args: unknown[]): Promise<Record<string, unknown>> => {
    const provider = await selectProvider(
      host,
      providers,
      defaultProviderId,
      args,
    );
    const result = await readProvider(provider);
    return result.raw;
  };

  return {
    get,
    getQuota,
    Quota: async (...args: unknown[]): Promise<null> => {
      try {
        const snapshot = await getQuota(...args);
        await echoMessage(host, formatQuota(snapshot));
      } catch (error) {
        const message = error instanceof QuotaError
          ? error.message
          : SAFE_READ_ERROR;
        try {
          await echoMessage(host, `Quota: ${message}`);
        } catch {
          // Do not surface host errors that might include unrelated sensitive data.
        }
      }
      return null;
    },
  };
}

async function selectProvider(
  host: DispatcherHost,
  providers: ReadonlyMap<string, QuotaProvider>,
  defaultProviderId: string,
  args: unknown[],
): Promise<QuotaProvider> {
  if (args.length > 1) {
    throw new QuotaError("Expected no arguments or one quota provider id.");
  }

  let providerId: unknown;
  if (args.length === 1) {
    providerId = args[0];
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new QuotaError("The quota provider id must be a non-empty string.");
    }
  } else {
    try {
      providerId = await host.eval(DEFAULT_PROVIDER_VARIABLE);
    } catch {
      throw new QuotaError("Could not read g:quota_provider.");
    }
    if (providerId === "" || providerId === null || providerId === undefined) {
      providerId = defaultProviderId;
    }
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new QuotaError("g:quota_provider must be a non-empty string.");
    }
  }

  const provider = providers.get(providerId);
  if (provider === undefined) {
    const available = [...providers.keys()].sort().join(", ");
    throw new QuotaError(
      available.length > 0
        ? `Unknown quota provider. Available providers: ${available}.`
        : "No quota providers are registered.",
    );
  }
  return provider;
}

async function readProvider(provider: QuotaProvider) {
  try {
    return await provider.read();
  } catch (error) {
    if (error instanceof QuotaError) {
      throw error;
    }
    throw new QuotaError(SAFE_READ_ERROR);
  }
}

async function echoMessage(
  host: DispatcherHost,
  message: string,
): Promise<void> {
  for (const line of message.split("\n")) {
    const literal = await host.call("string", line);
    if (typeof literal !== "string") {
      throw new QuotaError("Could not safely format the editor message.");
    }
    await host.cmd(`echomsg ${literal}`);
  }
}
