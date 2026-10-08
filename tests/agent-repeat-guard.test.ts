import {
  describe,
  expect,
  it,
} from "vitest";

import {
  canonicalizeArguments,
  MAX_IDENTICAL_FAILURES,
  RepeatGuard,
} from "../src/agent/repeat-guard.ts";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import {
  NativeFirstStrategy,
} from "../src/agent/strategies/native-first.ts";

import {
  PromptedStrategy,
} from "../src/agent/strategies/prompted.ts";

import {
  NativeSupportCache,
} from "../src/agent/native-support.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  NativeConversationTurn,
} from "../src/agent/model-client.ts";

import type {
  AgentAction,
  AgentEvent,
  AgentToolResult,
  ToolCallStrategy,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

const TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const DOCX_ARGS = {
  path: "northbridge-summary.docx",
  content: "# Northbridge Office Electrical Upgrade\n\nClient: Daniel Mercer",
};

const XLSX_ARGS = {
  path: "northbridge-summary.xlsx",
  sheets: [
    {
      name: "Summary",
      headers: [
        "Field",
        "Value",
      ],
      rows: [
        [
          "Budget (CAD)",
          3250,
        ],
      ],
    },
  ],
};

const DOCX_EXISTS =
  "northbridge-summary.docx already exists. Sky Code will never overwrite an existing file without being told to.";

describe(
  "agent/repeat-guard.ts",
  () => {
    it(
      "treats arguments that differ only in key order as identical",
      () => {
        expect(
          canonicalizeArguments({
            b: 1,
            a: {
              y: [
                {
                  d: 1,
                  c: 2,
                },
              ],
              x: "s",
            },
          }),
        ).toBe(
          canonicalizeArguments({
            a: {
              x: "s",
              y: [
                {
                  c: 2,
                  d: 1,
                },
              ],
            },
            b: 1,
          }),
        );
      },
    );

    it(
      "allows the first attempt and one identical repeat, then blocks once the same failure has repeated",
      () => {
        expect(MAX_IDENTICAL_FAILURES).toBe(2);

        const guard =
          new RepeatGuard();

        expect(
          guard.check(
            "create_docx",
            DOCX_ARGS,
          ).blocked,
        ).toBe(false);

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          DOCX_EXISTS,
        );

        expect(
          guard.check(
            "create_docx",
            DOCX_ARGS,
          ).blocked,
        ).toBe(false);

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          DOCX_EXISTS,
        );

        expect(
          guard.check(
            "create_docx",
            DOCX_ARGS,
          ),
        ).toEqual({
          blocked: true,
          failures: 2,
          lastOutput: DOCX_EXISTS,
          priorBlocks: 0,
        });
      },
    );

    it(
      "never blocks different arguments, a different tool, or a repeat whose failure output changed",
      () => {
        const guard =
          new RepeatGuard();

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          "transient error A",
        );

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          "transient error B",
        );

        expect(
          guard.check(
            "create_docx",
            DOCX_ARGS,
          ).blocked,
        ).toBe(false);

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          "transient error B",
        );

        expect(
          guard.check(
            "create_docx",
            {
              ...DOCX_ARGS,
              path: "northbridge-summary-v2.docx",
            },
          ).blocked,
        ).toBe(false);

        expect(
          guard.check(
            "create_pdf",
            DOCX_ARGS,
          ).blocked,
        ).toBe(false);
      },
    );

    it(
      "never blocks a successful action, and a success clears earlier failures",
      () => {
        const guard =
          new RepeatGuard();

        for (
          let i = 0;
          i < 5;
          i += 1
        ) {
          guard.recordResult(
            "read_file",
            {
              path: "a.txt",
            },
            true,
            "contents",
          );
        }

        expect(
          guard.check(
            "read_file",
            {
              path: "a.txt",
            },
          ).blocked,
        ).toBe(false);

        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          DOCX_EXISTS,
        );
        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          true,
          "Created",
        );
        guard.recordResult(
          "create_docx",
          DOCX_ARGS,
          false,
          DOCX_EXISTS,
        );

        expect(
          guard.check(
            "create_docx",
            DOCX_ARGS,
          ).blocked,
        ).toBe(false);
      },
    );
  },
);

/** A native client driven by a fixed script, recording deep copies of every request. */
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

function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async execute(tool) {
      calls.push(tool);

      const next =
        results[calls.length - 1];

      if (!next) {
        throw new Error(
          "scriptedExecutor ran out of scripted results",
        );
      }

      return next;
    },
  };
}

