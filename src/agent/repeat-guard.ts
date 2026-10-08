/**
 * Repeated-action breaker for one agent turn.
 *
 * A model can get stuck requesting the exact same action over and over after
 * it has already failed, for example re-creating a file that the previous
 * attempt reported already exists. Each repeat is a real external call that
 * will fail the same way, and the loop would keep making them until its step
 * limit. This guard stops that, for every tool and every strategy, without
 * looking at which tool it is or which model is running:
 *
 * - "The same action" means the same tool name and the same arguments,
 *   compared exactly after normalization (object keys sorted at every
 *   level), never fuzzily.
 * - The first attempt always runs, and so does one identical repeat (a
 *   transient failure deserves one retry).
 * - Once that action has failed MAX_IDENTICAL_FAILURES times this turn with
 *   the same output, further identical requests are not executed. The loop
 *   still records the model's call and answers it with a tool result saying
 *   the action was not run and why, so native history stays canonical (every
 *   assistant tool call has a matching role:"tool" result) and the model can
 *   choose different arguments or another action.
 * - Successful actions and failures with differing outputs are never
 *   blocked here; the loop's own step limit still bounds them.
 *
 * Repetition is ordinary model behavior, not evidence about the protocol:
 * nothing here affects strategy selection or the Native -> Prompted fallback.
 */

/**
 * Real failed executions of one identical action that are allowed before
 * further identical requests are no longer executed: the first attempt plus
 * one identical repeat.
 */
export const MAX_IDENTICAL_FAILURES = 2;

/**
 * Serializes a value deterministically, with object keys sorted at every
 * level, so two argument objects that differ only in key order compare
 * equal.
 *
 * @param {unknown} value - Arguments (or any JSON-compatible value).
 * @returns {string} Canonical JSON text.
 *
 * Side effects: none.
 */
export function canonicalizeArguments(
  value: unknown,
): string {
  const normalize = (
    item: unknown,
  ): unknown => {
    if (Array.isArray(item)) {
      return item.map(normalize);
    }

    if (
      typeof item === "object" &&
      item !== null
    ) {
      const record =
        item as Record<string, unknown>;

      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map(
            (key) => [
              key,
              normalize(record[key]),
            ],
          ),
      );
    }

    return item;
  };

  return JSON.stringify(
    normalize(value) ?? null,
  );
}

/**
 * Outcome of checking one requested action.
 */
export type RepeatCheck =
  | {
      blocked: false;
    }
  | {
      blocked: true;
      /** Real failed executions of this identical action so far. */
      failures: number;
      /** The output those failures returned. */
      lastOutput: string;
    };

/**
 * Per-turn record of failed actions. Create one per agent turn.
 */
export class RepeatGuard {
  private failures =
    new Map<
      string,
      {
        count: number;
        lastOutput: string;
      }
    >();

  /**
   * Builds the identity key for one action.
   *
   * @param {string} tool - Tool name.
   * @param {unknown} args - Tool arguments.
   * @returns {string} The key.
   */
  private static key(
    tool: string,
    args: unknown,
  ): string {
    return `${tool}\u0000${canonicalizeArguments(args)}`;
  }

  /**
   * Decides whether a requested action may run.
   *
   * @param {string} tool - Tool name.
   * @param {unknown} args - Tool arguments as requested.
   * @returns {RepeatCheck} Blocked only once this identical action has
   * already failed MAX_IDENTICAL_FAILURES times with the same output.
   *
   * Side effects: none.
   */
  check(
    tool: string,
    args: unknown,
  ): RepeatCheck {
    const entry =
      this.failures.get(
        RepeatGuard.key(
          tool,
          args,
        ),
      );

    if (
      !entry ||
      entry.count <
        MAX_IDENTICAL_FAILURES
    ) {
      return {
        blocked: false,
      };
    }

    return {
      blocked: true,
      failures: entry.count,
      lastOutput: entry.lastOutput,
    };
  }

  /**
   * Records the real outcome of one executed action.
   *
   * A success clears the action's failure history. A failure whose output
   * differs from the previous failure restarts the count, so only a repeat
   * that reproduces the same failure moves the action toward being blocked.
   *
   * @param {string} tool - Tool name.
   * @param {unknown} args - Tool arguments as requested.
   * @param {boolean} success - Whether the execution succeeded.
   * @param {string} output - The execution's real output.
   * @returns {void} Nothing.
   *
   * Side effects: mutates this guard.
   */
  recordResult(
    tool: string,
    args: unknown,
    success: boolean,
    output: string,
  ): void {
    const key =
      RepeatGuard.key(
        tool,
        args,
      );

    if (success) {
      this.failures.delete(key);
      return;
    }

    const previous =
      this.failures.get(key);

    this.failures.set(
      key,
      {
        count:
          previous &&
          previous.lastOutput ===
            output
            ? previous.count + 1
            : 1,
        lastOutput: output,
      },
    );
  }
}

/**
 * Builds the tool result text returned to the model for a blocked repeat.
 *
 * @param {string} tool - Tool name.
 * @param {Extract<RepeatCheck, {blocked: true}>} check - The blocking check.
 * @returns {string} Plain explanation, including the real failure output.
 */
export function describeBlockedRepeat(
  tool: string,
  check: Extract<
    RepeatCheck,
    { blocked: true }
  >,
): string {
  return (
    `Not executed: this exact ${tool} call, with these same arguments, already failed ${check.failures} times in this turn with the same result, so running it again would fail the same way. ` +
    `Choose different arguments or a different action, or finish and report the failure. ` +
    `The failure was: ${check.lastOutput}`
  );
}
