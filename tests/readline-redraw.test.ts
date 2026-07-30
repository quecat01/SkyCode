import {
  createInterface,
} from "node:readline/promises";

import {
  PassThrough,
} from "node:stream";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  redrawReadlinePrompt,
  restoreReadlineRawMode,
  type ReadlinePromptRedrawTarget,
} from "../src/readline-redraw.ts";

describe(
  "readline prompt redraw",
  () => {
    it(
      "invokes the refresh-line symbol when available",
      () => {
        const refreshSymbol =
          Symbol(
            "_refreshLine",
          );

        let refreshCount =
          0;

        let promptCount =
          0;

        const prototype = {
          [refreshSymbol]():
            void {
            refreshCount +=
              1;
          },
        };

        const target =
          Object.assign(
            Object.create(
              prototype,
            ) as
              ReadlinePromptRedrawTarget,
            {
              prompt():
                void {
                promptCount +=
                  1;
              },
            },
          );

        expect(
          redrawReadlinePrompt(
            target,
          ),
        ).toBe(
          "refresh-symbol",
        );

        expect(
          refreshCount,
        ).toBe(
          1,
        );

        expect(
          promptCount,
        ).toBe(
          0,
        );
      },
    );

    it(
      "finds the refresh symbol higher in the prototype chain",
      () => {
        const refreshSymbol =
          Symbol(
            "_refreshLine",
          );

        let refreshCount =
          0;

        const grandparent = {
          [refreshSymbol]():
            void {
            refreshCount +=
              1;
          },
        };

        const parent =
          Object.create(
            grandparent,
          );

        const target =
          Object.assign(
            Object.create(
              parent,
            ) as
              ReadlinePromptRedrawTarget,
            {
              prompt():
                void {
                throw new Error(
                  "Public fallback should not run.",
                );
              },
            },
          );

        expect(
          redrawReadlinePrompt(
            target,
          ),
        ).toBe(
          "refresh-symbol",
        );

        expect(
          refreshCount,
        ).toBe(
          1,
        );
      },
    );

    it(
      "falls back to prompt with cursor preservation",
      () => {
        const promptArguments:
          Array<
            boolean |
            undefined
          > = [];

        const target:
          ReadlinePromptRedrawTarget = {
          prompt(
            preserveCursor?,
          ): void {
            promptArguments.push(
              preserveCursor,
            );
          },
        };

        expect(
          redrawReadlinePrompt(
            target,
          ),
        ).toBe(
          "prompt",
        );

        expect(
          promptArguments,
        ).toEqual([
          true,
        ]);
      },
    );

    it(
      "uses the public fallback when the refresh method fails",
      () => {
        const refreshSymbol =
          Symbol(
            "_refreshLine",
          );

        const promptArguments:
          Array<
            boolean |
            undefined
          > = [];

        const prototype = {
          [refreshSymbol]():
            void {
            throw new Error(
              "Refresh failed.",
            );
          },
        };

        const target =
          Object.assign(
            Object.create(
              prototype,
            ) as
              ReadlinePromptRedrawTarget,
            {
              prompt(
                preserveCursor?:
                  boolean,
              ): void {
                promptArguments.push(
                  preserveCursor,
                );
              },
            },
          );

        expect(
          redrawReadlinePrompt(
            target,
          ),
        ).toBe(
          "prompt",
        );

        expect(
          promptArguments,
        ).toEqual([
          true,
        ]);
      },
    );

    it(
      "preserves the real readline promises input buffer",
      () => {
        const input =
          new PassThrough();

        const output =
          Object.assign(
            new PassThrough(),
            {
              isTTY:
                true,
            },
          );

        const readline =
          createInterface({
            input,
            output,
            terminal:
              true,
          });

        try {
          readline.setPrompt(
            "You: ",
          );

          readline.prompt();

          readline.write(
            "PROMPT REDRAW TEST",
          );

          const lineBefore =
            readline.line;

          const cursorBefore =
            readline.cursor;

          expect(
            redrawReadlinePrompt(
              readline,
            ),
          ).toBe(
            "refresh-symbol",
          );

          expect(
            readline.line,
          ).toBe(
            lineBefore,
          );

          expect(
            readline.cursor,
          ).toBe(
            cursorBefore,
          );

          expect(
            readline.line,
          ).toBe(
            "PROMPT REDRAW TEST",
          );
        } finally {
          readline.close();
        }
      },
    );

    it(
      "restores raw mode for interactive terminal input",
      () => {
        const rawModeValues:
          boolean[] = [];

        const input = {
          isTTY:
            true,

          setRawMode(
            value:
              boolean,
          ): void {
            rawModeValues.push(
              value,
            );
          },
        };

        expect(
          restoreReadlineRawMode(
            input,
          ),
        ).toBe(
          true,
        );

        expect(
          rawModeValues,
        ).toEqual([
          true,
        ]);
      },
    );

    it(
      "does not change non-interactive input",
      () => {
        let called =
          false;

        const input = {
          isTTY:
            false,

          setRawMode():
            void {
            called =
              true;
          },
        };

        expect(
          restoreReadlineRawMode(
            input,
          ),
        ).toBe(
          false,
        );

        expect(
          called,
        ).toBe(
          false,
        );
      },
    );

    it(
      "does not require raw-mode support",
      () => {
        expect(
          restoreReadlineRawMode({
            isTTY:
              true,
          }),
        ).toBe(
          false,
        );

        expect(
          restoreReadlineRawMode(
            null,
          ),
        ).toBe(
          false,
        );
      },
    );
  },
);
