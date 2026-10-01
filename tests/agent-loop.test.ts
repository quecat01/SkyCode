import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  runAgentLoop,
} from "../src/agent/loop.ts";

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

import type {
  PlainConversationTurn,
} from "../src/agent/model-client.ts";

/** Empty tool list: these loop-level tests never inspect it, only pass it
 * through unchanged to the strategy on every call. */
const NO_TOOLS: ToolDefinition[] = [];

/** Empty prior-turns list, for tests that are not specifically exercising
 * cross-turn history. */
const NO_PRIOR_TURNS: PlainConversationTurn[] = [];

const MODEL = "fake-model";

/**
 * A strategy driven by a fixed script of actions, one per call. Also
 * records the AgentContext it was given on each call so tests can assert on
 * exactly what history (and prior turns) a step observed.
 */
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
      // Deep-ish copy of history so later mutation of the live context
      // cannot make an earlier assertion silently pass.
      observedContexts.push({
        priorTurns: [...context.priorTurns],
        goal: context.goal,
        history: [...context.history],
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

/** A fixed strategy that always proposes another tool call, for the
 * runaway-loop guard test. */
function alwaysAnotherToolCallStrategy(
  tool: string,
): ToolCallStrategy {
  let counter = 0;

  return {
    async getNextAction() {
      counter += 1;

      return {
        kind: "tool_call",
        tool,
        arguments: {
          n: counter,
        },
        callId: `call-${counter}`,
      };
    },
  };
}

/** An executor driven by a fixed script of results, one per call, that also
 * records every (tool, args) pair it was actually invoked with. */
function scriptedExecutor(
  results: (AgentToolResult | Error)[],
): ToolExecutor & {
  calls: { tool: string; args: unknown }[];
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

      if (result instanceof Error) {
        throw result;
      }

      if (!result) {
        throw new Error(
          "scriptedExecutor called more times than it has scripted results",
        );
      }

      return result;
    },
  };
}

/** A FinalAnswerProducer that records every call's full AgentContext and
 * returns a fixed string, distinguishable from anything a strategy could
 * have said. */
function fakeFinalAnswerProducer(
  text: string,
): FinalAnswerProducer & {
  calls: AgentContext[];
} {
  const calls: AgentContext[] = [];

  return {
    calls,
    async produce(context) {
      calls.push({
        priorTurns: [...context.priorTurns],
        goal: context.goal,
        history: [...context.history],
      });

      return text;
    },
  };
}

/**
 * A two-call strategy for exercising the onDiagnostic channel (see
 * DiagnosticReporter, types.ts): its first call reports one diagnostic
 * detail and proposes a tool call; its second call records a snapshot of
 * the context.history it was given (before returning a final answer), so a
 * test can confirm the diagnostic never leaked into it.
 */
function diagnosticEmittingStrategy(
  detail: string,
): ToolCallStrategy & {
  secondCallHistory: AgentEvent[] | null;
} {
  let callIndex = 0;

  const fake: ToolCallStrategy & {
    secondCallHistory: AgentEvent[] | null;
  } = {
    secondCallHistory: null,
    async getNextAction(context, _tools, _model, onDiagnostic) {
      callIndex += 1;

      if (callIndex === 1) {
        onDiagnostic?.(detail);

        return {
          kind: "tool_call",
          tool: "write_file",
          arguments: {},
          callId: "call-1",
        };
      }

      fake.secondCallHistory = [
        ...context.history,
      ];

      return {
        kind: "final_answer",
        text: "done",
        alreadyDisplayed: true,
      };
    },
  };

  return fake;
}

