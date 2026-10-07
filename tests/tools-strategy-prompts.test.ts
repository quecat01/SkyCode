import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createSkyCodeCapabilitiesPrompt,
  createSkyCodeFinalAnswerPrompt,
  createSkyCodeSystemPrompt,
} from "../src/tools.ts";

/**
 * Tests for the three strategy-aware Sky Code system-prompt builders in
 * tools.ts: the original createSkyCodeSystemPrompt() (LegacyStrategy, the
 * `sky-tool` fenced-block text protocol) alongside the two new prompts added
 * for NativeStrategy and the final-answer producer, neither of which may
 * contain any `sky-tool` text.
 */
describe(
  "tools.ts strategy-aware system prompts",
  () => {
    describe(
      "createSkyCodeSystemPrompt (legacy, unchanged)",
      () => {
        it(
          "still includes the sky-tool fenced-block protocol block and its three worked examples",
          () => {
            const prompt =
              createSkyCodeSystemPrompt();

            expect(prompt).toContain(
              "respond with ONLY a fenced code block tagged sky-tool",
            );

            expect(prompt).toContain(
              "Local tool example:",
            );

            expect(prompt).toContain(
              "MCP tool example:",
            );

            expect(prompt).toContain(
              "Sub-agent delegation example:",
            );

            expect(
              (
                prompt.match(
                  /```sky-tool/g,
                ) ?? []
              ).length,
            ).toBe(
              3,
            );
          },
        );
      },
    );

    describe(
      "createSkyCodeCapabilitiesPrompt (NativeStrategy)",
      () => {
        it(
          "never mentions sky-tool anywhere",
          () => {
            const prompt =
              createSkyCodeCapabilitiesPrompt();

            expect(prompt).not.toContain(
              "sky-tool",
            );
          },
        );

        it(
          "still includes the local tool descriptions and the identity/engine block",
          () => {
            const prompt =
              createSkyCodeCapabilitiesPrompt(
                [],
                [],
                [],
                [],
                "",
                "test-native-model",
              );

            expect(prompt).toContain(
              "You have access to these local tools:",
            );

            expect(prompt).toContain(
              "- create_pptx(path, slides):",
            );

            expect(prompt).toContain(
              "Identity:",
            );

            expect(prompt).toContain(
              'Right now that engine is "test-native-model"',
            );
          },
        );

        it(
          "still appends sky.md content in full, unfiltered, the same as the legacy prompt",
          () => {
            const prompt =
              createSkyCodeCapabilitiesPrompt(
                [],
                [],
                [],
                [],
                "Always run tests before committing.",
              );

            expect(prompt).toContain(
              "User-defined operating rules (~/.sky-code/sky.md):",
            );

            expect(prompt).toContain(
              "Always run tests before committing.",
            );
          },
        );

        it(
          "omits the sky.md section entirely when content is empty or whitespace-only",
          () => {
            const promptWithNoArg =
              createSkyCodeCapabilitiesPrompt();

            const promptWithBlankSkyMd =
              createSkyCodeCapabilitiesPrompt(
                [],
                [],
                [],
                [],
                "   \n  ",
              );

            for (const prompt of [
              promptWithNoArg,
              promptWithBlankSkyMd,
            ]) {
              expect(prompt).not.toContain(
                "User-defined operating rules",
              );
            }
          },
        );

        it(
          "ends with the native agent-execution instructions, placed after sky.md content for recency",
          () => {
            const prompt =
              createSkyCodeCapabilitiesPrompt(
                [],
                [],
                [],
                [],
                "7. Never write any text before the tool block.",
              );

            const skyMdIndex =
              prompt.indexOf(
                "7. Never write any text before the tool block.",
              );

            const executionIndex =
              prompt.indexOf(
                "Agent execution instructions:",
              );

            expect(skyMdIndex).toBeGreaterThan(
              -1,
            );
            expect(executionIndex).toBeGreaterThan(
              skyMdIndex,
            );

            for (
              const required of [
                "Request tools only through the native tool-calling interface.",
                "Request exactly one tool call per response",
                "Do not ask the user to say continue",
                "A successful tool result means only that one action succeeded.",
                "postcondition_verified: true in a tool result means only that the tool's own check of its output passed.",
                "If a tool fails, read the error.",
                "Never say an action will happen, is happening, or is next",
              ]
            ) {
              expect(prompt).toContain(
                required,
              );
            }

            // Generic invariant: the execution block names no specific tool.
            const executionBlock =
              prompt.slice(
                executionIndex,
              );

            for (
              const toolName of [
                "create_docx",
                "create_xlsx",
                "create_pdf",
                "create_pptx",
                "write_file",
                "read_file",
              ]
            ) {
              expect(executionBlock).not.toContain(
                toolName,
              );
            }
          },
        );

        it(
          "adds connected MCP tools the same way the legacy prompt does",
          () => {
            const prompt =
              createSkyCodeCapabilitiesPrompt([
                {
                  serverName:
                    "test-server",
                  name:
                    "phase2_ping",
                  description:
                    "Return a fixed test response.",
                  inputSchema: {
                    type:
                      "object",
                    properties: {},
                  },
                },
              ]);

            expect(prompt).toContain(
              'Server "test-server", tool "phase2_ping": Return a fixed test response.',
            );
          },
        );
      },
    );

    describe(
      "createSkyCodeFinalAnswerPrompt (FinalAnswerProducer)",
      () => {
        it(
          "never mentions sky-tool anywhere",
          () => {
            const prompt =
              createSkyCodeFinalAnswerPrompt();

            expect(prompt).not.toContain(
              "sky-tool",
            );
          },
        );

        it(
          "explicitly instructs the model not to request a tool here",
          () => {
            const prompt =
              createSkyCodeFinalAnswerPrompt();

            expect(prompt).toContain(
              "Final answer instructions:",
            );

            expect(prompt).toContain(
              "Do not request a tool here, in any format.",
            );
          },
        );

        it(
          "explicitly forbids claiming or implying an action happened, is happening, or will happen unless a recorded tool call actually succeeded, with no reference to any specific tool",
          () => {
            const prompt =
              createSkyCodeFinalAnswerPrompt();

            expect(prompt).toContain(
              'Never state or imply that an action "will" happen, is in progress, or has been completed, unless a corresponding tool call is recorded above as having actually succeeded.',
            );

            expect(prompt).toContain(
              "describe the real failure and its practical limitation plainly instead of promising it will still be done",
            );

            // Generic invariant: the new instruction sentence itself (not
            // the prompt as a whole, which legitimately lists the
            // document-generation tools elsewhere) must not be written in a
            // way that only applies to document-generation tools or any
            // other specific tool name.
            const neverStateInstructionLine =
              prompt
                .split("\n")
                .find(
                  (line) =>
                    line.includes(
                      'Never state or imply that an action "will" happen',
                    ),
                ) ?? "";

            for (
              const toolSpecificTerm of [
                "docx",
                "xlsx",
                "pdf",
                "pptx",
                "write_file",
              ]
            ) {
              expect(
                neverStateInstructionLine.toLowerCase(),
              ).not.toContain(
                toolSpecificTerm,
              );
            }
          },
        );

        it(
          "still includes the local tool descriptions and the identity/engine block",
          () => {
            const prompt =
              createSkyCodeFinalAnswerPrompt(
                [],
                [],
                [],
                [],
                "",
                "test-final-answer-model",
              );

            expect(prompt).toContain(
              "You have access to these local tools:",
            );

            expect(prompt).toContain(
              "Identity:",
            );

            expect(prompt).toContain(
              'Right now that engine is "test-final-answer-model"',
            );
          },
        );

        it(
          "places the final-answer instructions after sky.md content, both for recency",
          () => {
            const prompt =
              createSkyCodeFinalAnswerPrompt(
                [],
                [],
                [],
                [],
                "Confirm before destructive actions.",
              );

            const skyMdIndex =
              prompt.indexOf(
                "Confirm before destructive actions.",
              );

            const finalAnswerIndex =
              prompt.indexOf(
                "Final answer instructions:",
              );

            expect(skyMdIndex).toBeGreaterThan(
              -1,
            );

            expect(finalAnswerIndex).toBeGreaterThan(
              skyMdIndex,
            );
          },
        );

        it(
          "omits the sky.md section entirely when content is empty or whitespace-only",
          () => {
            const promptWithNoArg =
              createSkyCodeFinalAnswerPrompt();

            const promptWithBlankSkyMd =
              createSkyCodeFinalAnswerPrompt(
                [],
                [],
                [],
                [],
                "   \n  ",
              );

            for (const prompt of [
              promptWithNoArg,
              promptWithBlankSkyMd,
            ]) {
              expect(prompt).not.toContain(
                "User-defined operating rules",
              );
            }
          },
        );
      },
    );
  },
);
