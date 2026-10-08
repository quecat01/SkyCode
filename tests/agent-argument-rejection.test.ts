import {
  describe,
  expect,
  it,
} from "vitest";

import {
  MAX_ARGUMENT_CORRECTIONS,
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import {
  buildArgumentRejectionText,
  summarizeExpectedArguments,
} from "../src/agent/argument-guidance.ts";

import {
  buildExecutionLedger,
  renderExecutionLedger,
} from "../src/agent/execution-ledger.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
} from "../src/agent/model-client.ts";

import type {
  AgentEvent,
  AgentToolResult,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * Tests for native tool calls whose arguments are rejected before running
 * (malformed JSON or a schema violation): they are recorded under the
 * model's own call ID, executed never, answered with concrete correction
 * guidance, capped per tool, and reported truthfully in the ledger.
 */

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const GOAL =
  "Create a project status DOCX and a PPTX presentation for the Q3 launch.";

const DOCX_ARGS = {
  path: "status.docx",
  content: "# Q3 Status\n\nOn track.",
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

/** Schema-invalid: "bullets" is not a slide type. */
const INVALID_PPTX_ARGS = {
  path: "launch.pptx",
  slides: [
    {
      type: "bullets",
      title: "Q3 Launch",
      bullets: [
        "On track",
      ],
    },
  ],
};

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

const NO_PRODUCER = {
  async produce(): Promise<string> {
    throw new Error(
      "FinalAnswerProducer must not be used",
    );
  },
};

async function runTurn(
  client: NativeCompletionClient,
  executor: ToolExecutor,
) {
  const events: AgentEvent[] = [];

  const outcome =
    await runAgentLoop(
      GOAL,
      [],
      new NativeStrategy(
        client,
        "native system prompt",
      ),
      TOOLS,
      "qwen-test",
      executor,
      NO_PRODUCER,
      (event) => {
        events.push(event);
      },
    );

  return {
    outcome,
    events,
  };
}

/** The role:"tool" envelope answering one call ID in a request. */
function envelopeFor(
  request: NativeCompletionRequest,
  callId: string,
): Record<string, unknown> {
  const turn =
    request.turns.find(
      (candidate) =>
        candidate.role === "tool" &&
        candidate.toolCallId === callId,
    );

  if (
    !turn ||
    turn.role !== "tool"
  ) {
    throw new Error(
      `no tool message for ${callId}`,
    );
  }

  return JSON.parse(
    turn.content,
  ) as Record<string, unknown>;
}

function diagnostics(
  events: readonly AgentEvent[],
): string[] {
  return events.flatMap(
    (event) =>
      event.type === "protocol_condition"
        ? [event.detail]
        : [],
  );
}

describe(
  "native argument rejection",
  () => {
    it(
      "never executes a schema-invalid call, answers its own call ID with the validation error, expected shape and example, and runs the corrected call",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "pptx_bad",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "pptx_good",
              "create_pptx",
              PPTX_ARGS,
            ),
            text(
              "Created launch.pptx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              verified: true,
              output:
                "Created PPTX file at /work/launch.pptx (30 KB).",
            },
          ]);

        const {
          outcome,
        } = await runTurn(
          client,
          executor,
        );

        // Only the corrected call reached the executor.
        expect(executor.calls).toEqual([
          {
            tool: "create_pptx",
            args: expect.objectContaining({
              path: "launch.pptx",
            }),
          },
        ]);

        // The rejected call is echoed with the arguments the model sent.
        const next =
          client.requests[1]!;

        const echoed =
          next.turns.find(
            (turn) =>
              turn.role === "assistant" &&
              turn.toolCalls?.[0]?.id === "pptx_bad",
          );

        expect(
          echoed &&
            echoed.role === "assistant"
            ? JSON.parse(
                echoed.toolCalls![0]!.argumentsJson,
              )
            : undefined,
        ).toEqual(
          INVALID_PPTX_ARGS,
        );

        const envelope =
          envelopeFor(
            next,
            "pptx_bad",
          );

        expect(envelope.status).toBe(
          "not_executed",
        );
        expect(envelope.error_code).toBe(
          "TOOL_ARGUMENT_VALIDATION_FAILED",
        );

        const guidance =
          String(
            envelope.output,
          );

        expect(guidance).toContain(
          "Not executed: the arguments for create_pptx were rejected before the tool ran, so nothing was done.",
        );
        expect(guidance).toContain(
          'Validation error: slides[0].type must be "title", "content", or "chart".',
        );
        expect(guidance).toContain(
          'slides: array (at least 1) of { type: "title"',
        );
        expect(guidance).toContain(
          `Example arguments: ${JSON.stringify(
            TOOLS.find(
              (tool) =>
                tool.name === "create_pptx",
            )!.examples[0]!.arguments,
          )}`,
        );

        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: "Created launch.pptx.",
        });
      },
    );

    it(
      "puts the rejected arguments in diagnostics only, never in model history",
      async () => {
        const raw =
          '{"path":"launch.pptx","slides":[{"type":"bullets"';

        const client =
          scriptedNativeClient([
            {
              content: null,
              toolCalls: [
                {
                  id: "pptx_bad",
                  name: "create_pptx",
                  argumentsJson: raw,
                },
              ],
            },
            text(
              "I could not create the presentation.",
            ),
          ]);

        const {
          events,
        } = await runTurn(
          client,
          scriptedExecutor([]),
        );

        const notes =
          diagnostics(
            events,
          );

        expect(
          notes.some(
            (note) =>
              note.includes(
                'NativeStrategy rejected arguments for "create_pptx" (call pptx_bad, TOOL_ARGUMENTS_INVALID_JSON)',
              ) &&
              note.includes(
                `Rejected arguments: ${raw}`,
              ),
          ),
        ).toBe(true);

        // Echoed as {} so a gateway that parses arguments never sees the
        // malformed text.
        expect(
          JSON.stringify(
            client.requests[1]!.turns,
          ),
        ).not.toContain(
          '\\"type\\":\\"bullets\\"',
        );
      },
    );

    it(
      `allows ${MAX_ARGUMENT_CORRECTIONS} corrections per tool and ends the turn on the next rejection`,
      async () => {
        const bad =
          (id: string) =>
            call(
              id,
              "create_pptx",
              INVALID_PPTX_ARGS,
            );

        // Exactly MAX_ARGUMENT_CORRECTIONS rejections: the turn continues.
        const withinCap =
          scriptedNativeClient([
            bad("r1"),
            bad("r2"),
            call(
              "ok",
              "create_pptx",
              PPTX_ARGS,
            ),
            text(
              "Created launch.pptx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              output: "Created PPTX file.",
            },
          ]);

        const within =
          await runTurn(
            withinCap,
            executor,
          );

        expect(executor.calls).toHaveLength(1);
        expect(within.outcome).toMatchObject({
          kind: "final_answer",
          text: "Created launch.pptx.",
        });

        // One more: the turn ends, and the model is not called again.
        const pastCap =
          scriptedNativeClient([
            bad("r1"),
            bad("r2"),
            bad("r3"),
          ]);

        const none =
          scriptedExecutor([]);

        const past =
          await runTurn(
            pastCap,
            none,
          );

        expect(none.calls).toHaveLength(0);
        expect(pastCap.requests).toHaveLength(
          MAX_ARGUMENT_CORRECTIONS + 1,
        );
        expect(past.outcome).toMatchObject({
          kind: "final_answer",
          alreadyDisplayed: false,
        });
        expect(
          diagnostics(
            past.events,
          ).some(
            (note) =>
              note.includes(
                'Argument rejections for "create_pptx" reached the limit (3 rejected calls, 2 corrections allowed)',
              ),
          ),
        ).toBe(true);
      },
    );

    it(
      "counts the cap per tool: rejections for one tool do not use up another tool's corrections",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "p1",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p2",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "d1",
              "create_docx",
              {
                path: "status.docx",
              },
            ),
            call(
              "d2",
              "create_docx",
              DOCX_ARGS,
            ),
            text(
              "Created status.docx; launch.pptx was not created.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              output: "Created DOCX file.",
            },
          ]);

        const {
          outcome,
        } = await runTurn(
          client,
          executor,
        );

        expect(executor.calls).toHaveLength(1);
        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: "Created status.docx; launch.pptx was not created.",
        });
      },
    );

    it(
      "restores a tool's corrections once a call to it succeeds",
      async () => {
        const second = {
          ...PPTX_ARGS,
          path: "launch-appendix.pptx",
        };

        const client =
          scriptedNativeClient([
            call(
              "p1",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p2",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p3",
              "create_pptx",
              PPTX_ARGS,
            ),
            call(
              "p4",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p5",
              "create_pptx",
              second,
            ),
            text(
              "Created launch.pptx and launch-appendix.pptx.",
            ),
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              output: "Created PPTX file.",
            },
            {
              success: true,
              output: "Created PPTX file.",
            },
          ]);

        const {
          outcome,
        } = await runTurn(
          client,
          executor,
        );

        expect(executor.calls).toHaveLength(2);
        expect(outcome).toMatchObject({
          kind: "final_answer",
          text: "Created launch.pptx and launch-appendix.pptx.",
        });
      },
    );

    it(
      "keeps completed work in the truthful partial answer when the cap ends the turn",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "d1",
              "create_docx",
              DOCX_ARGS,
            ),
            call(
              "p1",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p2",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p3",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              verified: true,
              output:
                "Created DOCX file at /work/status.docx (8 KB).",
            },
          ]);

        const {
          outcome,
        } = await runTurn(
          client,
          executor,
        );

        expect(executor.calls).toHaveLength(1);

        const answer =
          outcome.kind === "final_answer"
            ? outcome.text
            : "";

        expect(answer).toContain(
          "I stopped because the model repeatedly supplied invalid arguments for create_pptx, so it was never run.",
        );
        expect(answer).toContain(
          "1. create_docx (status.docx): succeeded; the tool's own check of its output passed.",
        );
        expect(answer).toContain(
          "2. create_pptx (launch.pptx): rejected before running (invalid arguments).",
        );
        expect(answer).toContain(
          "4. create_pptx (launch.pptx): rejected before running (invalid arguments).",
        );
        expect(answer).not.toMatch(
          /create_pptx[^\n]*: (succeeded|failed)/,
        );
      },
    );

    it(
      "keeps a rejected call distinct from a real execution failure in the ledger",
      async () => {
        const client =
          scriptedNativeClient([
            call(
              "p1",
              "create_pptx",
              INVALID_PPTX_ARGS,
            ),
            call(
              "p2",
              "create_pptx",
              PPTX_ARGS,
            ),
            text(
              "The presentation could not be created.",
            ),
          ]);

        const {
          events,
        } = await runTurn(
          client,
          scriptedExecutor([
            {
              success: false,
              output:
                "PPTX generation failed: disk full.",
            },
          ]),
        );

        const ledger =
          buildExecutionLedger(
            events,
          );

        expect(
          ledger.map(
            (entry) =>
              entry.status,
          ),
        ).toEqual([
          "rejected",
          "failed",
        ]);

        const rendered =
          renderExecutionLedger(
            ledger,
          );

        expect(rendered).toContain(
          "1. create_pptx (launch.pptx): rejected before running (invalid arguments). Output: slides[0].type must be",
        );
        expect(rendered).toContain(
          "2. create_pptx (launch.pptx): failed. Output: PPTX generation failed: disk full.",
        );
      },
    );
  },
);

