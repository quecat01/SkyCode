/**
 * Turn cancellation (the user pressing Ctrl+C while Sky Code is working).
 *
 * A turn is cancelled through one AbortSignal, owned by index.ts and created
 * fresh for each turn. It is threaded through every place a turn waits: the
 * agent loop between steps, each strategy's model requests (including
 * corrective retries), the final-answer request, and the boundary where a
 * tool is about to start. A cancelled turn:
 * - aborts any in-flight model request immediately;
 * - never starts another tool (a tool that is already running is allowed to
 *   finish, so a file is never left half-written; its real result is still
 *   recorded, but the model is never called again);
 * - ends with a distinct "cancelled" outcome, never recorded as an ordinary
 *   tool failure.
 *
 * Ctrl+C inside an interactive approval prompt reaches Sky Code differently:
 * the prompt library handles the keypress itself and rejects with its own
 * error rather than delivering a signal. isTurnCancellation() treats that
 * the same way, since it is the same user intent.
 */

/**
 * Thrown where a turn notices it has been cancelled (in place of starting
 * more work), so callers can tell cancellation apart from a real failure.
 */
export class TurnCancelledError extends Error {
  constructor() {
    super(
      "The turn was cancelled.",
    );

    this.name =
      "TurnCancelledError";
  }
}

/**
 * Error names that mean the user cancelled, whatever layer reported it:
 * Sky Code's own TurnCancelledError, fetch's AbortError for an aborted
 * request, and the prompt library's errors for Ctrl+C or an abort inside an
 * approval prompt.
 */
const CANCELLATION_ERROR_NAMES: ReadonlySet<string> =
  new Set([
    "TurnCancelledError",
    "AbortError",
    "ExitPromptError",
    "AbortPromptError",
  ]);

/**
 * Decides whether a thrown error, or the turn's signal, means the turn was
 * cancelled rather than that something genuinely failed.
 *
 * @param {unknown} error - Anything thrown while the turn was working.
 * @param {AbortSignal} [signal] - The turn's cancellation signal.
 * @returns {boolean} True when the signal is aborted, or the error is one of
 * the recognized cancellation errors.
 *
 * Side effects: none.
 */
export function isTurnCancellation(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    CANCELLATION_ERROR_NAMES.has(
      String(
        (error as { name?: unknown }).name,
      ),
    )
  );
}

/**
 * Throws TurnCancelledError if the signal has been aborted; used right
 * before starting any new unit of work.
 *
 * @param {AbortSignal} [signal] - The turn's cancellation signal.
 * @returns {void} Nothing when the turn is still active.
 * @throws {TurnCancelledError} If the turn was cancelled.
 */
export function throwIfCancelled(
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw new TurnCancelledError();
  }
}
