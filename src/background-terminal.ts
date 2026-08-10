/**
 * Terminal-safe reporting for Sky Code background-task lifecycle updates.
 *
 * This module adapts BackgroundTaskReporter output to an interactive terminal.
 * It avoids overwriting an active prompt, can defer task lines while other
 * terminal output is in progress, restores the prompt after task output, and
 * exposes flushPending() for replaying queued status lines when output is idle.
 */
import type {
  Writable,
} from "node:stream";

import type {
  BackgroundTaskReporter,
} from "./background.js";

/**
 * Minimal writable terminal surface required by the background reporter.
 *
 * Only Writable.write() is required. isTTY optionally enables ANSI line-clearing
 * behavior when an interactive prompt is currently visible.
 */
export interface BackgroundTerminalOutput
  extends Pick<
    Writable,
    "write"
  > {
  /** Whether the output supports TTY-specific line control. */
  isTTY?: boolean;
}

/**
 * Terminal state and callbacks used to render background-task updates safely.
 */
export interface BackgroundTerminalReporterOptions {
  /** Destination stream for task status and prompt restoration output. */
  output:
    BackgroundTerminalOutput;

  /** Reports whether the interactive input prompt is currently displayed. */
  isPromptActive():
    boolean;

  /** Returns the user's current, not-yet-submitted prompt input. */
  getCurrentInput():
    string;

  /** Optional prompt-aware redraw callback preferred over manual reconstruction. */
  redrawPrompt?():
    void;

  /** Reports whether other terminal output is active and task lines should queue. */
  isOutputActive?():
    boolean;

  /** Prompt prefix used when no custom redraw callback is available. */
  promptText?:
    string;
}

/**
 * Callable background-task reporter extended with queued-output flushing.
 */
export type BackgroundTerminalReporter =
  BackgroundTaskReporter & {
    /** Writes queued task lines once competing terminal output is inactive. */
    flushPending():
      Promise<void>;
  };

/**
 * ANSI sequence that returns to column zero and clears the current terminal line.
 *
 * It is emitted only when output explicitly reports isTTY === true.
 */
const CLEAR_CURRENT_LINE =
  "\r\u001b[2K";

/**
 * Defensively normalizes the current prompt input before reconstructing a prompt.
 *
 * @param {string} value - Current input value returned by the host terminal.
 * @returns {string} The supplied string, or an empty string if a non-string
 * runtime value is encountered.
 */
function normalizeCurrentInput(
  value: string,
): string {
  return typeof value ===
    "string"
    ? value
    : "";
}

/**
 * Creates a background-task reporter that coexists with interactive terminal UI.
 *
 * Status lines are written immediately when no competing output is active.
 * Otherwise they are queued until flushPending() is called while output is idle.
 *
 * When a prompt is visible, TTY output first clears its current line; non-TTY
 * output inserts a newline instead. After task lines are written, a supplied
 * redrawPrompt callback is preferred. Without one, the reporter reconstructs
 * the prompt from promptText (default `You: `) and getCurrentInput().
 *
 * @param {BackgroundTerminalReporterOptions} options - Terminal output and state
 * callbacks used by the reporter.
 * @returns {BackgroundTerminalReporter} Callable lifecycle reporter with a
 * flushPending() method.
 * @throws {Error} If supplied terminal callbacks or output.write() throw.
 *
 * Side effects: writes terminal output and retains queued lifecycle lines until
 * they can be flushed.
 */
export function createBackgroundTerminalReporter(
  options:
    BackgroundTerminalReporterOptions,
): BackgroundTerminalReporter {
  const promptText =
    options.promptText ??
    "You: ";

  const pendingLines:
    string[] = [];

  /**
   * Writes one or more task lines while preserving an active prompt.
   *
   * @param {readonly string[]} lines - Status lines to render in order.
   * @returns {void}
   *
   * Side effects: may clear a TTY line, write task output, redraw the prompt, or
   * reconstruct the prompt and current input.
   */
  function writeLines(
    lines:
      readonly string[],
  ): void {
    if (
      lines.length ===
        0
    ) {
      return;
    }

    const promptActive =
      options.isPromptActive();

    if (
      promptActive
    ) {
      if (
        options.output
          .isTTY ===
        true
      ) {
        options.output.write(
          CLEAR_CURRENT_LINE,
        );
      } else {
        options.output.write(
          "\n",
        );
      }
    }

    options.output.write(
      `${lines.join("\n")}\n`,
    );

    if (
      promptActive
    ) {
      if (
        options.redrawPrompt
      ) {
        options.redrawPrompt();
        return;
      }

      const currentInput =
        normalizeCurrentInput(
          options.getCurrentInput(),
        );

      options.output.write(
        `${promptText}${currentInput}`,
      );
    }
  }

  /**
   * Reporter callback used by BackgroundTaskRegistry lifecycle events.
   *
   * If other terminal output is active, the line is queued rather than written
   * immediately so concurrent output is not visually interleaved.
   *
   * @param {string} line - Formatted background-task status line.
   * @returns {Promise<void>} Resolves after the line is queued or written.
   *
   * Side effects: queues the line or writes it to the configured output.
   */
  const report:
    BackgroundTaskReporter =
    async (
      line,
    ): Promise<void> => {
      if (
        options.isOutputActive
          ?.() ===
        true
      ) {
        pendingLines.push(
          line,
        );

        return;
      }

      writeLines([
        line,
      ]);
    };

  /**
   * Flushes all queued task lines when competing terminal output is inactive.
   *
   * The queue is drained with splice() before rendering, preserving arrival
   * order and preventing already-flushed lines from being emitted again.
   *
   * @returns {Promise<void>} Resolves after pending lines are written, or
   * immediately when other output remains active.
   *
   * Side effects: drains pendingLines and may write/redraw terminal output.
   */
  async function flushPending():
    Promise<void> {
    if (
      options.isOutputActive
        ?.() ===
      true
    ) {
      return;
    }

    const lines =
      pendingLines.splice(
        0,
        pendingLines.length,
      );

    writeLines(
      lines,
    );
  }

  return Object.assign(
    report,
    {
      flushPending,
    },
  );
}
