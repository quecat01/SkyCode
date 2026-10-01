import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  completeConversationTurn,
} from "../src/index.ts";

import {
  LegacyStrategy,
} from "../src/agent/strategies/legacy.ts";

import type {
  ChatMessage,
} from "../src/chat.ts";

import type {
  SessionLogger,
  SessionRecordInput,
} from "../src/session.ts";

import type {
  PlainConversationTurn,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

import type {
  AgentAction,
  AgentContext,
  AgentEvent,
  AgentToolResult,
  FinalAnswerProducer,
  ToolCallStrategy,
  ToolDefinition,
  ToolExecutor,
} from "../src/agent/types.ts";

/**
 * Integration tests for completeConversationTurn() (index.ts), the live
 * CLI's actual turn-completion entry point since the agent-loop wiring
 * replaced its body. Earlier *-live.test.ts files in this suite only pin
 * index.ts's source text (necessary for a file with no other tests, but not
 * sufficient on its own): they can confirm a given call site still exists,
 * but never actually execute completeConversationTurn() or observe its real
 * behavior. These tests do - completeConversationTurn() is exported
 * specifically so they can import and call it directly, exactly as runCli()
 * does, with fakes only at the true I/O boundaries (session logging, tool
 * execution, and - for one scenario - the model completion itself).
 *
 * legacyCompleteConversationTurn() (the preserved pre-agent-loop
 * implementation, kept temporarily per the same file's own doc comment) is
 * deliberately not exercised here: it is dead code, retained only so
 * tests/validation-retry-live.test.ts's source-text assertions keep
 * passing, not a path any of these tests should validate.
 */

/** No tools needed for scenarios that never reach real argument
 * validation against a specific schema. */
const NO_TOOLS: ToolDefinition[] = [];

const WRITE_FILE_TOOL: ToolDefinition = {
  name: "write_file",
  description: "Writes a file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      content: {
        type: "string",
      },
    },
    required: [
      "path",
      "content",
    ],
  },
  examples: [],
  permissionCategory: "write-file",
};

/**
 * A SessionLogger fake that records every record it was asked to persist,
 * in the order append() was called, and resolves each append()
 * asynchronously (a microtask tick later) so a test can tell the difference
 * between "queued" and "actually awaited" - exactly the distinction
 * completeConversationTurn's pendingLogWrites/finally block exists to get
 * right (see its own doc comment, index.ts).
 */
function fakeSessionLogger(): SessionLogger & {
  records: SessionRecordInput[];
} {
  const records: SessionRecordInput[] = [];

  return {
    sessionId: "fake-session",
    filePath: "/fake/session.jsonl",
    records,
    async append(record) {
      await Promise.resolve();
      records.push(record);
    },
  };
}

/** A strategy driven by a fixed script of actions, one per call. Also
 * records the AgentContext each call actually observed. */
function scriptedStrategy(
  actions: AgentAction[],
): ToolCallStrategy & {
  observedContexts: AgentContext[];
} {
  const observedContexts: AgentContext[] = [];
  let callIndex = 0;

  return {
    observedContexts,
    async getNextAction(context) {
      observedContexts.push({
        priorTurns: [
          ...context.priorTurns,
        ],
        goal: context.goal,
        history: [
          ...context.history,
        ],
      });

      const action =
        actions[callIndex];

      callIndex += 1;

      if (!action) {
        throw new Error(
          "scriptedStrategy called more times than it has scripted actions",
        );
      }

      return action;
    },
  };
}

/** A ToolExecutor driven by a fixed script of results, recording every
 * (tool, args) pair it was actually invoked with. */
function scriptedExecutor(
  results: AgentToolResult[],
): ToolExecutor & {
  calls: {
    tool: string;
    args: unknown;
  }[];
} {
  const calls: {
    tool: string;
    args: unknown;
  }[] = [];

  let callIndex = 0;

  return {
    calls,
    async execute(tool, args) {
      calls.push({
        tool,
        args,
      });

      const result =
        results[callIndex];

      callIndex += 1;

      if (!result) {
        throw new Error(
          "scriptedExecutor called more times than it has scripted results",
        );
      }

      return result;
    },
  };
}

/** A FinalAnswerProducer that always returns a fixed, distinguishable
 * string, for scenarios that must never actually reach it. */
function unusedFinalAnswerProducer(): FinalAnswerProducer {
  return {
    async produce() {
      throw new Error(
        "finalAnswerProducer.produce() should not have been called in this scenario",
      );
    },
  };
}

/** A TextCompletionClient driven by a fixed script of raw text responses,
 * for exercising a real strategy (LegacyStrategy) against a scripted model. */
