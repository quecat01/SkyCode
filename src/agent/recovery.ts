/**
 * Generic handling of safely recoverable tool failures.
 *
 * A tool may mark one of its own failures as recoverable when it knows a
 * retry that changes nothing existing: for example, a document tool whose
 * output path already exists suggests an unused filename (see
 * ToolExecutionResult in tools.ts). The agent side never knows which tool or
 * which failure that is. It only:
 * - carries the metadata through native and plain history, so the model sees
 *   a concrete next action (describeRecovery());
 * - lets the repeated-action breaker repeat it when it blocks a call
 *   (repeat-guard.ts);
 * - detects when a turn is about to end with such a recovery still unused,
 *   so NativeStrategy can point it out once (findUnresolvedSafeRecovery()).
 *
 * Sky Code never executes a suggested retry itself; the model still has to
 * make the next real tool call. Only failures explicitly marked
 * `recoverable: true` with `suggestedArguments` count: a destructive,
 * ambiguous, or authorization-dependent failure is never marked, so it is
 * never pushed toward a retry.
 */
import {
  canonicalizeArguments,
} from "./canonical-json.js";

import type {
  AgentEvent,
} from "./types.js";

/**
 * A safe recovery a tool attached to one of its failures.
 */
export interface SafeRecovery {
  errorCode?: string;
  recoveryHint?: string;
  /** Only the argument fields to change; every other argument stays. */
  suggestedArguments: Record<string, unknown>;
}

/**
 * Extracts a safe recovery from a failure result or tool_result event.
 *
 * @param {object} source - Anything carrying the optional recovery fields.
 * @returns {SafeRecovery | undefined} The recovery, only when it is marked
 * recoverable and has suggested arguments.
 *
 * Side effects: none.
 */
export function extractSafeRecovery(
  source: {
    success?: boolean;
    errorCode?: string;
    recoverable?: boolean;
    recoveryHint?: string;
    suggestedArguments?: Record<string, unknown>;
  },
): SafeRecovery | undefined {
  if (
    source.success === true ||
    source.recoverable !== true ||
    source.suggestedArguments === undefined ||
    Object.keys(source.suggestedArguments).length === 0
  ) {
    return undefined;
  }

  return {
    ...(source.errorCode !== undefined
      ? {
          errorCode: source.errorCode,
        }
      : {}),
    ...(source.recoveryHint !== undefined
      ? {
          recoveryHint: source.recoveryHint,
        }
      : {}),
    suggestedArguments:
      source.suggestedArguments,
  };
}

/**
 * Renders the changed fields of a suggested retry, e.g. `path = "a_2.docx"`.
 *
 * @param {Record<string, unknown>} suggestedArguments - Fields to change.
 * @returns {string} Comma-separated `field = value` pairs.
 */
export function describeSuggestedChanges(
  suggestedArguments: Record<string, unknown>,
): string {
  return Object.entries(
    suggestedArguments,
  )
    .map(
      ([field, value]) =>
        `${field} = ${JSON.stringify(value)}`,
    )
    .join(", ");
}

/**
 * Builds the actionable recovery text shown to the model after a
 * recoverable failure.
 *
 * @param {string} tool - The tool that failed.
 * @param {SafeRecovery} recovery - Its recovery.
 * @returns {string} Plain instructions naming the exact retry.
 */
export function describeRecovery(
  tool: string,
  recovery: SafeRecovery,
): string {
  // The tool's own hint, when it gave one, already says how to proceed; the
  // generic continuation sentence is only added when it did not.
  return [
    "This failure is recoverable.",
    recovery.recoveryHint,
    `Suggested retry: ${tool} with the same arguments, changing: ${describeSuggestedChanges(recovery.suggestedArguments)}.`,
    recovery.recoveryHint === undefined
      ? "Continue the remaining requested work without asking the user, unless the user explicitly required the original value."
      : undefined,
  ]
    .filter(
      (part): part is string =>
        part !== undefined && part !== "",
    )
    .join(" ");
}

/**
 * Returns a copy of an arguments object without the given fields.
 *
 * @param {unknown} args - Tool arguments.
 * @param {readonly string[]} fields - Fields to drop.
 * @returns {unknown} The reduced arguments (non-objects unchanged).
 */
function withoutFields(
  args: unknown,
  fields: readonly string[],
): unknown {
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args)
  ) {
    return args;
  }

  return Object.fromEntries(
    Object.entries(
      args as Record<string, unknown>,
    ).filter(
      ([key]) =>
        !fields.includes(key),
    ),
  );
}

/**
 * Finds a safe recovery from this turn that has not been resolved yet.
 *
 * A recoverable failure counts as resolved once a later call to the same
 * tool succeeded with the same arguments apart from the fields the recovery
 * suggested changing. That covers the model using the suggestion or its own
 * equivalent (a different new filename), without treating an unrelated
 * success of the same tool as resolving it.
 *
 * @param {readonly AgentEvent[]} history - This turn's recorded events.
 * @returns {{tool: string, recovery: SafeRecovery} | undefined} The first
 * unresolved safe recovery, if any.
 *
 * Side effects: none.
 */
export function findUnresolvedSafeRecovery(
  history: readonly AgentEvent[],
):
  | {
      tool: string;
      recovery: SafeRecovery;
    }
  | undefined {
  const requests =
    new Map<
      string,
      {
        tool: string;
        arguments: unknown;
      }
    >();

  const results: {
    tool: string;
    arguments: unknown;
    success: boolean;
    recovery?: SafeRecovery;
  }[] = [];

  for (
    const event of history
  ) {
    if (event.type === "tool_requested") {
      requests.set(
        event.callId,
        {
          tool: event.tool,
          arguments: event.arguments,
        },
      );
      continue;
    }

    if (
      event.type !== "tool_result" ||
      event.notExecuted
    ) {
      continue;
    }

    const request =
      requests.get(
        event.callId,
      );

    if (!request) {
      continue;
    }

    const recovery =
      extractSafeRecovery(
        event,
      );

    results.push({
      tool: request.tool,
      arguments: request.arguments,
      success: event.success,
      ...(recovery
        ? {
            recovery,
          }
        : {}),
    });
  }

  for (
    let index = 0;
    index < results.length;
    index += 1
  ) {
    const failure =
      results[index]!;

    if (!failure.recovery) {
      continue;
    }

    const changed =
      Object.keys(
        failure.recovery.suggestedArguments,
      );

    const wanted =
      canonicalizeArguments(
        withoutFields(
          failure.arguments,
          changed,
        ),
      );

    const resolved =
      results
        .slice(index + 1)
        .some(
          (later) =>
            later.success &&
            later.tool === failure.tool &&
            canonicalizeArguments(
              withoutFields(
                later.arguments,
                changed,
              ),
            ) === wanted,
        );

    if (!resolved) {
      return {
        tool: failure.tool,
        recovery: failure.recovery,
      };
    }
  }

  return undefined;
}