describe(
  "argument-guidance.ts",
  () => {
    it(
      "summarizes a schema compactly, marking optional fields",
      () => {
        expect(
          summarizeExpectedArguments({
            type: "object",
            properties: {
              path: {
                type: "string",
              },
              mode: {
                enum: [
                  "a",
                  "b",
                ],
              },
              rows: {
                type: "array",
                minItems: 1,
                items: {
                  type: "number",
                },
              },
            },
            required: [
              "path",
              "rows",
            ],
          }),
        ).toBe(
          '{ path: string, mode?: "a" | "b", rows: array (at least 1) of number }',
        );
      },
    );

    it(
      "fits the summary of every built-in tool within its bound",
      () => {
        for (
          const tool of TOOLS
        ) {
          const summary =
            summarizeExpectedArguments(
              tool.parameters,
            );

          expect(
            summary.length,
          ).toBeLessThanOrEqual(
            1203,
          );
          expect(summary).not.toBe(
            "any",
          );
        }
      },
    );

    it(
      "never ends with an empty validation error",
      () => {
        const guidance =
          buildArgumentRejectionText(
            undefined,
            "create_pptx",
            "TOOL_ARGUMENT_VALIDATION_FAILED",
            "",
          );

        expect(guidance).toContain(
          "Validation error: no further detail was reported.",
        );
        expect(guidance).not.toContain(
          "Expected arguments",
        );
      },
    );
  },
);
