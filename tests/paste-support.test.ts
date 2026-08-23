import {
  PassThrough,
  Writable,
} from "node:stream";

import {
  emitKeypressEvents,
} from "node:readline";

import {
  createInterface,
} from "node:readline/promises";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  PASTE_NEWLINE_PLACEHOLDER,
  disableBracketedPaste,
  enableBracketedPaste,
  questionWithPasteSupport,
} from "../src/paste-support.ts";

function createFakeOutput():
  {
    output: NodeJS.WriteStream;
    written: string[];
  } {
  const written: string[] =
    [];

  const output = {
    write: (
      chunk: string,
    ) => {
      written.push(
        chunk,
      );

      return true;
    },
  } as unknown as NodeJS.WriteStream;

  return {
    output,
    written,
  };
}

describe(
  "enableBracketedPaste / disableBracketedPaste",
  () => {
    it(
      "writes the correct ANSI escape sequences",
      () => {
        const {
          output,
          written,
        } =
          createFakeOutput();

        enableBracketedPaste(
          output,
        );

        disableBracketedPaste(
          output,
        );

        expect(
          written,
        ).toEqual([
          "\x1b[?2004h",
          "\x1b[?2004l",
        ]);
      },
    );
  },
);

/**
 * Builds a PassThrough stream with keypress events enabled, feeding it
 * through the same low-level parser Node's real readline module uses.
 * This exercises the actual paste-start/paste-end keypress detection
 * rather than mocking it, matching the manual verification already done
 * against a real TTY on the target machine.
 */
function createFakeOutputStream():
  {
    output: NodeJS.WriteStream;
    writtenToOutput: string[];
  } {
  const writtenToOutput: string[] =
    [];

  const output =
    new Writable({
      write(
        chunk,
        _encoding,
        callback,
      ) {
        writtenToOutput.push(
          chunk.toString(),
        );

        callback();
      },
    }) as unknown as NodeJS.WriteStream;

  (
    output as unknown as {
      isTTY: boolean;
      columns: number;
    }
  ).isTTY = true;

  (
    output as unknown as {
      isTTY: boolean;
      columns: number;
    }
  ).columns = 80;

  return {
    output,
    writtenToOutput,
  };
}

function createFakeTerminal():
  {
    input: NodeJS.ReadStream;
    output: NodeJS.WriteStream;
    writtenToOutput: string[];
  } {
  const input =
    new PassThrough() as unknown as NodeJS.ReadStream;

  // readline.Interface only uses its interactive, keypress-event-driven
  // code path when it believes its input is a TTY; otherwise it falls back
  // to simple non-interactive line splitting on raw '\n' bytes, which is a
  // different code path entirely and would not exercise (or validate) the
  // fix this test suite is for. Forcing isTTY mirrors the real terminal
  // this module is written for.
  (
    input as unknown as {
      isTTY: boolean;
    }
  ).isTTY = true;

  emitKeypressEvents(
    input as unknown as NodeJS.ReadableStream,
  );

  const {
    output,
    writtenToOutput,
  } =
    createFakeOutputStream();

  return {
    input,
    output,
    writtenToOutput,
  };
}

function feedPastedText(
  input: NodeJS.ReadStream,
  pastedText: string,
): void {
  (
    input as unknown as PassThrough
  ).write(
    "\x1b[200~" +
      pastedText +
      "\x1b[201~",
  );
}

function feedTypedText(
  input: NodeJS.ReadStream,
  typedText: string,
): void {
  (
    input as unknown as PassThrough
  ).write(
    typedText,
  );
}

function wait(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds,
      ),
  );
}

describe(
  "questionWithPasteSupport",
  () => {
    it(
      "preserves embedded newlines from a pasted multi-line block instead of submitting early",
      async () => {
        const {
          input,
          output,
        } =
          createFakeTerminal();

        const rl =
          createInterface({
            input:
              input as unknown as NodeJS.ReadableStream,
            output,
          });

        const answerPromise =
          questionWithPasteSupport(
            rl,
            input,
            "> ",
          );

        feedPastedText(
          input,
          "line one\nline two\nline three",
        );

        await wait(
          20,
        );

        feedTypedText(
          input,
          "\r",
        );

        const answer =
          await answerPromise;

        expect(
          answer,
        ).toBe(
          "line one\nline two\nline three",
        );

        rl.close();
      },
    );

    it(
      "still allows typing more before submitting after a paste completes",
      async () => {
        const {
          input,
          output,
        } =
          createFakeTerminal();

        const rl =
          createInterface({
            input:
              input as unknown as NodeJS.ReadableStream,
            output,
          });

        const answerPromise =
          questionWithPasteSupport(
            rl,
            input,
            "> ",
          );

        feedPastedText(
          input,
          "pasted part",
        );

        await wait(
          20,
        );

        feedTypedText(
          input,
          " typed after\r",
        );

        const answer =
          await answerPromise;

        expect(
          answer,
        ).toBe(
          "pasted part typed after",
        );

        rl.close();
      },
    );

    it(
      "does not leak the placeholder character into the final answer",
      async () => {
        const {
          input,
          output,
        } =
          createFakeTerminal();

        const rl =
          createInterface({
            input:
              input as unknown as NodeJS.ReadableStream,
            output,
          });

        const answerPromise =
          questionWithPasteSupport(
            rl,
            input,
            "> ",
          );

        feedPastedText(
          input,
          "a\nb",
        );

        await wait(
          20,
        );

        feedTypedText(
          input,
          "\r",
        );

        const answer =
          await answerPromise;

        expect(
          answer,
        ).not.toContain(
          PASTE_NEWLINE_PLACEHOLDER,
        );

        rl.close();
      },
    );

    it(
      "behaves like a plain question() when no paste occurs",
      async () => {
        const {
          input,
          output,
        } =
          createFakeTerminal();

        const rl =
          createInterface({
            input:
              input as unknown as NodeJS.ReadableStream,
            output,
          });

        const answerPromise =
          questionWithPasteSupport(
            rl,
            input,
            "> ",
          );

        feedTypedText(
          input,
          "just typed normally\r",
        );

        const answer =
          await answerPromise;

        expect(
          answer,
        ).toBe(
          "just typed normally",
        );

        rl.close();
      },
    );
  },
);
