import type {
  Writable,
} from "node:stream";

import type {
  BackgroundTaskReporter,
} from "./background.js";

export interface BackgroundTerminalOutput
  extends Pick<
    Writable,
    "write"
  > {
  isTTY?: boolean;
}

export interface BackgroundTerminalReporterOptions {
  output:
    BackgroundTerminalOutput;

  isPromptActive():
    boolean;

  getCurrentInput():
    string;

  redrawPrompt?():
    void;

  isOutputActive?():
    boolean;

  promptText?:
    string;
}

export type BackgroundTerminalReporter =
  BackgroundTaskReporter & {
    flushPending():
      Promise<void>;
  };

const CLEAR_CURRENT_LINE =
  "\r\u001b[2K";

function normalizeCurrentInput(
  value: string,
): string {
  return typeof value ===
    "string"
    ? value
    : "";
}

export function createBackgroundTerminalReporter(
  options:
    BackgroundTerminalReporterOptions,
): BackgroundTerminalReporter {
  const promptText =
    options.promptText ??
    "You: ";

  const pendingLines:
    string[] = [];

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
