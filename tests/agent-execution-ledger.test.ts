import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildExecutionLedger,
  buildLedgerFallbackAnswer,
  checkAnswerAgainstLedger,
  renderExecutionLedger,
} from "../src/agent/execution-ledger.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  createFinalAnswerProducer,
} from "../src/agent/adapters/final-answer-producer.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

import type {
  AgentEvent,
  AgentToolResult,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const DOCX_ARGS = {
  path: "northbridge-summary.docx",
  content: "# Northbridge Office Electrical Upgrade",
};

const XLSX_ARGS = {
  path: "northbridge-summary.xlsx",
  sheets: [
    {
      name: "Summary",
      rows: [
        [
          "Budget",
          3250,
        ],
      ],
    },
  ],
};

/** History shaped like the live run: one verified DOCX, then a failed one. */
const LIVE_HISTORY: AgentEvent[] = [
  {
    type: "tool_requested",
    callId: "c1",
    tool: "create_docx",
    arguments: DOCX_ARGS,
  },
  {
    type: "tool_state_changed",
    callId: "c1",
    state: "running",
  },
  {
    type: "tool_result",
    callId: "c1",
    success: true,
    verified: true,
    output: "Created DOCX file at /work/northbridge-summary.docx (8 KB).",
  },
  {
    type: "tool_requested",
    callId: "c2",
    tool: "create_docx",
    arguments: {
      ...DOCX_ARGS,
      path: "northbridge-summary-2.docx",
    },
  },
  {
    type: "tool_result",
    callId: "c2",
    success: false,
    verified: false,
    output: "Invalid content.",
  },
  {
    type: "tool_requested",
    callId: "c3",
    tool: "create_xlsx",
    arguments: XLSX_ARGS,
  },
  {
    type: "tool_result",
    callId: "c3",
    success: false,
    verified: false,
    output: "Sheet rows must be arrays.",
  },
  {
    type: "tool_requested",
    callId: "c4",
    tool: "create_xlsx",
    arguments: XLSX_ARGS,
  },
  {
    type: "tool_result",
    callId: "c4",
    success: false,
    verified: false,
    output: "Not executed: ...",
    notExecuted: true,
  },
  {
    type: "tool_requested",
    callId: "c5",
    tool: "create_pdf",
    arguments: {
      path: "northbridge-summary.pdf",
      content: "x",
    },
  },
];

describe(
  "agent/execution-ledger.ts buildExecutionLedger and renderExecutionLedger",
  () => {
    it(
      "records each call's real outcome, verification, target, and output in order",
      () => {
        expect(
          buildExecutionLedger(
            LIVE_HISTORY,
          ).map(
            (entry) => [
              entry.tool,
              entry.target,
              entry.status,
              entry.verified,
            ],
          ),
        ).toEqual([
          [
            "create_docx",
            "northbridge-summary.docx",
            "succeeded",
            true,
          ],
          [
            "create_docx",
            "northbridge-summary-2.docx",
            "failed",
            false,
          ],
          [
            "create_xlsx",
            "northbridge-summary.xlsx",
            "failed",
            false,
          ],
          [
            "create_xlsx",
            "northbridge-summary.xlsx",
            "not_executed",
            false,
          ],
          [
            "create_pdf",
            "northbridge-summary.pdf",
            "interrupted",
            false,
          ],
        ]);
      },
    );

    it(
      "renders a deterministic summary that never calls a postcondition check goal verification",
      () => {
        const rendered =
          renderExecutionLedger(
            buildExecutionLedger(
              LIVE_HISTORY,
            ),
          );

        expect(rendered).toBe(
          [
            "1. create_docx (northbridge-summary.docx): succeeded; the tool's own check of its output passed. Output: Created DOCX file at /work/northbridge-summary.docx (8 KB).",
            "2. create_docx (northbridge-summary-2.docx): failed. Output: Invalid content.",
            "3. create_xlsx (northbridge-summary.xlsx): failed. Output: Sheet rows must be arrays.",
            "4. create_xlsx (northbridge-summary.xlsx): not executed (identical call had already failed). Output: Not executed: ...",
            "5. create_pdf (northbridge-summary.pdf): did not complete (interrupted)",
          ].join("\n"),
        );

        expect(
          renderExecutionLedger([]),
        ).toBe(
          "No tool was called this turn.",
        );
      },
    );
  },
);

describe(
  "agent/execution-ledger.ts checkAnswerAgainstLedger",
  () => {
    const ledger =
      buildExecutionLedger(
        LIVE_HISTORY,
      );

    it.each([
      "All DOCX attempts failed.",
      "I tried several times, but every Word document attempt failed.",
      "None of the files were created.",
      "No DOCX file was created.",
      "Unfortunately northbridge-summary.docx failed.",
      "northbridge-summary.xlsx was created successfully.",
      "Every attempt failed, so nothing was produced.",
    ])(
      "rejects a direct contradiction: %s",
      (answer) => {
        expect(
          checkAnswerAgainstLedger(
            answer,
            ledger,
          ).consistent,
        ).toBe(false);
      },
    );

    it.each([
      "Created northbridge-summary.docx. The XLSX could not be created because its sheet rows were malformed.",
      "The DOCX was created; the second DOCX and the XLSX failed.",
      "northbridge-summary.docx was created and its own check passed, but northbridge-summary.xlsx failed.",
      "The DOCX has no errors and was not modified.",
      "Each tool's own check passed for the DOCX.",
      "northbridge-summary-2.docx failed with invalid content.",
      "If you'd like, I can retry the XLSX with corrected rows.",
    ])(
      "accepts an honest answer: %s",
      (answer) => {
        expect(
          checkAnswerAgainstLedger(
            answer,
            ledger,
          ),
        ).toEqual({
          consistent: true,
        });
      },
    );

    it(
      "does not treat a claim about earlier work as a claim about this turn",
      () => {
        expect(
          checkAnswerAgainstLedger(
            "northbridge-summary.xlsx was already created earlier, so nothing new was needed.",
            ledger,
          ).consistent,
        ).toBe(true);
      },
    );

    it(
      "has nothing to contradict when no tool ran",
      () => {
        expect(
          checkAnswerAgainstLedger(
            "All of them failed.",
            [],
          ).consistent,
        ).toBe(true);
      },
    );
  },
);

/** A native client driven by a fixed script, recording deep copies of requests. */
function scriptedNativeClient(
  results: NativeCompletionResult[],
): NativeCompletionClient & {
  requests: NativeCompletionRequest[];
} {
  const requests: NativeCompletionRequest[] = [];

  return {
    requests,
    async complete(request) {
      requests.push(
        structuredClone(request),
      );

      const next =
        results[requests.length - 1];

      if (!next) {
        throw new Error(
          "scriptedNativeClient ran out of scripted results",
        );
      }

      return next;
    },
  };
}

function call(
  id: string,
  name: string,
  args: unknown,
): NativeCompletionResult {
  return {
    content: null,
    toolCalls: [
      {
        id,
        name,
        argumentsJson:
          JSON.stringify(args),
      },
    ],
  };
}

function text(
  content: string,
): NativeCompletionResult {
  return {
    content,
    toolCalls: [],
  };
}

function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor {
  let index = 0;

  return {
    async execute() {
      const next =
        results[index]!;

      index += 1;

      return next;
    },
  };
}

const LIVE_SCRIPT_PREFIX: NativeCompletionResult[] = [
  call(
    "c1",
    "create_docx",
    DOCX_ARGS,
  ),
  {
    content: null,
    toolCalls: [
      {
        id: "bad",
        name: "create_xlsx",
        argumentsJson: '{"path":"northbridge-summary.xlsx","sheets":',
      },
    ],
  },
  call(
    "c2",
    "create_xlsx",
    XLSX_ARGS,
  ),
];

const LIVE_EXECUTIONS: AgentToolResult[] = [
  {
    success: true,
    verified: true,
    output:
      "Created DOCX file at /work/northbridge-summary.docx (8 KB).",
  },
  {
    success: false,
    output: "Sheet rows must be arrays.",
  },
];

const NO_PRODUCER = {
  async produce(): Promise<string> {
    throw new Error(
      "FinalAnswerProducer must not be used",
    );
  },
};

describe(
  "native final answers are checked against the execution ledger",
  () => {
    it(
      'rejects "all DOCX attempts failed" after a successful DOCX, shows the model the record, and accepts the corrected answer',
      async () => {
        const honest =
          "Created northbridge-summary.docx (its own check passed). northbridge-summary.xlsx could not be created: sheet rows must be arrays.";

        const client =
          scriptedNativeClient([
            ...LIVE_SCRIPT_PREFIX,
            text(
              "I'm sorry, all DOCX attempts failed and the XLSX failed too.",
            ),
            text(honest),
          ]);

        const outcome =
          await runAgentLoop(
            "Create a DOCX and an XLSX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            scriptedExecutor(
              LIVE_EXECUTIONS,
            ),
            NO_PRODUCER,
          );

        expect(outcome).toEqual({
          kind: "final_answer",
          text: honest,
          alreadyDisplayed: false,
        });

        const correction =
          client.requests.at(-1)!.turns.at(-1)!;

        expect(correction.role).toBe(
          "user",
        );

        const correctionText =
          (correction as { content: string }).content;

        expect(correctionText).toContain(
          "contradicts the recorded results of this turn",
        );
        expect(correctionText).toContain(
          "1. create_docx (northbridge-summary.docx): succeeded; the tool's own check of its output passed.",
        );
        expect(correctionText).toContain(
          "2. create_xlsx (northbridge-summary.xlsx): failed.",
        );
      },
    );

    it(
      "answers from the ledger deterministically when the model keeps contradicting it",
      async () => {
        const wrong =
          text(
            "All DOCX attempts failed.",
          );

        const client =
          scriptedNativeClient([
            ...LIVE_SCRIPT_PREFIX,
            wrong,
            wrong,
            wrong,
          ]);

        const diagnostics: string[] = [];

        const outcome =
          await runAgentLoop(
            "Create a DOCX and an XLSX project summary for Northbridge.",
            [],
            new NativeStrategy(
              client,
              "system prompt",
            ),
            TOOLS,
            "gemma4-e2b-sky",
            scriptedExecutor(
              LIVE_EXECUTIONS,
            ),
            NO_PRODUCER,
            (event) => {
              if (
                event.type ===
                "protocol_condition"
              ) {
                diagnostics.push(
                  event.detail,
                );
              }
            },
          );

        expect(outcome.kind).toBe(
          "final_answer",
        );

        const answer =
          (outcome as { text: string }).text;

        expect(answer).toContain(
          "1. create_docx (northbridge-summary.docx): succeeded",
        );
        expect(answer).toContain(
          "2. create_xlsx (northbridge-summary.xlsx): failed",
        );
        expect(answer).not.toContain(
          "All DOCX attempts failed",
        );

        // Shown once by the caller, like any native answer.
        expect(
          (outcome as { alreadyDisplayed: boolean }).alreadyDisplayed,
        ).toBe(false);

        expect(
          checkAnswerAgainstLedger(
            answer,
            buildExecutionLedger([
              {
                type: "tool_requested",
                callId: "c1",
                tool: "create_docx",
                arguments: DOCX_ARGS,
              },
              {
                type: "tool_result",
                callId: "c1",
                success: true,
                verified: true,
                output: "Created",
              },
            ]),
          ).consistent,
        ).toBe(true);

        expect(
          diagnostics.some(
            (detail) =>
              detail.includes(
                "answering from the execution ledger",
              ),
          ),
        ).toBe(true);
      },
    );

    it(
      "matches the shape of the fallback exactly",
      () => {
        expect(
          buildLedgerFallbackAnswer(
            buildExecutionLedger(
              LIVE_HISTORY.slice(0, 3),
            ),
          ),
        ).toBe(
          [
            "I could not produce a summary consistent with what actually happened, so here is the recorded result of each step this turn:",
            "",
            "1. create_docx (northbridge-summary.docx): succeeded; the tool's own check of its output passed. Output: Created DOCX file at /work/northbridge-summary.docx (8 KB).",
          ].join("\n"),
        );
      },
    );
  },
);

describe(
  "the final-answer producer is grounded in the ledger",
  () => {
    it(
      "appends the authoritative execution record to its system prompt when tools ran, and leaves it unchanged when none did",
      async () => {
        const prompts: string[] = [];

        const client: TextCompletionClient = {
          async complete(
            _model,
            systemPrompt,
          ) {
            prompts.push(systemPrompt);
            return "ok";
          },
        };

        const producer =
          createFinalAnswerProducer(
            client,
            "BASE PROMPT",
            "m",
          );

        await producer.produce({
          priorTurns: [],
          goal: "g",
          history: LIVE_HISTORY.slice(0, 3),
        });

        await producer.produce({
          priorTurns: [],
          goal: "g",
          history: [],
        });

        expect(prompts[0]).toBe(
          [
            "BASE PROMPT",
            "",
            "Execution record for this turn (authoritative; the reply must agree with it exactly, including every success and every failure):",
            "1. create_docx (northbridge-summary.docx): succeeded; the tool's own check of its output passed. Output: Created DOCX file at /work/northbridge-summary.docx (8 KB).",
          ].join("\n"),
        );

        expect(prompts[1]).toBe(
          "BASE PROMPT",
        );
      },
    );
  },
);
