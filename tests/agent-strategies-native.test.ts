import {
  describe,
  expect,
  it,
} from "vitest";

import {
  NativeStrategy,
} from "../src/agent/strategies/native.ts";

import type {
  NativeCompletionClient,
  NativeCompletionRequest,
  NativeCompletionResult,
  PlainConversationTurn,
} from "../src/agent/model-client.ts";

import type {
  AgentContext,
  ToolDefinition,
} from "../src/agent/types.ts";

const TOOLS: ToolDefinition[] = [
  {
    name: "write_file",
    description: "Writes a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
      required: [
        "path",
      ],
    },
    examples: [],
    permissionCategory: "write-file",
  },
];

const EMPTY_CONTEXT: AgentContext = {
  priorTurns: [],
  goal: "write a file",
  history: [],
};

/**
 * A NativeCompletionClient driven by a fixed script of results, recording
 * every request it was actually called with.
 */
function scriptedNativeClient(
  results: NativeCompletionResult[],
): NativeCompletionClient & {
  requests: NativeCompletionRequest[];
} {
  const requests: NativeCompletionRequest[] = [];
  let callIndex = 0;

  return {
    requests,
    async complete(request) {
      requests.push(request);

      const result =
        results[callIndex];

      callIndex += 1;

      if (!result) {
        throw new Error(
          "scriptedNativeClient called more times than it has scripted results",
        );
      }

      return result;
    },
  };
}

