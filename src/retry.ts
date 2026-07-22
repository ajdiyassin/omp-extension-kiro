// ABOUTME: Stream recovery helpers and Kiro-specific error classification.
// ABOUTME: Keeps provider-local retry logic limited to auth refresh and stream quirks.

// kiro-cli uses 5-minute read/operation timeouts (DEFAULT_TIMEOUT_DURATION)
// and 5-minute stalled stream grace period. 90s matches the TUI's
// INITIAL_RESPONSE_TIMEOUT_MS for the first event from the backend.
export const FIRST_TOKEN_TIMEOUT = 90_000;

export function firstTokenTimeout(): number {
  return retryConfig.firstTokenTimeoutMs;
}

// Mutable config for values that tests need to override
export const retryConfig = {
  firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT,
};

export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

export const MAX_RETRY_DELAY = 10_000;

export const TOO_BIG_PATTERNS = ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "Input is too long"];
// Schema/validation rejections from the Kiro runtime. "Improperly formed" used to
// live in TOO_BIG_PATTERNS, which mislabeled request-schema errors as context overflow
// and silently triggered compaction instead of surfacing the real validation failure.
const REQUEST_BODY_INVALID_PATTERNS = ["REQUEST_BODY_INVALID", "Improperly formed"];
const NON_RETRYABLE_BODY_PATTERNS = ["MONTHLY_REQUEST_COUNT"];
const CAPACITY_PATTERN = "INSUFFICIENT_MODEL_CAPACITY";
export const CAPACITY_MAX_RETRIES = 3;
export const CAPACITY_BASE_DELAY_MS = 5_000;

// Mutable capacity config for testing
export const capacityRetryConfig = {
  maxRetries: CAPACITY_MAX_RETRIES,
  baseDelayMs: CAPACITY_BASE_DELAY_MS,
};

/** Check whether an HTTP error represents a "request too large" condition. */
export function isTooBigError(status: number, errorText: string): boolean {
  return status === 413 || (status === 400 && TOO_BIG_PATTERNS.some((p) => errorText.includes(p)));
}

/**
 * Check whether a 400 represents a request-schema/validation rejection
 * (e.g. an unaccepted additionalModelRequestFields shape) rather than a size
 * problem. Must be tested AFTER isTooBigError so genuine overflow still wins.
 */
export function isRequestBodyInvalidError(status: number, errorText: string): boolean {
  return status === 400 && REQUEST_BODY_INVALID_PATTERNS.some((p) => errorText.includes(p));
}

/** Check whether the response body contains a Kiro-specific non-retryable marker. */
export function isNonRetryableBodyError(errorText: string): boolean {
  return NON_RETRYABLE_BODY_PATTERNS.some((p) => errorText.includes(p));
}

/** Check whether the error is a transient capacity issue worth retrying. */
export function isCapacityError(errorText: string): boolean {
  return errorText.includes(CAPACITY_PATTERN);
}
