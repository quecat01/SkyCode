import {
  type Interface as ReadlineInterface,
} from "node:readline/promises";

/**
 * Placeholder character substituted for a literal embedded newline while
 * pasted text is still being composed in the (fundamentally single-line)
 * readline buffer. Converted back to a real newline in
 * {@link questionWithPasteSupport} immediately before the line is treated
 * as submitted.
 *
 * U+2424 (SYMBOL FOR NEWLINE, "␤") is used because it is vanishingly
 * unlikely to appear in real pasted text. There is a small residual risk:
 * if pasted text genuinely contains this exact character, it would be
 * misread as a newline on submit.
 */
export const PASTE_NEWLINE_PLACEHOLDER =
  "\u2424";

/**
 * Enables bracketed paste mode on the terminal.
 *
 * Once enabled, the terminal wraps pasted content in `ESC[200~` /
 * `ESC[201~` markers, which Node's keypress parser surfaces as distinct
 * `paste-start` / `paste-end` keypress events. This is what makes it
 * possible to tell a genuine paste apart from fast typing.
 *
 * @param {NodeJS.WriteStream} output - The terminal's output stream.
 * @returns {void}
 * Side effects: writes an ANSI escape sequence to `output`.
 */
export function enableBracketedPaste(
  output: NodeJS.WriteStream,
): void {
  output.write(
    "\x1b[?2004h",
  );
}

/**
 * Disables bracketed paste mode on the terminal.
 *
 * Must be called before Sky Code exits so the terminal does not stay in
 * bracketed paste mode afterward (which would otherwise wrap pastes made
 * into the shell prompt in literal marker sequences). This is only called
 * from Sky Code's own normal/expected shutdown paths; an uncaught
 * exception or an external `kill` bypassing those paths could still leave
 * the terminal in bracketed paste mode, a known, narrow residual risk.
 *
 * @param {NodeJS.WriteStream} output - The terminal's output stream.
 * @returns {void}
 * Side effects: writes an ANSI escape sequence to `output`.
 */
export function disableBracketedPaste(
  output: NodeJS.WriteStream,
): void {
  output.write(
    "\x1b[?2004l",
  );
}

type KeypressListener = (
  ...args: unknown[]
) => void;

/**
 * Reads one line of user input the same way `readline.question()` does,
 * but additionally handles multi-line pasted text correctly.
 *
 * Node's `readline` module has no built-in support for multi-line paste:
 * every `\n` it receives, including ones inside a pasted block, is treated
 * identically to the user pressing Enter. In a real terminal this means
 * only the first pasted line is ever submitted, and the remaining lines
 * are misinterpreted (commonly leaking past the process entirely and
 * being executed as separate shell commands once Sky Code's readline call
 * resolves). This has been verified directly against Node v24 on a real
 * TTY, not assumed.
 *
 * This works around that by:
 * 1. Relying on bracketed paste mode (see {@link enableBracketedPaste})
 *    so the terminal wraps pasted content in `paste-start` / `paste-end`
 *    keypress events.
 * 2. Detaching every other 'keypress' listener on `input` (in practice,
 *    readline's own internal handler) for the duration of a paste, since
 *    readline provides no public way to tell it "ignore this one
 *    keypress," and it would otherwise submit on the pasted newline
 *    before this function gets a chance to react. This relies on how
 *    Node's readline module currently attaches its internal listener; it
 *    is not a behavior Node formally guarantees as stable API.
 * 3. Manually inserting pasted characters into the line via the
 *    interface's own `write()` method (a stable, public API), substituting
 *    each embedded newline with {@link PASTE_NEWLINE_PLACEHOLDER} so
 *    readline's own single-line cursor/redraw logic stays intact.
 * 4. Restoring the detached listener(s) once the paste ends, so normal
 *    typing and editing resume exactly as before, and the user can still
 *    add to or edit the pasted text before pressing Enter for real.
 *
 * @param {ReadlineInterface} rl - The active readline interface.
 * @param {NodeJS.ReadStream} input - The same input stream `rl` was
 * created with. Passed separately because `readline.Interface` does not
 * publicly expose its input stream.
 * @param {string} promptLabel - Prompt text shown before the cursor.
 * @returns {Promise<string>} The submitted line, trimmed the same way
 * `readline.question()` is used elsewhere, with any placeholder
 * characters converted back to real newlines.
 *
 * Side effects: temporarily removes and re-adds 'keypress' listener(s) on
 * `input`; writes to the terminal via `rl.write()`.
 */
export async function questionWithPasteSupport(
  rl: ReadlineInterface,
  input: NodeJS.ReadStream,
  promptLabel: string,
): Promise<string> {
  let inPaste = false;

  let detachedListeners: KeypressListener[] =
    [];

  const onKeypress = (
    str: string | undefined,
    key:
      | {
          name?: string;
          sequence?: string;
        }
      | undefined,
  ): void => {
    if (
      key?.name ===
      "paste-start"
    ) {
      inPaste = true;

      detachedListeners =
        input
          .listeners(
            "keypress",
          )
          .filter(
            (listener) =>
              listener !==
              onKeypress,
          ) as KeypressListener[];

      for (const listener of detachedListeners) {
        input.removeListener(
          "keypress",
          listener,
        );
      }

      return;
    }

    if (
      key?.name ===
      "paste-end"
    ) {
      inPaste = false;

      for (const listener of detachedListeners) {
        input.on(
          "keypress",
          listener,
        );
      }

      detachedListeners = [];

      return;
    }

    if (!inPaste) {
      // Not part of a paste: the detached listener (readline's own, in
      // practice) is still attached and handles this keypress normally.
      return;
    }

    const isEnterKey =
      key?.name === "enter" ||
      key?.name === "return";

    rl.write(
      isEnterKey
        ? PASTE_NEWLINE_PLACEHOLDER
        : (key?.sequence ??
            str ??
            ""),
    );
  };

  input.on(
    "keypress",
    onKeypress,
  );

  try {
    const rawAnswer =
      await rl.question(
        promptLabel,
      );

    return rawAnswer
      .replaceAll(
        PASTE_NEWLINE_PLACEHOLDER,
        "\n",
      )
      .trim();
  } finally {
    input.removeListener(
      "keypress",
      onKeypress,
    );
  }
}
