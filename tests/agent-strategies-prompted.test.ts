import {
  describe,
  expect,
  it,
} from "vitest";

import {
  PromptedStrategy,
} from "../src/agent/strategies/prompted.ts";

import type {
  PlainConversationTurn,
  TextCompletionClient,
  TextCompletionOptions,
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
    examples: [
      {
        arguments: {
          path: "example.md",
        },
      },
    ],
    permissionCategory: "write-file",
  },
];

const EMPTY_CONTEXT: AgentContext = {
  priorTurns: [],
  goal: "write a file",
  history: [],
};

interface RecordedCall {
  model: string;
  systemPrompt: string;
  turns: PlainConversationTurn[];
  options?: TextCompletionOptions;
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
    async complete(model, systemPrompt, turns, options) {
      calls.push({
        model,
        systemPrompt,
        turns,
        options,
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

describe(
  "agent/strategies/prompted.ts PromptedStrategy",
  () => {
    it(
      "returns a tool_call action for a valid selection response",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: {
              path: "notes.md",
              content: "Some notes.",
            },
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
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
            content: "Some notes.",
          });

          expect(typeof action.callId).toBe(
            "string",
          );

          expect(action.callId.length).toBeGreaterThan(
            0,
          );
        }

        expect(client.calls).toHaveLength(1);
        expect(client.calls[0]!.options?.jsonMode).toBe(true);
        expect(client.calls[0]!.systemPrompt).toContain("write_file");
      },
    );

    it(
      'returns a done action for {"action":"done"}',
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "done",
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "done",
        });
      },
    );

    it(
      "retries after malformed JSON and succeeds on the corrected response",
      async () => {
        const client = scriptedTextClient([
          "this is not json",
          JSON.stringify({
            action: "done",
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "done",
        });

        expect(client.calls).toHaveLength(2);

        const correctiveTurn =
          client.calls[1]!.turns.find(
            (turn) =>
              turn.role === "user" &&
              turn.content.includes("not usable"),
          );

        expect(correctiveTurn).toBeDefined();
      },
    );

    it(
      "retries after a tool_call response names an unknown tool",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "tool_call",
            tool: "not_a_real_tool",
            arguments: {},
          }),
          JSON.stringify({
            action: "done",
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action).toEqual({
          kind: "done",
        });
      },
    );

    it(
      "retries after a tool_call response has non-object arguments",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: "not an object",
          }),
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: {
              path: "fixed.md",
              content: "Fixed content.",
            },
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const action = await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(action.kind).toBe(
          "tool_call",
        );

        if (action.kind === "tool_call") {
          expect(action.arguments).toEqual({
            path: "fixed.md",
            content: "Fixed content.",
          });
        }
      },
    );

    it(
      "retries after a tool_call response has schema-invalid arguments (valid object, missing a required field)",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            // A valid object, but write_file also requires "content", which
            // is missing here: this must be caught by
            // validateSkyToolRequest, not silently passed through as a
            // compliant tool call.
            arguments: {
              path: "notes.md",
            },
          }),
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: {
              path: "notes.md",
              content: "Now complete.",
            },
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
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
            content: "Now complete.",
          },
          callId: expect.any(String),
        });

        expect(client.calls).toHaveLength(2);

        const correctiveTurn =
          client.calls[1]!.turns.find(
            (turn) =>
              turn.role === "user" &&
              turn.content.includes("not usable"),
          );

        expect(correctiveTurn).toBeDefined();
      },
    );

    it(
      "throws after exhausting corrective attempts against a persistently invalid response",
      async () => {
        const client = scriptedTextClient([
          "not json",
          "still not json",
          "still not json again",
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        await expect(
          strategy.getNextAction(
            EMPTY_CONTEXT,
            TOOLS,
            "fake-model",
          ),
        ).rejects.toThrow(
          /could not obtain one valid selection/,
        );

        // Initial attempt plus MAX_CORRECTIVE_ATTEMPTS (2) corrective
        // follow-ups.
        expect(client.calls).toHaveLength(3);
      },
    );

    it(
      "reports a corrective retry to onDiagnostic without exposing it to the model, and succeeds silently on the terminal-visible path",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: "not an object",
          }),
          JSON.stringify({
            action: "tool_call",
            tool: "write_file",
            arguments: {
              path: "fixed.md",
              content: "Fixed content.",
            },
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
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
          "PromptedStrategy corrective retry (attempt 1 of 2)",
        );
      },
    );

    it(
      "reports final exhaustion to onDiagnostic once, right before throwing",
      async () => {
        const client = scriptedTextClient([
          "not json",
          "still not json",
          "still not json again",
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        const diagnostics: string[] = [];

        await expect(
          strategy.getNextAction(
            EMPTY_CONTEXT,
            TOOLS,
            "fake-model",
            (detail) => diagnostics.push(detail),
          ),
        ).rejects.toThrow(
          /could not obtain one valid selection/,
        );

        // One report per loop iteration that saw a non-compliant response
        // (MAX_CORRECTIVE_ATTEMPTS + 1 = 3) plus one final report right
        // before throwing.
        expect(diagnostics).toHaveLength(4);

        expect(diagnostics[3]).toContain(
          "could not obtain one valid selection",
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
          JSON.stringify({
            action: "done",
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        await strategy.getNextAction(
          context,
          TOOLS,
          "fake-model",
        );

        expect(client.calls[0]!.turns).toEqual([
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

    it(
      "never sends sky-tool fenced-block instructions in its selection system prompt (own narrow selector, no legacy text protocol)",
      async () => {
        const client = scriptedTextClient([
          JSON.stringify({
            action: "done",
          }),
        ]);

        const strategy = new PromptedStrategy(
          client,
        );

        await strategy.getNextAction(
          EMPTY_CONTEXT,
          TOOLS,
          "fake-model",
        );

        expect(client.calls[0]!.systemPrompt).not.toContain(
          "sky-tool",
        );
      },
    );
  },
);