function scriptedTextClient(
  responses: string[],
): TextCompletionClient {
  let callIndex = 0;

  return {
    async complete() {
      const response =
        responses[callIndex];

      callIndex += 1;

      if (response === undefined) {
        throw new Error(
          "scriptedTextClient called more times than it has scripted responses",
        );
      }

      return response;
    },
  };
}

/** Builds one complete, valid sky-tool fenced block for a given request. */
function skyToolBlock(
  tool: string,
  args: unknown,
): string {
  return [
    "```sky-tool",
    JSON.stringify({
      tool,
      args,
    }),
    "```",
  ].join("\n");
}

describe(
  "index.ts completeConversationTurn (live agent-loop path)",
  () => {
    it(
      "executes a real tool call end to end: records tool_requested/tool_result agent_events, appends the final answer message, and awaits every session-log write before returning",
      async () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "please write notes.md",
          },
        ];

        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "write_file",
            arguments: {
              path: "notes.md",
              content: "hello",
            },
            callId: "call-1",
          },
          {
            kind: "final_answer",
            text: "I wrote notes.md for you.",
            alreadyDisplayed: true,
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "Wrote notes.md.",
          },
        ]);

        const sessionLogger =
          fakeSessionLogger();

        await completeConversationTurn(
          "fake-model",
          messages,
          sessionLogger,
          strategy,
          [
            WRITE_FILE_TOOL,
          ],
          executor,
          unusedFinalAnswerProducer(),
        );

        // The tool actually ran, with the real arguments the strategy
        // proposed.
        expect(executor.calls).toEqual([
          {
            tool: "write_file",
            args: {
              path: "notes.md",
              content: "hello",
            },
          },
        ]);

        // Conversation history gained exactly the turn's own final answer.
        expect(messages).toEqual([
          {
            role: "user",
            content: "please write notes.md",
          },
          {
            role: "assistant",
            content: "I wrote notes.md for you.",
          },
        ]);

        // Every queued session write was actually awaited before
        // completeConversationTurn() returned - this is the "collected and
        // awaited pendingLogWrites" contract (see its own doc comment,
        // index.ts), not merely "eventually queued".
        const agentEventRecords =
          sessionLogger.records.filter(
            (record): record is SessionRecordInput & {
              agentEvent: AgentEvent;
            } =>
              record.type === "agent_event",
          );

        const recordedTypes =
          agentEventRecords.map(
            (record) => record.agentEvent.type,
          );

        expect(recordedTypes).toEqual([
          "tool_requested",
          "tool_state_changed",
          "tool_state_changed",
          "tool_result",
          "final_answer",
        ]);

        const messageRecords =
          sessionLogger.records.filter(
            (record) => record.type === "message",
          );

        expect(messageRecords).toEqual([
          {
            type: "message",
            role: "assistant",
            content: "I wrote notes.md for you.",
            model: "fake-model",
          },
        ]);
      },
    );

    it(
      "runs a real strategy's own corrective-retry loop end to end (LegacyStrategy against a scripted model), and captures the correction as a diagnostic agent_event rather than losing it",
      async () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "please write notes.md",
          },
        ];

        // First response: malformed sky-tool JSON. LegacyStrategy's own
        // internal corrective retry (not completeConversationTurn's - that
        // machinery was removed along with legacyCompleteConversationTurn's
        // retirement from the live path) feeds this back and tries again.
        // A third response lets the turn conclude with a final answer once
        // the tool has run.
        const client = scriptedTextClient([
          "```sky-tool\n{not valid json\n```",
          skyToolBlock(
            "write_file",
            {
              path: "notes.md",
              content: "hello",
            },
          ),
          "All done - notes.md has been written.",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const executor = scriptedExecutor([
          {
            success: true,
            output: "Wrote notes.md.",
          },
        ]);

        const sessionLogger =
          fakeSessionLogger();

        await completeConversationTurn(
          "fake-model",
          messages,
          sessionLogger,
          strategy,
          [
            WRITE_FILE_TOOL,
          ],
          executor,
          unusedFinalAnswerProducer(),
        );

        expect(executor.calls).toEqual([
          {
            tool: "write_file",
            args: {
              path: "notes.md",
              content: "hello",
            },
          },
        ]);

        expect(messages.at(-1)).toEqual({
          role: "assistant",
          content: "All done - notes.md has been written.",
        });

        // The corrective retry is not part of the executed-tool history
        // (LegacyStrategy's own doc comment: "internal scratch"), but it
        // must still reach the session log as a diagnostic protocol_condition
        // - not silently lost, and not printed to the terminal (see the
        // next assertion).
        const diagnosticRecords =
          sessionLogger.records.filter(
            (record) =>
              record.type === "agent_event" &&
              record.agentEvent?.type === "protocol_condition",
          );

        expect(diagnosticRecords).toHaveLength(1);

        const diagnosticEvent =
          diagnosticRecords[0]!.agentEvent;

        if (diagnosticEvent?.type === "protocol_condition") {
          expect(diagnosticEvent.detail).toContain(
            "LegacyStrategy corrective retry",
          );
        }
      },
    );

    it(
      "derives goal/priorTurns from the live messages array and feeds every strategy call the same real history",
      async () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "earlier: please create a README",
          },
          {
            role: "assistant",
            content: "Created README.md.",
          },
          {
            role: "user",
            content: "now add a LICENSE file",
          },
        ];

        const strategy = scriptedStrategy([
          {
            kind: "final_answer",
            text: "Added LICENSE.",
            alreadyDisplayed: true,
          },
        ]);

        const sessionLogger =
          fakeSessionLogger();

        await completeConversationTurn(
          "fake-model",
          messages,
          sessionLogger,
          strategy,
          NO_TOOLS,
          scriptedExecutor([]),
          unusedFinalAnswerProducer(),
        );

        expect(strategy.observedContexts).toHaveLength(1);

        const observed =
          strategy.observedContexts[0]!;

        const expectedPriorTurns: PlainConversationTurn[] = [
          {
            role: "user",
            content: "earlier: please create a README",
          },
          {
            role: "assistant",
            content: "Created README.md.",
          },
        ];

        expect(observed.priorTurns).toEqual(
          expectedPriorTurns,
        );

        expect(observed.goal).toBe(
          "now add a LICENSE file",
        );

        // The current goal must never be re-stated inside priorTurns.
        expect(
          observed.priorTurns.some(
            (turn) =>
              turn.content === "now add a LICENSE file",
          ),
        ).toBe(
          false,
        );

        // messages gained exactly the new assistant turn, in order.
        expect(messages).toEqual([
          {
            role: "user",
            content: "earlier: please create a README",
          },
          {
            role: "assistant",
            content: "Created README.md.",
          },
          {
            role: "user",
            content: "now add a LICENSE file",
          },
          {
            role: "assistant",
            content: "Added LICENSE.",
          },
        ]);
      },
    );

    describe(
      "final-answer display (Native, Prompted, Legacy)",
      () => {
        it(
          "renders a not-already-displayed final answer (Native-style) through the Markdown rendering system exactly once",
          async () => {
            const messages: ChatMessage[] = [
              {
                role: "user",
                content: "say hello",
              },
            ];

            const strategy = scriptedStrategy([
              {
                kind: "final_answer",
                text: "Plain text native answer.",
                alreadyDisplayed: false,
              },
            ]);

            const writeSpy = vi.spyOn(
              process.stdout,
              "write",
            ).mockImplementation(
              () => true,
            );

            let written = "";

            try {
              await completeConversationTurn(
                "fake-model",
                messages,
                fakeSessionLogger(),
                strategy,
                NO_TOOLS,
                scriptedExecutor([]),
                unusedFinalAnswerProducer(),
              );

              // Read the recorded calls while the spy is still installed:
              // mockRestore() below also resets call history (it implies
              // mockReset()), so reading writeSpy.mock.calls after it runs
              // would silently see an empty array and let every assertion
              // below pass vacuously.
              written =
                writeSpy.mock.calls
                  .map((call) => String(call[0]))
                  .join("");
            } finally {
              writeSpy.mockRestore();
            }

            // Not already displayed: completeConversationTurn must render it
            // itself, through the same Markdown system a streamed response
            // uses - so the text actually reaches the terminal.
            expect(written).toContain(
              "Plain text native answer.",
            );

            // Rendered exactly once: the raw text must not appear twice back
            // to back (which a double-render bug would produce).
            const occurrences =
              written.split(
                "Plain text native answer.",
              ).length -
              1;

            expect(occurrences).toBe(
              1,
            );
          },
        );

        it(
          "never re-renders an already-displayed final answer (Legacy-style: streamed live by the strategy's own client)",
          async () => {
            const messages: ChatMessage[] = [
              {
                role: "user",
                content: "say hello",
              },
            ];

            const strategy = scriptedStrategy([
              {
                kind: "final_answer",
                text: "Plain text legacy answer, already on screen.",
                alreadyDisplayed: true,
              },
            ]);

            const writeSpy = vi.spyOn(
              process.stdout,
              "write",
            ).mockImplementation(
              () => true,
            );

            let written = "";

            try {
              await completeConversationTurn(
                "fake-model",
                messages,
                fakeSessionLogger(),
                strategy,
                NO_TOOLS,
                scriptedExecutor([]),
                unusedFinalAnswerProducer(),
              );

              // Read the recorded calls while the spy is still installed:
              // mockRestore() below also resets call history (it implies
              // mockReset()), so reading writeSpy.mock.calls after it runs
              // would silently see an empty array and let this assertion
              // pass vacuously.
              written =
                writeSpy.mock.calls
                  .map((call) => String(call[0]))
                  .join("");
            } finally {
              writeSpy.mockRestore();
            }

            // Already displayed (by whatever streamed it live, outside this
            // fake scenario entirely): completeConversationTurn must never
            // write the answer text itself - only trailing spacing.
            expect(written).not.toContain(
              "Plain text legacy answer, already on screen.",
            );

            // Confirm the spy actually captured something real (spacing),
            // so "not.toContain" above is a genuine negative, not an
            // artifact of an empty capture.
            expect(written.length).toBeGreaterThan(
              0,
            );
          },
        );

        it(
          "renders a done-outcome final answer (Prompted-style, produced by the final-answer producer) as already displayed, without re-rendering it",
          async () => {
            const messages: ChatMessage[] = [
              {
                role: "user",
                content: "say hello",
              },
            ];

            const strategy = scriptedStrategy([
              {
                kind: "done",
              },
            ]);

            const finalAnswerProducer: FinalAnswerProducer = {
              async produce() {
                return "Plain text prompted answer, already on screen.";
              },
            };

            const writeSpy = vi.spyOn(
              process.stdout,
              "write",
            ).mockImplementation(
              () => true,
            );

            let written = "";

            try {
              await completeConversationTurn(
                "fake-model",
                messages,
                fakeSessionLogger(),
                strategy,
                NO_TOOLS,
                scriptedExecutor([]),
                finalAnswerProducer,
              );

              // Read the recorded calls while the spy is still installed:
              // mockRestore() below also resets call history (it implies
              // mockReset()), so reading writeSpy.mock.calls after it runs
              // would silently see an empty array and let this assertion
              // pass vacuously.
              written =
                writeSpy.mock.calls
                  .map((call) => String(call[0]))
                  .join("");
            } finally {
              writeSpy.mockRestore();
            }

            // FinalAnswerProducer's documented contract (types.ts) is that
            // its text is always already shown to the user, so, exactly like
            // the Legacy case above, completeConversationTurn must not
            // re-render it.
            expect(written).not.toContain(
              "Plain text prompted answer, already on screen.",
            );

            // Confirm the spy actually captured something real (spacing),
            // so "not.toContain" above is a genuine negative, not an
            // artifact of an empty capture.
            expect(written.length).toBeGreaterThan(
              0,
            );

            expect(messages.at(-1)).toEqual({
              role: "assistant",
              content:
                "Plain text prompted answer, already on screen.",
            });
          },
        );
      },
    );

    it(
      "records a background task's return_to_prompt as a verbatim assistant message, never as a model-produced final_answer event, and never rephrased",
      async () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "run this in the background",
          },
        ];

        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "run_shell_command",
            arguments: {
              command: "long-running-build",
              background: true,
            },
            callId: "call-1",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "Started background task \"long-running-build\" (id: task-1).",
            endsTurn: true,
          },
        ]);

        const sessionLogger =
          fakeSessionLogger();

        const logSpy = vi.spyOn(
          console,
          "log",
        ).mockImplementation(
          () => undefined,
        );

        try {
          await completeConversationTurn(
            "fake-model",
            messages,
            sessionLogger,
            strategy,
            NO_TOOLS,
            executor,
            unusedFinalAnswerProducer(),
          );
        } finally {
          logSpy.mockRestore();
        }

        // The tool's own real output, verbatim - not a model-produced
        // final_answer, and never rephrased or embellished.
        expect(messages.at(-1)).toEqual({
          role: "assistant",
          content:
            "Started background task \"long-running-build\" (id: task-1).",
        });

        const finalAnswerEvents =
          sessionLogger.records.filter(
            (record) =>
              record.type === "agent_event" &&
              record.agentEvent?.type === "final_answer",
          );

        expect(finalAnswerEvents).toHaveLength(0);

        const messageRecords =
          sessionLogger.records.filter(
            (record) => record.type === "message",
          );

        expect(messageRecords).toEqual([
          {
            type: "message",
            role: "assistant",
            content:
              "Started background task \"long-running-build\" (id: task-1).",
            model: "fake-model",
          },
        ]);
      },
    );
  },
);
