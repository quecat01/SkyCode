import {
  describe,
  expect,
  it,
} from "vitest";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  PromptedStrategy,
} from "../src/agent/strategies/prompted.ts";

import {
  selectRelevantTools,
} from "../src/agent/tool-relevance.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import {
  renderContextAsNativeTurns,
} from "../src/agent/history-rendering.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  NativeConversationTurn,
  PlainConversationTurn,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

import type {
  AgentContext,
  AgentEvent,
  AgentToolResult,
  FinalAnswerProducer,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * End-to-end tests of the native agent loop: the real runAgentLoop(), the
 * real NativeStrategy, the real canonical tool definitions, and the real
 * relevant-tool filter, driven by a scripted native model and a scripted
 * executor. Nothing here touches a real model, network, or filesystem.
 */

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const FOUR_DOCUMENT_GOAL =
  "Create a project status DOCX, an XLSX budget workbook, a PDF summary, and a PPTX presentation for the Q3 launch.";

const DOCX_ARGS = {
  path: "status.docx",
  content: "# Q3 Status\n\nOn track.",
};

const XLSX_ARGS = {
  path: "budget.xlsx",
  sheets: [
    {
      name: "Budget",
      headers: [
        "Item",
        "Cost",
      ],
      rows: [
        [
          "Launch event",
          5000,
        ],
      ],
    },
  ],
};

const PDF_ARGS = {
  path: "summary.pdf",
  content: "# Q3 Summary\n\nShort summary.",
};

const PPTX_ARGS = {
  path: "launch.pptx",
  slides: [
    {
      type: "title",
      title: "Q3 Launch",
    },
  ],
};

/** A native model reply that makes exactly one tool call. */
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

/** A native model reply that is plain text only. */
function text(
  content: string,
): NativeCompletionResult {
  return {
    content,
    toolCalls: [],
  };
}

/**
 * A NativeCompletionClient driven by a fixed script of results, recording
 * a deep copy of every request it receives.
 */
function scriptedNativeClient(
  results: NativeCompletionResult[],
): NativeCompletionClient & {
  requests: NativeCompletionRequest[];
} {
  const requests: NativeCompletionRequest[] = [];
  let index = 0;

  return {
    requests,
    async complete(request) {
      requests.push(
        structuredClone(request),
      );

      const result =
        results[index];

      index += 1;

      if (!result) {
        throw new Error(
          "scriptedNativeClient called more times than it has scripted results",
        );
      }

      return result;
    },
  };
}

/** An executor returning scripted results, recording every call. */
function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor & {
  calls: { tool: string; args: unknown }[];
} {
  const calls: {
    tool: string;
    args: unknown;
  }[] = [];

  let index = 0;

  return {
    calls,
    async execute(tool, args) {
      calls.push({
        tool,
        args,
      });

      const result =
        results[index];

      index += 1;

      if (!result) {
        throw new Error(
          "scriptedExecutor called more times than it has scripted results",
        );
      }

      return result;
    },
  };
}

/** A FinalAnswerProducer that must not be reached unless a test says so. */
function recordingFinalAnswerProducer(
  textToReturn = "UNEXPECTED: FinalAnswerProducer was used",
): FinalAnswerProducer & {
  calls: AgentContext[];
} {
  const calls: AgentContext[] = [];

  return {
    calls,
    async produce(context) {
      calls.push(
        structuredClone(context),
      );

      return textToReturn;
    },
  };
}

function succeeded(
  output: string,
): AgentToolResult {
  return {
    success: true,
    verified: true,
    output,
  };
}

function failed(
  output: string,
): AgentToolResult {
  return {
    success: false,
    output,
  };
}

/** Assistant tool-call turns in a request, in order. */
function toolCallTurns(
  request: NativeCompletionRequest,
) {
  return request.turns.filter(
    (
      turn,
    ): turn is Extract<
      NativeConversationTurn,
      { role: "assistant" }
    > =>
      turn.role === "assistant" &&
      (turn.toolCalls?.length ?? 0) > 0,
  );
}

/** role:"tool" turns in a request, in order. */
function toolResultTurns(
  request: NativeCompletionRequest,
) {
  return request.turns.filter(
    (
      turn,
    ): turn is Extract<
      NativeConversationTurn,
      { role: "tool" }
    > => turn.role === "tool",
  );
}

/** Runs one turn with the real loop and a filtering NativeStrategy. */
async function runNativeTurn(
  goal: string,
  client: NativeCompletionClient,
  executor: ToolExecutor,
  finalAnswerProducer: FinalAnswerProducer = recordingFinalAnswerProducer(),
  priorTurns: PlainConversationTurn[] = [],
) {
  const events: AgentEvent[] = [];

  const strategy =
    new NativeStrategy(
      client,
      "native system prompt",
      {
        selectTools:
          selectRelevantTools,
      },
    );

  const outcome =
    await runAgentLoop(
      goal,
      priorTurns,
      strategy,
      TOOLS,
      "gemma4-e4b-sky",
      executor,
      finalAnswerProducer,
      (event) => {
        events.push(event);
      },
    );

  return {
    outcome,
    events,
  };
}

describe(
  "native agent loop (runAgentLoop + NativeStrategy)",
  () => {
    it(
      "runs four sequential document tool calls from one request with no user input between steps",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "call_docx",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "call_xlsx",
              "create_xlsx",
              XLSX_ARGS,
            ),
            call(
              "call_pdf",
              "create_pdf",
              PDF_ARGS,
            ),
            call(
              "call_pptx",
              "create_pptx",
              PPTX_ARGS,
            ),
            text(
              "Created status.docx, budget.xlsx, summary.pdf, and launch.pptx. Each tool's own check passed; I did not independently verify their contents.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
            succeeded(
              "Created XLSX file at /work/budget.xlsx (6 KB).",
            ),
            succeeded(
              "Created PDF file at /work/summary.pdf (3 KB).",
            ),
            succeeded(
              "Created PPTX file at /work/launch.pptx (30 KB).",
            ),
          ]);

        const producer =
          recordingFinalAnswerProducer();

        const {
          outcome,
        } = await runNativeTurn(
          FOUR_DOCUMENT_GOAL,
          client,
          executor,
          producer,
        );

        expect(
          executor.calls.map(
            (c) => c.tool,
          ),
        ).toEqual([
          "create_docx",
          "create_xlsx",
          "create_pdf",
          "create_pptx",
        ]);

        expect(client.requests).toHaveLength(5);

        // Each request after a tool call carries every earlier real call and
        // result, in order: the loop continued automatically each time.
        for (
          let step = 0;
          step < 5;
          step += 1
        ) {
          expect(
            toolCallTurns(
              client.requests[step]!,
            ),
          ).toHaveLength(step);
          expect(
            toolResultTurns(
              client.requests[step]!,
            ),
          ).toHaveLength(step);
        }

        expect(
          toolResultTurns(
            client.requests[4]!,
          ).map(
            (turn) => turn.toolCallId,
          ),
        ).toEqual([
          "call_docx",
          "call_xlsx",
          "call_pdf",
          "call_pptx",
        ]);

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "Created status.docx, budget.xlsx, summary.pdf, and launch.pptx. Each tool's own check passed; I did not independently verify their contents.",
          alreadyDisplayed: false,
        });

        expect(producer.calls).toHaveLength(0);

        // Every request offered the filtered document set, never every tool,
        // and always parallel_tool_calls: false.
        for (
          const request of client.requests
        ) {
          expect(request.parallelToolCalls).toBe(false);

          const names =
            request.tools.map(
              (tool) => tool.name,
            );

          expect(names).toEqual(
            expect.arrayContaining([
              "create_docx",
              "create_xlsx",
              "create_pdf",
              "create_pptx",
            ]),
          );
          expect(names).not.toContain(
            "run_shell_command",
          );
          expect(names.length).toBeLessThan(
            TOOLS.length,
          );
        }
      },
    );

    it(
      "reconstructs native history faithfully: same call ID, function name, complete arguments, and the real output verbatim",
      async () => {
        // The model sends an extra key the schema does not use. Validation
        // strips it before execution, but the model's own call must still be
        // echoed back to it exactly as made.
        const argsWithExtraKey = {
          ...DOCX_ARGS,
          note: "model-supplied extra",
        };

        const client =
          scriptedNativeClient([
            call(
              "call_provider_42",
              "create_docx",
              argsWithExtraKey,
            ),
            text(
              "Created status.docx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
          ]);

        await runNativeTurn(
          "Create a project status DOCX report for the Q3 launch.",
          client,
          executor,
        );

        const second =
          client.requests[1]!;

        const goalIndex =
          second.turns.findIndex(
            (turn) =>
              turn.role === "user" &&
              turn.content.startsWith(
                "Create a project status DOCX",
              ),
          );

        expect(
          second.turns.slice(
            goalIndex + 1,
          ),
        ).toEqual([
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "call_provider_42",
                name: "create_docx",
                argumentsJson:
                  JSON.stringify(
                    argsWithExtraKey,
                  ),
              },
            ],
          },
          {
            role: "tool",
            toolCallId:
              "call_provider_42",
            content:
              JSON.stringify({
                status: "succeeded",
                postcondition_verified: true,
                output:
                  "Created DOCX file at /work/status.docx (8 KB).",
              }),
          },
        ]);
      },
    );

    it(
      "continues automatically after a failed tool call and lets the model choose another valid action",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "call_1",
              "create_pptx",
              PPTX_ARGS,
            ),
            call(
              "call_2",
              "create_pptx",
              {
                ...PPTX_ARGS,
                path: "launch-v2.pptx",
              },
            ),
            text(
              "launch.pptx already existed, so I created the presentation as launch-v2.pptx instead.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            failed(
              "launch.pptx already exists. Sky Code will never overwrite an existing file without being told to.",
            ),
            succeeded(
              "Created PPTX file at /work/launch-v2.pptx (30 KB).",
            ),
          ]);

        const {
          outcome,
        } = await runNativeTurn(
          "Create a PPTX presentation for the Q3 launch review.",
          client,
          executor,
        );

        const failureResult =
          toolResultTurns(
            client.requests[1]!,
          )[0]!;

        expect(
          JSON.parse(
            failureResult.content,
          ),
        ).toEqual({
          status: "failed",
          output:
            "launch.pptx already exists. Sky Code will never overwrite an existing file without being told to.",
        });

        // The full filtered tool set is still offered after the failure.
        expect(
          client.requests[1]!.tools,
        ).toEqual(
          client.requests[0]!.tools,
        );

        expect(executor.calls).toHaveLength(2);
        expect(outcome.kind).toBe(
          "final_answer",
        );
      },
    );

    it(
      "never executes any of several calls returned despite parallel_tool_calls:false, and answers every one of them in the corrective request",
      async () => {
        const client =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [
                {
                  id: "call_a",
                  name: "create_docx",
                  argumentsJson:
                    JSON.stringify(
                      DOCX_ARGS,
                    ),
                },
                {
                  id: "call_b",
                  name: "create_xlsx",
                  argumentsJson:
                    JSON.stringify(
                      XLSX_ARGS,
                    ),
                },
              ],
            },
            call(
              "call_c",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "Created status.docx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
          ]);

        const diagnostics: string[] = [];

        const strategy =
          new NativeStrategy(
            client,
            "native system prompt",
          );

        await runAgentLoop(
          "Create a status DOCX and a budget XLSX for the launch.",
          [],
          strategy,
          TOOLS,
          "gemma4-e4b-sky",
          executor,
          recordingFinalAnswerProducer(),
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

        // Only the single, corrected call was executed.
        expect(executor.calls).toEqual([
          {
            tool: "create_docx",
            args: DOCX_ARGS,
          },
        ]);

        // The corrective request echoes both rejected calls and answers each
        // with its own "not executed" tool message, keeping it a valid
        // native conversation.
        const corrective =
          client.requests[1]!;

        expect(
          toolCallTurns(
            corrective,
          )[0]!.toolCalls!.map(
            (c) => c.id,
          ),
        ).toEqual([
          "call_a",
          "call_b",
        ]);

        const answers =
          toolResultTurns(
            corrective,
          );

        expect(
          answers.map(
            (turn) => turn.toolCallId,
          ),
        ).toEqual([
          "call_a",
          "call_b",
        ]);

        for (
          const answer of answers
        ) {
          expect(
            JSON.parse(
              answer.content,
            ).status,
          ).toBe(
            "not_executed",
          );
        }

        expect(
          diagnostics.some(
            (detail) =>
              detail.includes(
                "2 tool calls at once",
              ),
          ),
        ).toBe(true);
      },
    );

    it(
      "recovers from malformed native arguments within the bounded budget, echoing them safely",
      async () => {
        const client =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [
                {
                  id: "call_bad",
                  name: "create_docx",
                  argumentsJson:
                    '{"path":"status.docx","content":"unterminated',
                },
              ],
            },
            call(
              "call_good",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "Created status.docx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
          ]);

        await runNativeTurn(
          "Create a project status DOCX report for the Q3 launch.",
          client,
          executor,
        );

        expect(executor.calls).toHaveLength(1);

        const corrective =
          client.requests[1]!;

        // Echoed with "{}" so a gateway that parses arguments cannot reject
        // the corrective request; the original text is still shown.
        expect(
          toolCallTurns(
            corrective,
          )[0]!.toolCalls![0]!.argumentsJson,
        ).toBe("{}");

        const answer =
          JSON.parse(
            toolResultTurns(
              corrective,
            )[0]!.content,
          );

        expect(answer.status).toBe(
          "not_executed",
        );
        expect(
          answer.arguments_received,
        ).toBe(
          '{"path":"status.docx","content":"unterminated',
        );
        expect(answer.error).toContain(
          "not valid JSON",
        );
      },
    );

    it(
      "throws once malformed calls exhaust the corrective budget, never executing any of them",
      async () => {
        const malformed: NativeCompletionResult = {
          content: null,
          toolCalls: [
            {
              id: "call_bad",
              name: "create_docx",
              argumentsJson: "{",
            },
          ],
        };

        const client =
          scriptedNativeClient([
            malformed,
            malformed,
            malformed,
          ]);

        const executor =
          scriptedExecutor([]);

        await expect(
          runNativeTurn(
            "Create a project status DOCX report for the Q3 launch.",
            client,
            executor,
          ),
        ).rejects.toThrow(
          "could not obtain one compliant action",
        );

        expect(executor.calls).toHaveLength(0);
        expect(client.requests).toHaveLength(3);
      },
    );

    it(
      "treats a streamed call the client could not assemble as non-compliant and reports stream notes as diagnostics",
      async () => {
        const client =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [],
              protocolIssues: [
                "The streamed tool call at index 0 never received a function name.",
              ],
            },
            {
              ...call(
                "sky_call_local",
                "create_docx",
                DOCX_ARGS,
              ),
              protocolNotes: [
                'The provider streamed tool call "create_docx" (index 0) without a call ID; Sky Code assigned "sky_call_local" so its result can be matched.',
              ],
            },
            text(
              "Created status.docx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
          ]);

        const {
          events,
        } = await runNativeTurn(
          "Create a project status DOCX report for the Q3 launch.",
          client,
          executor,
        );

        const details =
          events
            .filter(
              (event) =>
                event.type ===
                "protocol_condition",
            )
            .map(
              (event) =>
                (event as { detail: string }).detail,
            );

        expect(
          details.some(
            (detail) =>
              detail.includes(
                "could not be assembled",
              ),
          ),
        ).toBe(true);
        expect(
          details.some(
            (detail) =>
              detail.includes(
                "without a call ID",
              ),
          ),
        ).toBe(true);

        expect(executor.calls).toHaveLength(1);

        // The locally assigned ID is used consistently for the result.
        expect(
          toolResultTurns(
            client.requests[2]!,
          )[0]!.toolCallId,
        ).toBe(
          "sky_call_local",
        );
      },
    );

    it.each([
      [
        "a sky-tool block",
        '```sky-tool\n{"tool":"create_xlsx","args":{"path":"budget.xlsx"}}\n```',
      ],
      [
        'a "Tool call:" line',
        `Tool call: create_xlsx(${JSON.stringify(XLSX_ARGS)})`,
      ],
    ])(
      "never treats %s as executed or as the final answer, and continues to the real native call",
      async (_label, rawText) => {
        const client =
          scriptedNativeClient([
            call(
              "call_docx",
              "create_docx",
              DOCX_ARGS,
            ),
            text(rawText),
            call(
              "call_xlsx",
              "create_xlsx",
              XLSX_ARGS,
            ),
            text(
              "Created status.docx and budget.xlsx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
            succeeded(
              "Created XLSX file at /work/budget.xlsx (6 KB).",
            ),
          ]);

        const {
          outcome,
          events,
        } = await runNativeTurn(
          "Create a status DOCX and a budget XLSX workbook for the launch.",
          client,
          executor,
        );

        expect(
          executor.calls.map(
            (c) => c.tool,
          ),
        ).toEqual([
          "create_docx",
          "create_xlsx",
        ]);

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "Created status.docx and budget.xlsx.",
          alreadyDisplayed: false,
        });

        // The raw text never became a recorded final answer.
        expect(
          events.filter(
            (event) =>
              event.type ===
              "final_answer",
          ),
        ).toEqual([
          {
            type: "final_answer",
            text: "Created status.docx and budget.xlsx.",
          },
        ]);
      },
    );

    it(
      "rejects an unexecuted future-action promise and lets the model actually perform the action",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "call_docx",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "The DOCX is done. I will now create the XLSX budget workbook.",
            ),
            call(
              "call_xlsx",
              "create_xlsx",
              XLSX_ARGS,
            ),
            text(
              "Created status.docx and budget.xlsx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
            succeeded(
              "Created XLSX file at /work/budget.xlsx (6 KB).",
            ),
          ]);

        const {
          outcome,
        } = await runNativeTurn(
          "Create a status DOCX and a budget XLSX workbook for the launch.",
          client,
          executor,
        );

        expect(executor.calls).toHaveLength(2);

        // The corrective request told the model why its reply was not
        // accepted, and that it can still make the call.
        const correctiveUser =
          client.requests[2]!.turns.at(-1)!;

        expect(correctiveUser.role).toBe(
          "user",
        );
        expect(
          (correctiveUser as { content: string }).content,
        ).toContain(
          "promises an action that has not been carried out",
        );

        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: "Created status.docx and budget.xlsx.",
        });
      },
    );

    it(
      "after a partial failure, only a truthful final answer is accepted",
      async () => {
        const honest =
          "Created status.docx, budget.xlsx, and summary.pdf. The PPTX was not created: launch.pptx already exists and Sky Code does not overwrite files.";

        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c2",
              "create_xlsx",
              XLSX_ARGS,
            ),
            call(
              "c3",
              "create_pdf",
              PDF_ARGS,
            ),
            call(
              "c4",
              "create_pptx",
              PPTX_ARGS,
            ),
            text(
              "All four files are ready. I'll create the presentation again under a new name next.",
            ),
            text(honest),
          ]);

        const executor =
          scriptedExecutor([
            succeeded(
              "Created DOCX file at /work/status.docx (8 KB).",
            ),
            succeeded(
              "Created XLSX file at /work/budget.xlsx (6 KB).",
            ),
            succeeded(
              "Created PDF file at /work/summary.pdf (3 KB).",
            ),
            failed(
              "launch.pptx already exists. Sky Code will never overwrite an existing file without being told to.",
            ),
          ]);

        const {
          outcome,
        } = await runNativeTurn(
          FOUR_DOCUMENT_GOAL,
          client,
          executor,
        );

        expect(outcome).toEqual({
          kind: "final_answer",
          text: honest,
          alreadyDisplayed: false,
        });

        // The model saw the real failure when it wrote the rejected reply.
        const lastResult =
          toolResultTurns(
            client.requests[4]!,
          ).at(-1)!;

        expect(
          JSON.parse(
            lastResult.content,
          ).status,
        ).toBe(
          "failed",
        );
      },
    );

    it(
      "falls back to the grounded FinalAnswerProducer when the model keeps writing unacceptable replies",
      async () => {
        const promise =
          text(
            "I will now create the PPTX presentation.",
          );

        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_pptx",
              PPTX_ARGS,
            ),
            promise,
            promise,
            promise,
          ]);

        const executor =
          scriptedExecutor([
            failed(
              "launch.pptx already exists.",
            ),
          ]);

        const producer =
          recordingFinalAnswerProducer(
            "The presentation was not created: launch.pptx already exists.",
          );

        const {
          outcome,
        } = await runNativeTurn(
          "Create a PPTX presentation for the Q3 launch review.",
          client,
          executor,
          producer,
        );

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "The presentation was not created: launch.pptx already exists.",
          alreadyDisplayed: true,
        });

        // Grounded in the real recorded failure, not the rejected promises.
        expect(producer.calls).toHaveLength(1);
        expect(
          producer.calls[0]!.history.some(
            (event) =>
              event.type ===
                "tool_result" &&
              !event.success,
          ),
        ).toBe(true);
      },
    );

    it(
      "reports the relevant-tool selection once per turn, not on every step",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "c2",
              "create_pdf",
              PDF_ARGS,
            ),
            text(
              "Created status.docx and summary.pdf.",
            ),
          ]);

        const {
          events,
        } = await runNativeTurn(
          "Create a status DOCX report and a PDF summary for the launch.",
          client,
          scriptedExecutor([
            succeeded("ok 1"),
            succeeded("ok 2"),
          ]),
        );

        const selectionReports =
          events.filter(
            (event) =>
              event.type ===
                "protocol_condition" &&
              event.detail.startsWith(
                "Relevant-tool filtering",
              ),
          );

        expect(selectionReports).toHaveLength(1);
      },
    );

    it(
      "rejects a call to a tool filtered out of this turn's offer, without executing it",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "c1",
              "run_shell_command",
              {
                command: "rm -rf build",
              },
            ),
            call(
              "c2",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "Created status.docx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            succeeded("ok"),
          ]);

        await runNativeTurn(
          "Create a project status DOCX report for the Q3 launch.",
          client,
          executor,
        );

        expect(executor.calls).toEqual([
          {
            tool: "create_docx",
            args: DOCX_ARGS,
          },
        ]);
      },
    );
  },
);

