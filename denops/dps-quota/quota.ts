export interface QuotaSnapshot {
  provider: {
    id: string;
    displayName: string;
  };
  buckets: QuotaBucket[];
}

export interface QuotaBucket {
  id?: string;
  displayName: string;
  windows: QuotaWindow[];
}

export interface QuotaWindow {
  name: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  durationMinutes?: number | null;
  /** Unix epoch seconds. */
  resetsAtEpochSeconds?: number | null;
}

export interface QuotaReadResult {
  snapshot: QuotaSnapshot;
  /** Provider-specific raw quota response; must not contain authentication data. */
  raw: Record<string, unknown>;
}

export interface QuotaProvider {
  readonly id: string;
  readonly displayName: string;
  read(): Promise<QuotaReadResult>;
}

/** An error with a deliberately safe, user-facing message. */
export class QuotaError extends Error {
  override name = "QuotaError";
}
