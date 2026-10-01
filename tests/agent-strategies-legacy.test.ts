import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  LegacyStrategy,
} from "../src/agent/strategies/legacy.ts";

import type {
  PlainConversationTurn,
  TextCompletionClient,
} from "../src/agent/model-client.ts";

import type {
  AgentContext,
  ToolDefinition,
} from "../src/agent/types.ts";

/** LegacyStrategy does not use this parameter (see its own doc comment). */
const NO_TOOLS: ToolDefinition[] = [];

const EMPTY_CONTEXT: AgentContext = {
  priorTurns: [],
  goal: "write a file",
  history: [],
};

interface RecordedCall {
  model: string;
  systemPrompt: string;
  turns: PlainConversationTurn[];
}

/**
 * A TextCompletionClient driven by a fixed script of raw text responses,
 * recording every call it was actually invoked with.
 */
function scriptedTextClient(
  responses: string[],
): TextCompletionClient & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let callIndex = 0;

  return {
    calls,
    async complete(model, systemPrompt, turns) {
      calls.push({
        model,
        systemPrompt,
        turns,
      });

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
  "agent/strategies/legacy.ts LegacyStrategy",
  () => {
    it(
      "returns a tool_call action for a single valid sky-tool block",
      async () => {
        const client = scriptedTextClient([
          skyToolBlock("write_file", {
            path: "notes.md",
            content: "hello",
          }),
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        expect(action.kind).toBe(
          "tool_call",
        );

        if (action.kind === "tool_call") {
          expect(action.tool).toBe(
            "write_file",
          );

          expect(action.arguments).toEqual({
            path: "notes.md",
            content: "hello",
          });

          expect(typeof action.callId).toBe(
            "string",
          );

          expect(action.callId.length).toBeGreaterThan(
            0,
          );
        }

        expect(client.calls).toHaveLength(1);
      },
    );

    it(
      "returns a final_answer action when the response contains no sky-tool block",
      async () => {
        const client = scriptedTextClient([
          "Here is the answer you asked for, with no tool needed.",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "final_answer",
          text: "Here is the answer you asked for, with no tool needed.",
          alreadyDisplayed: true,
        });
      },
    );

    it(
      "never returns final_answer for a completion whose only block is valid, even when the model also wrote trailing success prose (regression guard for the original hallucinated-success defect)",
      async () => {
        const raw =
          `${skyToolBlock("write_file", { path: "a.txt", content: "x" })}\n` +
          "All requested files have been created successfully!";

        const client = scriptedTextClient([
          raw,
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        // The trailing "All requested files have been created successfully!"
        // text must never surface as a final_answer here: only a real,
        // executed tool result (recorded by runAgentLoop after this action
        // actually runs) may ever justify a claim of success.
        expect(action.kind).toBe(
          "tool_call",
        );

        if (action.kind === "tool_call") {
          expect(action.tool).toBe(
            "write_file",
          );
        }
      },
    );

    it(
      "executes nothing when a completion contains multiple valid sky-tool blocks, and instead issues a corrective retry naming the count, recovering once the corrected response has exactly one block",
      async () => {
        const multiBlockResponse =
          `${skyToolBlock("write_file", { path: "a.txt", content: "x" })}\n` +
          `${skyToolBlock("write_file", { path: "b.txt", content: "y" })}`;

        const client = scriptedTextClient([
          multiBlockResponse,
          skyToolBlock("write_file", {
            path: "c.txt",
            content: "z",
          }),
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const warnSpy = vi.spyOn(
          console,
          "warn",
        ).mockImplementation(
          () => {},
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        // Only the corrected, single-block response is ever turned into an
        // action; neither block from the multi-block response is executed,
        // including its own leading block.
        expect(action).toEqual({
          kind: "tool_call",
          tool: "write_file",
          arguments: {
            path: "c.txt",
            content: "z",
          },
          callId: expect.any(String),
        });

        expect(client.calls).toHaveLength(2);

        const correctiveTurn =
          client.calls[1]!.turns.find(
            (turn) =>
              turn.role === "user" &&
              turn.content.includes("2 tool actions at once"),
          );

        expect(correctiveTurn).toBeDefined();

        // The old console-only warning is no longer how "multiple blocks"
        // is handled; the model itself must receive the correction instead.
        expect(warnSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
      },
    );

    it(
      "throws after exhausting corrective attempts against a persistently multiple-blocks response",
      async () => {
        const multiBlockResponse =
          `${skyToolBlock("write_file", { path: "a.txt", content: "x" })}\n` +
          `${skyToolBlock("write_file", { path: "b.txt", content: "y" })}`;

        const client = scriptedTextClient([
          multiBlockResponse,
          multiBlockResponse,
          multiBlockResponse,
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        await expect(
          strategy.getNextAction(
            EMPTY_CONTEXT,
            NO_TOOLS,
            "fake-model",
          ),
        ).rejects.toThrow(
          /could not obtain one valid sky-tool request/,
        );

        // Initial attempt plus MAX_CORRECTIVE_ATTEMPTS (2) corrective
        // follow-ups; no block from any of these responses was ever
        // executed.
        expect(client.calls).toHaveLength(3);
      },
    );

    it(
      "retries after malformed JSON in the sky-tool block and succeeds on the corrected response",
      async () => {
        const client = scriptedTextClient([
          "```sky-tool\n{not valid json\n```",
          skyToolBlock("write_file", {
            path: "fixed.md",
            content: "ok",
          }),
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        expect(action.kind).toBe(
          "tool_call",
        );

        if (action.kind === "tool_call") {
          expect(action.arguments).toEqual({
            path: "fixed.md",
            content: "ok",
          });
        }

        expect(client.calls).toHaveLength(2);

        const correctiveTurn =
          client.calls[1]!.turns.find(
            (turn) =>
              turn.role === "user" &&
              turn.content.includes("could not be used"),
          );

        expect(correctiveTurn).toBeDefined();
      },
    );

    it(
      "retries after an unknown tool name in the sky-tool block",
      async () => {
        const client = scriptedTextClient([
          skyToolBlock("not_a_real_tool", {}),
          "No tool needed after all.",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "final_answer",
          text: "No tool needed after all.",
          alreadyDisplayed: true,
        });
      },
    );

    it(
      "throws after exhausting corrective attempts against persistently malformed responses",
      async () => {
        const client = scriptedTextClient([
          "```sky-tool\n{bad\n```",
          "```sky-tool\n{still bad\n```",
          "```sky-tool\n{still bad again\n```",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        await expect(
          strategy.getNextAction(
            EMPTY_CONTEXT,
            NO_TOOLS,
            "fake-model",
          ),
        ).rejects.toThrow(
          /could not obtain one valid sky-tool request/,
        );

        // Initial attempt plus MAX_CORRECTIVE_ATTEMPTS (2) corrective
        // follow-ups.
        expect(client.calls).toHaveLength(3);
      },
    );

    it(
      "reports each corrective retry to onDiagnostic without exposing it to the model, and succeeds silently on the terminal-visible path",
      async () => {
        const client = scriptedTextClient([
          "```sky-tool\n{not valid json\n```",
          skyToolBlock("write_file", {
            path: "fixed.md",
            content: "ok",
          }),
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const diagnostics: string[] = [];

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
          (detail) => diagnostics.push(detail),
        );

        expect(action.kind).toBe(
          "tool_call",
        );

        expect(diagnostics).toHaveLength(1);

        expect(diagnostics[0]).toContain(
          "LegacyStrategy corrective retry (attempt 1 of 2)",
        );

        expect(diagnostics[0]).toContain(
          "could not be used",
        );
      },
    );

    it(
      "reports final exhaustion to onDiagnostic once, right before throwing",
      async () => {
        const client = scriptedTextClient([
          "```sky-tool\n{bad\n```",
          "```sky-tool\n{still bad\n```",
          "```sky-tool\n{still bad again\n```",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        const diagnostics: string[] = [];

        await expect(
          strategy.getNextAction(
            EMPTY_CONTEXT,
            NO_TOOLS,
            "fake-model",
            (detail) => diagnostics.push(detail),
          ),
        ).rejects.toThrow(
          /could not obtain one valid sky-tool request/,
        );

        // One report per loop iteration that saw a non-compliant response
        // (MAX_CORRECTIVE_ATTEMPTS + 1 = 3, since the loop runs the initial
        // attempt plus MAX_CORRECTIVE_ATTEMPTS corrective follow-ups) plus
        // one final report right before throwing.
        expect(diagnostics).toHaveLength(4);

        expect(diagnostics[3]).toContain(
          "could not obtain one valid sky-tool request",
        );
      },
    );

    it(
      "sends the system prompt supplied by its constructor unchanged",
      async () => {
        const client = scriptedTextClient([
          "plain answer",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "custom system prompt including sky.md rule 7",
        );

        await strategy.getNextAction(
          EMPTY_CONTEXT,
          NO_TOOLS,
          "fake-model",
        );

        expect(client.calls[0]!.systemPrompt).toBe(
          "custom system prompt including sky.md rule 7",
        );
      },
    );

    it(
      "sends prior session turns ahead of the current goal, without duplicating it",
      async () => {
        const priorTurns: PlainConversationTurn[] = [
          {
            role: "user",
            content: "earlier: please create a README",
          },
          {
            role: "assistant",
            content: "Created README.md.",
          },
        ];

        const context: AgentContext = {
          priorTurns,
          goal: "now add a LICENSE file",
          history: [],
        };

        const client = scriptedTextClient([
          "No tool needed for that yet.",
        ]);

        const strategy = new LegacyStrategy(
          client,
          "system prompt",
        );

        await strategy.getNextAction(
          context,
          NO_TOOLS,
          "fake-model",
        );

        expect(client.calls[0]!.turns).toEqual([
          ...priorTurns,
          {
            role: "user",
            content: "now add a LICENSE file",
          },
        ]);
      },
    );
  },
);