describe(
  "agent/loop.ts runAgentLoop",
  () => {
    it(
      "executes a proposed tool call and, on done, returns the text produced by the final-answer producer",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "create_docx",
            arguments: {
              path: "report.docx",
            },
            callId: "call-1",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "Created report.docx",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "Here is your report.",
        );

        const result = await runAgentLoop(
          "write a report",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        expect(result).toEqual({
          kind: "final_answer",
          text: "Here is your report.",
          // Hardcoded true regardless of the fake strategy's own action: a
          // "done" outcome is always sourced from finalAnswerProducer.produce()
          // (see runAgentLoop's own "done" branch, loop.ts), whose documented
          // contract is that its text is always already shown to the user.
          alreadyDisplayed: true,
        });

        expect(executor.calls).toEqual([
          {
            tool: "create_docx",
            args: {
              path: "report.docx",
            },
          },
        ]);

        expect(finalAnswer.calls).toHaveLength(1);

        expect(
          finalAnswer.calls[0]!.goal,
        ).toBe(
          "write a report",
        );
      },
    );

    it(
      "returns a strategy's own final_answer text directly, without calling the final-answer producer, propagating its own alreadyDisplayed as-is",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "final_answer",
            text: "Direct reply from the strategy itself.",
            alreadyDisplayed: true,
          },
        ]);

        const executor = scriptedExecutor([]);
        const finalAnswer = fakeFinalAnswerProducer(
          "should never be used",
        );

        const result = await runAgentLoop(
          "say hello",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        expect(result).toEqual({
          kind: "final_answer",
          text: "Direct reply from the strategy itself.",
          alreadyDisplayed: true,
        });

        expect(executor.calls).toHaveLength(0);
        expect(finalAnswer.calls).toHaveLength(0);
      },
    );

    it(
      "propagates a strategy's alreadyDisplayed: false through to the outcome unchanged (e.g. a non-streaming Native-style strategy)",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "final_answer",
            text: "Not shown anywhere yet.",
            alreadyDisplayed: false,
          },
        ]);

        const executor = scriptedExecutor([]);
        const finalAnswer = fakeFinalAnswerProducer(
          "should never be used",
        );

        const result = await runAgentLoop(
          "say hello",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        expect(result).toEqual({
          kind: "final_answer",
          text: "Not shown anywhere yet.",
          alreadyDisplayed: false,
        });
      },
    );

    it(
      "derives verified state purely from the executor's result, never from the tool's name",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "totally_unrelated_tool",
            arguments: {},
            callId: "call-1",
          },
          {
            kind: "tool_call",
            tool: "create_docx",
            arguments: {},
            callId: "call-2",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "ok",
            verified: true,
          },
          {
            success: true,
            output: "ok, but not independently checked",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "done",
        );

        const events: AgentEvent[] = [];

        await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
          (event) => events.push(event),
        );

        const stateChanges = events.filter(
          (event): event is Extract<AgentEvent, { type: "tool_state_changed" }> =>
            event.type === "tool_state_changed" && event.state !== "running",
        );

        expect(stateChanges).toEqual([
          {
            type: "tool_state_changed",
            callId: "call-1",
            state: "verified",
          },
          {
            type: "tool_state_changed",
            callId: "call-2",
            state: "succeeded",
          },
        ]);
      },
    );

    it(
      "continues after a failed tool call and feeds the real failure back to the strategy",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "flaky_tool",
            arguments: {},
            callId: "call-1",
          },
          {
            kind: "tool_call",
            tool: "reliable_tool",
            arguments: {},
            callId: "call-2",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: false,
            output: "flaky_tool: permission denied",
          },
          {
            success: true,
            output: "reliable_tool: ok",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "done",
        );

        await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        // The strategy's second call must have seen the first call's real
        // failure already recorded in history, not a success and not
        // nothing.
        const secondCallHistory =
          strategy.observedContexts[1]!.history;

        const failureEvent = secondCallHistory.find(
          (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
            event.type === "tool_result" && event.callId === "call-1",
        );

        expect(failureEvent).toEqual({
          type: "tool_result",
          callId: "call-1",
          success: false,
          verified: false,
          output: "flaky_tool: permission denied",
        });

        expect(executor.calls).toHaveLength(2);
      },
    );

    it(
      "never records a tool_result that differs from what the executor actually returned",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "some_tool",
            arguments: {
              a: 1,
            },
            callId: "call-1",
          },
          {
            kind: "done",
          },
        ]);

        const executedResult: AgentToolResult = {
          success: true,
          output: "exact output text",
          verified: true,
        };

        const executor = scriptedExecutor([
          executedResult,
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "done",
        );

        const events: AgentEvent[] = [];

        await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
          (event) => events.push(event),
        );

        const resultEvent = events.find(
          (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
            event.type === "tool_result",
        );

        expect(resultEvent).toEqual({
          type: "tool_result",
          callId: "call-1",
          success: executedResult.success,
          verified: true,
          output: executedResult.output,
        });
      },
    );

    it(
      "executes tool calls strictly one at a time, in order, growing history on every step",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "step_a",
            arguments: {},
            callId: "call-a",
          },
          {
            kind: "tool_call",
            tool: "step_b",
            arguments: {},
            callId: "call-b",
          },
          {
            kind: "tool_call",
            tool: "step_c",
            arguments: {},
            callId: "call-c",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "a done",
          },
          {
            success: true,
            output: "b done",
          },
          {
            success: true,
            output: "c done",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "all done",
        );

        await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        expect(
          executor.calls.map((call) => call.tool),
        ).toEqual([
          "step_a",
          "step_b",
          "step_c",
        ]);

        // Each successive getNextAction call should see strictly more
        // history than the last: 0, then 4 events per completed step
        // (tool_requested, running, terminal state, tool_result).
        const historyLengths =
          strategy.observedContexts.map(
            (context) => context.history.length,
          );

        expect(historyLengths).toEqual([
          0,
          4,
          8,
          12,
        ]);
      },
    );

    it(
      "converts a thrown executor error into a recorded failed result instead of aborting the turn",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "buggy_tool",
            arguments: {},
            callId: "call-1",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          new Error(
            "unexpected thrown error from a buggy handler",
          ),
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "recovered",
        );

        const events: AgentEvent[] = [];

        const result = await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
          (event) => events.push(event),
        );

        expect(result).toEqual({
          kind: "final_answer",
          text: "recovered",
          alreadyDisplayed: true,
        });

        const resultEvent = events.find(
          (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
            event.type === "tool_result",
        );

        expect(resultEvent).toEqual({
          type: "tool_result",
          callId: "call-1",
          success: false,
          verified: false,
          output: "unexpected thrown error from a buggy handler",
        });
      },
    );

    it(
      "stops with a clear error after MAX_AGENT_STEPS without reaching a final answer",
      async () => {
        const strategy = alwaysAnotherToolCallStrategy(
          "loop_forever_tool",
        );

        const executor: ToolExecutor = {
          async execute() {
            return {
              success: true,
              output: "ok",
            };
          },
        };

        const finalAnswer = fakeFinalAnswerProducer(
          "unreachable",
        );

        const executeSpy = vi.spyOn(
          executor,
          "execute",
        );

        await expect(
          runAgentLoop(
            "goal",
            NO_PRIOR_TURNS,
            strategy,
            NO_TOOLS,
            MODEL,
            executor,
            finalAnswer,
          ),
        ).rejects.toThrow(
          /stopped after 20 consecutive tool calls/,
        );

        expect(executeSpy).toHaveBeenCalledTimes(
          20,
        );
      },
    );

    it(
      "returns return_to_prompt with the real tool result when endsTurn is set, without asking the strategy again",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "run_shell_command",
            arguments: {
              command: "long-task &",
              background: true,
            },
            callId: "call-1",
          },
        ]);

        const executedResult: AgentToolResult = {
          success: true,
          output: "Started in background (pid 1234)",
          endsTurn: true,
        };

        const executor = scriptedExecutor([
          executedResult,
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "should never be used",
        );

        const events: AgentEvent[] = [];

        const result = await runAgentLoop(
          "run something in the background",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
          (event) => events.push(event),
        );

        expect(result).toEqual({
          kind: "return_to_prompt",
          result: executedResult,
        });

        // The strategy must not be asked to reassess after an endsTurn
        // result: exactly the one scripted action was consumed.
        expect(strategy.observedContexts).toHaveLength(1);

        expect(executor.calls).toHaveLength(1);
        expect(finalAnswer.calls).toHaveLength(0);

        // No fabricated final_answer event: the turn ended on the real tool
        // result alone.
        expect(
          events.some((event) => event.type === "final_answer"),
        ).toBe(
          false,
        );

        const resultEvent = events.find(
          (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
            event.type === "tool_result",
        );

        expect(resultEvent).toEqual({
          type: "tool_result",
          callId: "call-1",
          success: true,
          verified: false,
          output: "Started in background (pid 1234)",
        });
      },
    );

    it(
      "does not end the turn early when a tool result omits endsTurn",
      async () => {
        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "ordinary_tool",
            arguments: {},
            callId: "call-1",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "ordinary result",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "wrapped up normally",
        );

        const result = await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        expect(result).toEqual({
          kind: "final_answer",
          text: "wrapped up normally",
          alreadyDisplayed: true,
        });

        expect(strategy.observedContexts).toHaveLength(2);
      },
    );

    it(
      "passes priorTurns through to every strategy call and to the final-answer producer, without duplicating the current goal",
      async () => {
        const priorTurns: PlainConversationTurn[] = [
          {
            role: "user",
            content: "earlier in the session, please rename foo to bar",
          },
          {
            role: "assistant",
            content: "Done, renamed foo to bar.",
          },
        ];

        const strategy = scriptedStrategy([
          {
            kind: "tool_call",
            tool: "some_tool",
            arguments: {},
            callId: "call-1",
          },
          {
            kind: "done",
          },
        ]);

        const executor = scriptedExecutor([
          {
            success: true,
            output: "ok",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "final reply",
        );

        await runAgentLoop(
          "now please rename bar to baz",
          priorTurns,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
        );

        // Every strategy call sees the exact same priorTurns, unchanged.
        expect(strategy.observedContexts).toHaveLength(2);

        for (
          const observedContext of
          strategy.observedContexts
        ) {
          expect(observedContext.priorTurns).toEqual(
            priorTurns,
          );

          expect(observedContext.goal).toBe(
            "now please rename bar to baz",
          );
        }

        // The final-answer producer (PromptedStrategy's "done" case) is
        // grounded in the same priorTurns and goal, not a stripped-down
        // subset.
        expect(finalAnswer.calls).toHaveLength(1);

        expect(finalAnswer.calls[0]!.priorTurns).toEqual(
          priorTurns,
        );

        expect(finalAnswer.calls[0]!.goal).toBe(
          "now please rename bar to baz",
        );

        // priorTurns must never be re-stated inside `goal`: the current
        // user message appears exactly once, as `goal` itself.
        expect(
          priorTurns.some(
            (turn) =>
              turn.content ===
              "now please rename bar to baz",
          ),
        ).toBe(
          false,
        );
      },
    );

    it(
      "reports a strategy's onDiagnostic call to the AgentEvent listener as a protocol_condition, without ever adding it to context.history",
      async () => {
        const strategy = diagnosticEmittingStrategy(
          "LegacyStrategy corrective retry (attempt 1 of 2): some reason",
        );

        const executor = scriptedExecutor([
          {
            success: true,
            output: "wrote the file",
          },
        ]);

        const finalAnswer = fakeFinalAnswerProducer(
          "should never be used",
        );

        const events: AgentEvent[] = [];

        await runAgentLoop(
          "goal",
          NO_PRIOR_TURNS,
          strategy,
          NO_TOOLS,
          MODEL,
          executor,
          finalAnswer,
          (event) => events.push(event),
        );

        const protocolConditionEvents =
          events.filter(
            (event) => event.type === "protocol_condition",
          );

        expect(protocolConditionEvents).toHaveLength(1);

        expect(protocolConditionEvents[0]).toEqual({
          type: "protocol_condition",
          detail:
            "LegacyStrategy corrective retry (attempt 1 of 2): some reason",
        });

        // The diagnostic must never leak into context.history for a later
        // getNextAction() call within the same turn - it is internal
        // scratch, not something the strategy actually executed (see
        // DiagnosticReporter, types.ts).
        expect(strategy.secondCallHistory).not.toBeNull();

        expect(
          strategy.secondCallHistory!.some(
            (event) => event.type === "protocol_condition",
          ),
        ).toBe(
          false,
        );
      },
    );
  },
);