describe(
  "strategy switching and session replay compatibility",
  () => {
    it(
      "replays earlier turns from a session that ran under another strategy as plain native user/assistant turns",
      async () => {
        // Earlier turns are rebuilt from the session's plain "message"
        // records, whichever strategy produced them; agent_event records are
        // never replayed into later turns.
        const priorTurns: PlainConversationTurn[] = [
          {
            role: "user",
            content: "Create a project status DOCX.",
          },
          {
            role: "assistant",
            content: "Created status.docx.",
          },
        ];

        const client =
          scriptedNativeClient([
            text(
              "status.docx already exists from earlier; nothing new was needed.",
            ),
          ]);

        await runNativeTurn(
          "Now also make sure the status DOCX report exists for the launch.",
          client,
          scriptedExecutor([]),
          recordingFinalAnswerProducer(),
          priorTurns,
        );

        expect(
          client.requests[0]!.turns.slice(
            0,
            3,
          ),
        ).toEqual([
          {
            role: "user",
            content: "Create a project status DOCX.",
          },
          {
            role: "assistant",
            content: "Created status.docx.",
          },
          {
            role: "user",
            content:
              "Now also make sure the status DOCX report exists for the launch.",
          },
        ]);
      },
    );

    it(
      "renders agent_event records saved before this change (validated arguments, no extra fields) without error",
      () => {
        const context: AgentContext = {
          priorTurns: [],
          goal: "make a report",
          history: [
            {
              type: "tool_requested",
              callId: "old-uuid-1",
              tool: "create_docx",
              arguments: {
                path: "r.docx",
                content: "x",
              },
            },
            {
              type: "tool_state_changed",
              callId: "old-uuid-1",
              state: "running",
            },
            {
              type: "tool_state_changed",
              callId: "old-uuid-1",
              state: "verified",
            },
            {
              type: "tool_result",
              callId: "old-uuid-1",
              success: true,
              verified: true,
              output: "Created DOCX file at /work/r.docx (8 KB).",
            },
          ],
        };

        const turns =
          renderContextAsNativeTurns(
            context,
          );

        expect(turns.at(-2)).toEqual({
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "old-uuid-1",
              name: "create_docx",
              argumentsJson:
                '{"path":"r.docx","content":"x"}',
            },
          ],
        });
        expect(
          (turns.at(-1) as { toolCallId: string }).toolCallId,
        ).toBe("old-uuid-1");
      },
    );

    it(
      "lets a mid-session /model switch hand the same recorded history to PromptedStrategy or NativeStrategy",
      async () => {
        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "c1",
            tool: "create_docx",
            arguments: DOCX_ARGS,
          },
          {
            type: "tool_result",
            callId: "c1",
            success: false,
            verified: false,
            output: "status.docx already exists.",
          },
        ];

        const context: AgentContext = {
          priorTurns: [],
          goal: "Create a project status DOCX report for the Q3 launch.",
          history,
        };

        const promptedRequests: string[] = [];

        const promptedClient: TextCompletionClient = {
          async complete(
            _model,
            _system,
            turns,
          ) {
            promptedRequests.push(
              JSON.stringify(turns),
            );

            return '{"action":"done"}';
          },
        };

        const nativeClient =
          scriptedNativeClient([
            text(
              "status.docx was not created because it already exists.",
            ),
          ]);

        const prompted =
          await new PromptedStrategy(
            promptedClient,
          ).getNextAction(
            context,
            TOOLS,
            "some-prompted-model",
          );

        const native =
          await new NativeStrategy(
            nativeClient,
            "native system prompt",
          ).getNextAction(
            context,
            TOOLS,
            "gemma4-e4b-sky",
          );

        expect(prompted).toEqual({
          kind: "done",
        });
        expect(native).toEqual({
          kind: "final_answer",
          text: "status.docx was not created because it already exists.",
          alreadyDisplayed: false,
        });

        // Both saw the same real failure, each in its own format.
        expect(promptedRequests[0]).toContain(
          "Result: failed",
        );
        expect(
          JSON.parse(
            toolResultTurns(
              nativeClient.requests[0]!,
            )[0]!.content,
          ).status,
        ).toBe(
          "failed",
        );
      },
    );
  },
);