function toolTurns(
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

describe(
  "repeated-action breaker in the agent loop (the gemma4-e2b-sky live failure)",
  () => {
    it(
      "successful DOCX, malformed XLSX corrected, regression to the same DOCX twice, third repeat blocked, then the loop stays native and creates the XLSX",
      async () => {
        const client =
          scriptedNativeClient([
            // 1. The DOCX succeeds.
            call(
              "c1",
              "create_docx",
              DOCX_ARGS,
            ),
            // 2. Malformed XLSX arguments: rejected, nothing executed...
            {
              content: null,
              toolCalls: [
                {
                  id: "bad",
                  name: "create_xlsx",
                  argumentsJson:
                    '{"path":"northbridge-summary.xlsx","sheets":[{"name":"Summary",',
                },
              ],
            },
            // 3. ...and the model regresses to the already-created DOCX.
            call(
              "c2",
              "create_docx",
              DOCX_ARGS,
            ),
            // 4. It repeats the same failing call once more.
            call(
              "c3",
              "create_docx",
              DOCX_ARGS,
            ),
            // 5. A third identical request: must not run again.
            call(
              "c4",
              "create_docx",
              {
                content: DOCX_ARGS.content,
                path: DOCX_ARGS.path,
              },
            ),
            // 6. Told why, the model moves on to the real remaining work.
            call(
              "c5",
              "create_xlsx",
              XLSX_ARGS,
            ),
            {
              content:
                "Created northbridge-summary.docx and northbridge-summary.xlsx.",
              toolCalls: [],
            },
          ]);

        const executor =
          scriptedExecutor([
            {
              success: true,
              verified: true,
              output:
                "Created DOCX file at /work/northbridge-summary.docx (8 KB).",
            },
            {
              success: false,
              output: DOCX_EXISTS,
            },
            {
              success: false,
              output: DOCX_EXISTS,
            },
            {
              success: true,
              verified: true,
              output:
                "Created XLSX file at /work/northbridge-summary.xlsx (6 KB).",
            },
          ]);

        const neverPrompted = {
          async complete(): Promise<string> {
            throw new Error(
              "PromptedStrategy must not be used: repetition is not a protocol failure",
            );
          },
        };

        const cache =
          new NativeSupportCache();

        const strategy =
          new NativeFirstStrategy(
            new NativeStrategy(
              client,
              "native system prompt",
            ),
            new PromptedStrategy(
              neverPrompted,
            ),
            cache,
            "http://litellm.test/v1",
          );

        const events: AgentEvent[] = [];

        const outcome =
          await runAgentLoop(
            "Create a DOCX and an XLSX project summary for Northbridge.",
            [],
            strategy,
            TOOLS,
            "gemma4-e2b-sky",
            executor,
            {
              async produce() {
                throw new Error(
                  "FinalAnswerProducer must not be used",
                );
              },
            },
            (event) =>
              events.push(event),
          );

        // The DOCX ran three times (one success, two identical failures); the
        // third identical repeat never reached the executor.
        expect(executor.calls).toEqual([
          "create_docx",
          "create_docx",
          "create_docx",
          "create_xlsx",
        ]);

        expect(outcome).toEqual({
          kind: "final_answer",
          text: "Created northbridge-summary.docx and northbridge-summary.xlsx.",
          alreadyDisplayed: false,
        });

        // Canonical native history: the blocked call c4 has its assistant
        // tool call and a matching role:"tool" result marked not executed.
        const beforeXlsx =
          client.requests[5]!;

        const blockedAnswer =
          toolTurns(beforeXlsx).find(
            (turn) =>
              turn.toolCallId === "c4",
          )!;

        expect(
          JSON.parse(
            blockedAnswer.content,
          ),
        ).toMatchObject({
          status: "not_executed",
        });

        expect(
          JSON.parse(
            blockedAnswer.content,
          ).output,
        ).toContain(
          "already failed 2 times",
        );

        expect(
          beforeXlsx.turns.some(
            (turn) =>
              turn.role === "assistant" &&
              turn.toolCalls?.some(
                (toolCall) =>
                  toolCall.id === "c4",
              ),
          ),
        ).toBe(true);

        // Recorded as skipped, never as a real failure or as running.
        const c4States =
          events
            .filter(
              (event) =>
                event.type ===
                  "tool_state_changed" &&
                event.callId === "c4",
            )
            .map(
              (event) =>
                (event as { state: string }).state,
            );

        expect(c4States).toEqual([
          "skipped",
        ]);

        expect(
          events.find(
            (event) =>
              event.type ===
                "tool_result" &&
              event.callId === "c4",
          ),
        ).toMatchObject({
          success: false,
          notExecuted: true,
        });

        // Still native: no fallback recorded.
        expect(
          cache.get(
            "http://litellm.test/v1",
            "gemma4-e2b-sky",
          ),
        ).toBeUndefined();

        // The breaker's note is diagnostic only, never model-visible history.
        expect(
          events.some(
            (event) =>
              event.type ===
                "protocol_condition" &&
              event.detail.startsWith(
                "Repeated-action breaker",
              ),
          ),
        ).toBe(true);

        expect(
          JSON.stringify(
            client.requests.at(-1)!.turns,
          ),
        ).not.toContain(
          "Repeated-action breaker",
        );
      },
    );

    it(
      "applies to every strategy, not only native",
      async () => {
        const actions: AgentAction[] = [
          {
            kind: "tool_call",
            tool: "write_file",
            arguments: {
              path: "a.txt",
              content: "x",
            },
            callId: "1",
          },
          {
            kind: "tool_call",
            tool: "write_file",
            arguments: {
              path: "a.txt",
              content: "x",
            },
            callId: "2",
          },
          {
            kind: "tool_call",
            tool: "write_file",
            arguments: {
              path: "a.txt",
              content: "x",
            },
            callId: "3",
          },
          {
            kind: "final_answer",
            text: "Writing a.txt failed: permission denied.",
            alreadyDisplayed: true,
          },
        ];

        let step = 0;

        const scripted: ToolCallStrategy = {
          async getNextAction() {
            const next =
              actions[step]!;

            step += 1;

            return next;
          },
        };

        const executor =
          scriptedExecutor([
            {
              success: false,
              output: "Permission denied.",
            },
            {
              success: false,
              output: "Permission denied.",
            },
          ]);

        await runAgentLoop(
          "write a.txt",
          [],
          scripted,
          TOOLS,
          "any-model",
          executor,
          {
            async produce() {
              return "";
            },
          },
        );

        expect(executor.calls).toHaveLength(2);
      },
    );
  },
);
