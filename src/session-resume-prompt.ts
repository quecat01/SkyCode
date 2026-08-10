/**
 * Interactive resume-or-start-fresh prompt helpers for Sky Code.
 *
 * Formats the summary shown when a resumable session is found, parses the
 * accepted resume/fresh selections, and drives the retrying prompt loop through
 * an injected I/O interface.
 *
 * Keeping terminal I/O behind SessionResumePromptIO allows the decision flow to
 * be reused and tested without depending directly on readline or stdout.
 */
import type {
  ResumableSession,
} from "./session-resume.js";

/**
 * User decision after Sky Code discovers a resumable previous session.
 *
 * `resume` continues with reconstructed conversation state, while `fresh`
 * starts without that previous conversation.
 */
export type SessionResumeDecision =
  | "resume"
  | "fresh";

/**
 * Minimal asynchronous input/output contract required by the session-resume
 * prompt.
 *
 * Callers provide the concrete terminal or test implementation.
 */
export interface SessionResumePromptIO {
  /**
   * Requests one line of user input.
   *
   * @param {string} prompt - Prompt text presented to the user.
   * @returns {Promise<string>} Raw response entered by the user.
   *
   * Side effect: implementation may display a prompt and wait for input.
   */
  question(
    prompt:
      string,
  ): Promise<string>;

  /**
   * Writes one display line.
   *
   * @param {string} line - Text to display; an empty string represents a blank
   * separator line.
   * @returns {void}
   *
   * Side effect: implementation may write to a terminal or other output sink.
   */
  write(
    line:
      string,
  ): void;
}

/**
 * Builds the lines displayed before asking whether to resume a session.
 *
 * The summary shows the last persisted update time, reconstructed conversation
 * message count, previous model when known, and the two numbered choices.
 *
 * @param {ResumableSession} session - Reconstructed session offered for resume.
 * @returns {string[]} Display lines in presentation order.
 */
export function formatResumableSessionSummary(
  session:
    ResumableSession,
): string[] {
  return [
    "Previous Sky Code session found for this directory.",
    `Last updated: ${session.updatedAt}`,
    `Stored conversation messages: ${session.messages.length}`,
    `Previous model: ${session.model ?? "unknown"}`,
    "",
    "1. Resume the previous session",
    "2. Start fresh",
  ];
}

/**
 * Parses a resume-prompt response into a session decision.
 *
 * Input is trimmed and compared case-insensitively. `1`, `r`, and `resume`
 * select resume. `2`, `f`, and `fresh` select fresh. Empty input also selects
 * fresh, matching the `[2]` default displayed by the interactive prompt.
 *
 * @param {string} value - Raw user selection.
 * @returns {SessionResumeDecision | null} Parsed decision, or null when the
 * selection is not recognized.
 */
export function parseSessionResumeSelection(
  value:
    string,
): SessionResumeDecision | null {
  // Normalize whitespace and case so textual shortcuts work consistently.
  const normalizedValue =
    value
      .trim()
      .toLowerCase();

  if (
    normalizedValue ===
      "1" ||
    normalizedValue ===
      "r" ||
    normalizedValue ===
      "resume"
  ) {
    return "resume";
  }

  // Empty input intentionally accepts the prompt's default choice: fresh.
  if (
    normalizedValue ===
      "" ||
    normalizedValue ===
      "2" ||
    normalizedValue ===
      "f" ||
    normalizedValue ===
      "fresh"
  ) {
    return "fresh";
  }

  return null;
}

/**
 * Displays a resumable-session summary and asks the user whether to resume it.
 *
 * Invalid responses produce an explanatory message and repeat the prompt until
 * parseSessionResumeSelection() returns a valid decision. Because empty input
 * parses as `fresh`, pressing Enter accepts the displayed default.
 *
 * @param {ResumableSession} session - Previous session being offered.
 * @param {SessionResumePromptIO} io - Input/output implementation used for the
 * interaction.
 * @returns {Promise<SessionResumeDecision>} Final resume-or-fresh decision.
 *
 * Side effects: writes summary, prompt, and validation text through io and
 * waits for user input through io.question().
 */
export async function promptForSessionResume(
  session:
    ResumableSession,

  io:
    SessionResumePromptIO,
): Promise<SessionResumeDecision> {
  io.write(
    "",
  );

  // Write the preformatted lines individually so the I/O implementation owns
  // the actual output mechanism.
  for (
    const line of
    formatResumableSessionSummary(
      session,
    )
  ) {
    io.write(
      line,
    );
  }

  io.write(
    "",
  );

  // Invalid input is recoverable; keep asking until parsing yields a decision.
  while (
    true
  ) {
    // The visible [2] default is implemented by parsing an empty response as
    // `fresh` rather than substituting text before parsing.
    const answer =
      await io.question(
        "Enter 1 to resume, or 2 to start fresh [2]: ",
      );

    const decision =
      parseSessionResumeSelection(
        answer,
      );

    if (
      decision !==
        null
    ) {
      return decision;
    }

    // Give corrective guidance before the loop asks the same question again.
    io.write(
      "Invalid selection. Enter 1 to resume or 2 to start fresh.",
    );
  }
}
