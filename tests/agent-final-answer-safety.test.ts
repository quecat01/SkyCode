import {
  describe,
  expect,
  it,
} from "vitest";

import {
  checkFinalAnswerSafety,
} from "../src/agent/final-answer-safety.ts";

const TOOL_NAMES = [
  "create_docx",
  "create_xlsx",
  "create_pdf",
  "create_pptx",
  "read_file",
];

function verdict(
  text: string,
) {
  return checkFinalAnswerSafety(
    text,
    TOOL_NAMES,
  );
}

describe(
  "agent/final-answer-safety.ts checkFinalAnswerSafety",
  () => {
    describe(
      "rejects tool requests written as text",
      () => {
        it.each([
          [
            "a sky-tool fenced block",
            '```sky-tool\n{"tool":"create_xlsx","args":{"path":"b.xlsx"}}\n```',
          ],
          [
            "a bare sky-tool line",
            'sky-tool {"tool":"create_xlsx","args":{}}',
          ],
          [
            'a "Tool call:" line',
            'Tool call: create_xlsx({"path":"budget.xlsx"})',
          ],
          [
            "a Gemma-style tool_code block",
            '```tool_code\ncreate_pptx(path="deck.pptx", slides=[])\n```',
          ],
          [
            "a Hermes-style tool_call tag",
            '<tool_call>{"name":"create_pdf","arguments":{}}</tool_call>',
          ],
          [
            "a JSON object naming an offered tool with arguments",
            'Here you go: {"name": "create_xlsx", "arguments": {"path": "b.xlsx"}}',
          ],
          [
            "a tool invocation inside a plain code block",
            "```\ncreate_pdf(path='summary.pdf')\n```",
          ],
        ])(
          "%s",
          (_label, text) => {
            const result =
              verdict(text);

            expect(result.acceptable).toBe(false);

            if (!result.acceptable) {
              expect(result.reason).toContain(
                "Nothing in it was executed",
              );
            }
          },
        );
      },
    );

    describe(
      "rejects promises of work that has not been done",
      () => {
        it.each([
          "I created the DOCX. I will now create the XLSX workbook.",
          "Next I will generate the PDF summary.",
          "Now I'll build the presentation.",
          "The document is ready. Let me create the spreadsheet next.",
          "I'm going to write the PPTX file now.",
        ])(
          "%s",
          (text) => {
            const result =
              verdict(text);

            expect(result.acceptable).toBe(false);

            if (!result.acceptable) {
              expect(result.reason).toContain(
                "promises an action that has not been carried out",
              );
            }
          },
        );
      },
    );

    describe(
      "accepts honest final answers",
      () => {
        it.each([
          "Created report.docx, budget.xlsx, summary.pdf, and deck.pptx. Each tool's own structural check passed; I could not independently verify the content against every requirement.",
          "I created the DOCX and XLSX. Creating deck.pptx failed because the file already exists, so no presentation was written.",
          "Next, I tried to create the PPTX, but it failed: deck.pptx already exists.",
          "If you'd like, I can create a PDF version as well.",
          "Let me know if you want any changes to the workbook.",
          "Would you like me to regenerate the slides with a different title?",
          "The create_docx tool reported success for report.docx.",
        ])(
          "%s",
          (text) => {
            expect(
              verdict(text),
            ).toEqual({
              acceptable: true,
            });
          },
        );
      },
    );

    it(
      "still rejects text tool requests when no tool names are offered",
      () => {
        expect(
          checkFinalAnswerSafety(
            "```sky-tool\n{}\n```",
            [],
          ).acceptable,
        ).toBe(false);
      },
    );
  },
);