describe(
  "agent/strategies/native.ts NativeStrategy",
  () => {
    it(
      "returns a tool_call action for a single compliant tool call",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "write_file",
                argumentsJson: JSON.stringify({
                  path: "notes.md",
                  content: "Some notes.",
                }),
              },
            ],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "tool_call",
          tool: "write_file",
          arguments: {
            path: "notes.md",
            content: "Some notes.",
          },
          callId: "call-1",
        });

        expect(client.requests).toHaveLength(1);
        expect(client.requests[0]!.parallelToolCalls).toBe(false);
      },
    );

    it(
      "returns a final_answer action when the response has no tool calls",
      async () => {
        const client = scriptedNativeClient([
          {
            content: "All done.",
            toolCalls: [],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "final_answer",
          text: "All done.",
          alreadyDisplayed: false,
        });
      },
    );

    it(
      "issues one corrective follow-up and succeeds when the provider returns multiple tool calls once",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "write_file",
                argumentsJson: "{}",
              },
              {
                id: "call-2",
                name: "write_file",
                argumentsJson: "{}",
              },
            ],
          },
          {
            content: null,
            toolCalls: [
              {
                id: "call-3",
                name: "write_file",
                argumentsJson: JSON.stringify({
                  path: "retry.md",
                  content: "Retried content.",
                }),
              },
            ],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "tool_call",
          tool: "write_file",
          arguments: {
            path: "retry.md",
            content: "Retried content.",
          },
          callId: "call-3",
        });

        expect(client.requests).toHaveLength(2);

        const correctiveTurn =
          client.requests[1]!.turns.find(
            (turn) =>
              turn.role === "user" &&
              turn.content.includes("not usable"),
          );

        expect(correctiveTurn).toBeDefined();
      },
    );

    it(
      "returns malformed argument JSON as a rejected call (nothing executed), with concrete guidance, instead of correcting it privately",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "write_file",
                argumentsJson: "{not valid json",
              },
            ],
          },
        ]);

        const diagnostics: string[] = [];

        const action = await new NativeStrategy(
          client,
          "system prompt",
        ).getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
          (detail) => diagnostics.push(detail),
        );

        expect(action).toMatchObject({
          kind: "rejected_tool_call",
          tool: "write_file",
          callId: "call-1",
          arguments: {},
          errorCode: "TOOL_ARGUMENTS_INVALID_JSON",
        });

        expect(client.requests).toHaveLength(1);

        // The rejected payload is kept for diagnosis.
        expect(diagnostics[0]).toContain(
          "Rejected arguments: {not valid json",
        );
      },
    );

    it(
      "returns schema-invalid arguments (valid JSON, missing a required field) as a rejected call with the schema summary and example",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "write_file",
                // Valid JSON, but write_file also requires "content", which
                // is missing here: this must be caught by
                // validateSkyToolRequest, never executed.
                argumentsJson: JSON.stringify({
                  path: "notes.md",
                }),
              },
            ],
          },
        ]);

        const action = await new NativeStrategy(
          client,
          "system prompt",
        ).getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toMatchObject({
          kind: "rejected_tool_call",
          tool: "write_file",
          callId: "call-1",
          arguments: {
            path: "notes.md",
          },
          errorCode: "TOOL_ARGUMENT_VALIDATION_FAILED",
        });

        const guidance =
          (action as { guidance: string }).guidance;

        expect(guidance).toContain(
          "Correct the arguments and call write_file again.",
        );
        expect(guidance).toContain(
          "Expected arguments (fields marked ? are optional): { path: string }.",
        );
        expect(client.requests).toHaveLength(1);
      },
    );

    it(
      "treats an unknown tool name as non-compliant and retries",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "not_a_real_tool",
                argumentsJson: "{}",
              },
            ],
          },
          {
            content: "Never mind, no tool needed.",
            toolCalls: [],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "final_answer",
          text: "Never mind, no tool needed.",
          alreadyDisplayed: false,
        });
      },
    );

    it(
      "treats an empty response (no content, no tool calls) as non-compliant and retries",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [],
          },
          {
            content: "Recovered.",
            toolCalls: [],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "final_answer",
          text: "Recovered.",
          alreadyDisplayed: false,
        });
      },
    );

    it(
      "answers truthfully from the ledger, instead of throwing, after exhausting corrective attempts against a persistently non-compliant provider",
      async () => {
        const alwaysTwoToolCalls: NativeCompletionResult = {
          content: null,
          toolCalls: [
            {
              id: "call-x",
              name: "write_file",
              argumentsJson: "{}",
            },
            {
              id: "call-y",
              name: "write_file",
              argumentsJson: "{}",
            },
          ],
        };

        const client = scriptedNativeClient([
          alwaysTwoToolCalls,
          alwaysTwoToolCalls,
          alwaysTwoToolCalls,
        ]);

        const action = await new NativeStrategy(
          client,
          "system prompt",
        ).getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toMatchObject({
          kind: "final_answer",
          alreadyDisplayed: false,
        });

        expect(
          (action as { text: string }).text,
        ).toContain(
          "I stopped because the model's responses could not be used",
        );

        // Initial attempt plus MAX_CORRECTIVE_ATTEMPTS (2) corrective
        // follow-ups: exactly the configured limit.
        expect(client.requests).toHaveLength(3);
      },
    );

    it(
      "reports a corrective retry to onDiagnostic without exposing it to the model, and succeeds silently on the terminal-visible path",
      async () => {
        const client = scriptedNativeClient([
          {
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "write_file",
                argumentsJson: "{}",
              },
              {
                id: "call-2",
                name: "write_file",
                argumentsJson: "{}",
              },
            ],
          },
          {
            content: null,
            toolCalls: [
              {
                id: "call-3",
                name: "write_file",
                argumentsJson: JSON.stringify({
                  path: "retry.md",
                  content: "Retried content.",
                }),
              },
            ],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        const diagnostics: string[] = [];

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
          (detail) => diagnostics.push(detail),
        );

        expect(action.kind).toBe(
          "tool_call",
        );

        expect(diagnostics).toHaveLength(1);

        expect(diagnostics[0]).toContain(
          "NativeStrategy corrective retry (attempt 1 of 2)",
        );

        expect(diagnostics[0]).toContain(
          "requested 2 tool calls at once",
        );
      },
    );

    it(
      "numbers corrective retries exactly within the limit (never 3 of 2) and reports final exhaustion once",
      async () => {
        const alwaysTwoToolCalls: NativeCompletionResult = {
          content: null,
          toolCalls: [
            {
              id: "call-x",
              name: "write_file",
              argumentsJson: "{}",
            },
            {
              id: "call-y",
              name: "write_file",
              argumentsJson: "{}",
            },
          ],
        };

        const client = scriptedNativeClient([
          alwaysTwoToolCalls,
          alwaysTwoToolCalls,
          alwaysTwoToolCalls,
        ]);

        const diagnostics: string[] = [];

        await new NativeStrategy(
          client,
          "system prompt",
        ).getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
          (detail) => diagnostics.push(detail),
        );

        expect(diagnostics).toHaveLength(4);
        expect(diagnostics[0]).toContain(
          "corrective retry (attempt 1 of 2)",
        );
        expect(diagnostics[1]).toContain(
          "corrective retry (attempt 2 of 2)",
        );
        expect(diagnostics[2]).toContain(
          "after its last corrective retry (2 of 2)",
        );
        expect(
          diagnostics.join("\n"),
        ).not.toContain(
          "3 of 2",
        );
        expect(diagnostics[3]).toContain(
          "could not obtain one compliant action",
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

        const client = scriptedNativeClient([
          {
            content: "No tool needed for that yet.",
            toolCalls: [],
          },
        ]);

        const strategy = new NativeStrategy(
          client,
          "system prompt",
        );

        await strategy.getNextAction(
          context,
          TOOLS,
          "fake-model",
        );

        expect(client.requests[0]!.turns).toEqual([
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
        ]);
      },
    );
  },
);
