import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createFinalAnswerProducer,
} from "../src/agent/adapters/final-answer-producer.ts";

import type {
  PlainConversationTurn,
  TextCompletionClient,
  TextCompletionOptions,
} from "../src/agent/model-client.ts";

import type {
  AgentContext,
} from "../src/agent/types.ts";

interface RecordedCall {
  model: string;
  systemPrompt: string;
  turns: PlainConversationTurn[];
  options?: TextCompletionOptions;
}

/**
 * A TextCompletionClient that always returns one fixed response, recording
 * every call it was actually invoked with.
 */
function fakeTextClient(
  response: string,
): TextCompletionClient & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  return {
    calls,
    async complete(model, systemPrompt, turns, options) {
      calls.push({
        model,
        systemPrompt,
        turns,
        options,
      });

      return response;
    },
  };
}

describe(
  "agent/adapters/final-answer-producer.ts createFinalAnswerProducer",
  () => {
    it(
      "completes using the constructor-bound model and systemPrompt",
      async () => {
        const client = fakeTextClient(
          "Here is your answer.",
        );

        const producer = createFinalAnswerProducer(
          client,
          "final-answer system prompt",
          "test-model",
        );

        const context: AgentContext = {
          priorTurns: [],
          goal: "summarize the last commit",
          history: [],
        };

        await producer.produce(
          context,
        );

        expect(client.calls).toHaveLength(
          1,
        );

        expect(client.calls[0]!.model).toBe(
          "test-model",
        );

        expect(client.calls[0]!.systemPrompt).toBe(
          "final-answer system prompt",
        );
      },
    );

    it(
      "returns exactly the client's completion text, unmodified",
      async () => {
        const client = fakeTextClient(
          "The README was created successfully.",
        );

        const producer = createFinalAnswerProducer(
          client,
          "system prompt",
          "test-model",
        );

        const result = await producer.produce({
          priorTurns: [],
          goal: "create a README",
          history: [],
        });

        expect(result).toBe(
          "The README was created successfully.",
        );
      },
    );

    it(
      "renders priorTurns ahead of the current goal and this turn's recorded history, without duplicating the goal",
      async () => {
        const client = fakeTextClient(
          "done",
        );

        const producer = createFinalAnswerProducer(
          client,
          "system prompt",
          "test-model",
        );

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
          history: [
            {
              type: "tool_requested",
              callId: "call-1",
              tool: "write_file",
              arguments: {
                path: "LICENSE",
                content: "MIT",
              },
            },
            {
              type: "tool_state_changed",
              callId: "call-1",
              state: "running",
            },
            {
              type: "tool_result",
              callId: "call-1",
              success: true,
              verified: false,
              output: "Wrote LICENSE",
            },
          ],
        };

        await producer.produce(
          context,
        );

        const turns =
          client.calls[0]!.turns;

        expect(turns[0]).toEqual(
          priorTurns[0],
        );

        expect(turns[1]).toEqual(
          priorTurns[1],
        );

        expect(turns[2]).toEqual({
          role: "user",
          content: "now add a LICENSE file",
        });

        // Exactly one turn carries the current goal text - no duplicate
        // anywhere else in the rendered turns.
        expect(
          turns.filter(
            (turn) =>
              turn.content ===
              "now add a LICENSE file",
          ),
        ).toHaveLength(
          1,
        );

        // The recorded tool activity for this turn is rendered after the
        // goal, grounding the completion in the real result rather than
        // anything invented.
        const lastTurn =
          turns[turns.length - 1]!;

        expect(lastTurn.role).toBe(
          "user",
        );

        expect(lastTurn.content).toContain(
          "Wrote LICENSE",
        );
      },
    );

    it(
      "sends no jsonMode option: the final answer is plain prose, not a JSON selection",
      async () => {
        const client = fakeTextClient(
          "done",
        );

        const producer = createFinalAnswerProducer(
          client,
          "system prompt",
          "test-model",
        );

        await producer.produce({
          priorTurns: [],
          goal: "goal",
          history: [],
        });

        expect(
          client.calls[0]!.options,
        ).toBeUndefined();
      },
    );
  },
);
