import {
  describe,
  expect,
  it,
} from "vitest";

import {
  renderContextAsNativeTurns,
  renderContextAsPlainTurns,
  renderHistoryAsNativeTurns,
  renderHistoryAsPlainTurns,
} from "../src/agent/history-rendering.ts";

import type {
  AgentContext,
  AgentEvent,
} from "../src/agent/types.ts";

import type {
  PlainConversationTurn,
} from "../src/agent/model-client.ts";

describe(
  "agent/history-rendering.ts renderHistoryAsPlainTurns",
  () => {
    it(
      "renders an empty history as no turns",
      () => {
        expect(
          renderHistoryAsPlainTurns([]),
        ).toEqual(
          [],
        );
      },
    );

    it(
      "renders a tool_requested/tool_result pair as one assistant turn and one user turn",
      () => {
        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "call-1",
            tool: "write_file",
            arguments: {
              path: "notes.md",
            },
          },
          {
            type: "tool_state_changed",
            callId: "call-1",
            state: "running",
          },
          {
            type: "tool_state_changed",
            callId: "call-1",
            state: "succeeded",
          },
          {
            type: "tool_result",
            callId: "call-1",
            success: true,
            verified: false,
            output: "Wrote notes.md",
          },
        ];

        const turns =
          renderHistoryAsPlainTurns(
            history,
          );

        expect(turns).toEqual([
          {
            role: "assistant",
            content: 'Tool call: write_file({"path":"notes.md"})',
          },
          {
            role: "user",
            content: "Result: succeeded\nWrote notes.md",
          },
        ]);
      },
    );

    it(
      "distinguishes verified success, plain success, and failure in the rendered result",
      () => {
        const eventFor = (
          success: boolean,
          verified: boolean,
        ): AgentEvent[] => [
          {
            type: "tool_requested",
            callId: "call-1",
            tool: "some_tool",
            arguments: {},
          },
          {
            type: "tool_result",
            callId: "call-1",
            success,
            verified,
            output: "output text",
          },
        ];

        expect(
          renderHistoryAsPlainTurns(
            eventFor(true, true),
          )[1],
        ).toEqual({
          role: "user",
          content: "Result: succeeded (independently verified)\noutput text",
        });

        expect(
          renderHistoryAsPlainTurns(
            eventFor(true, false),
          )[1],
        ).toEqual({
          role: "user",
          content: "Result: succeeded\noutput text",
        });

        expect(
          renderHistoryAsPlainTurns(
            eventFor(false, false),
          )[1],
        ).toEqual({
          role: "user",
          content: "Result: failed\noutput text",
        });
      },
    );

    it(
      "renders a protocol_condition as a labeled user note",
      () => {
        const history: AgentEvent[] = [
          {
            type: "protocol_condition",
            detail: "something noteworthy happened",
          },
        ];

        expect(
          renderHistoryAsPlainTurns(
            history,
          ),
        ).toEqual([
          {
            role: "user",
            content: "[Sky Code note: something noteworthy happened]",
          },
        ]);
      },
    );

    it(
      "renders a final_answer defensively as an assistant turn",
      () => {
        const history: AgentEvent[] = [
          {
            type: "final_answer",
            text: "Here is your answer.",
          },
        ];

        expect(
          renderHistoryAsPlainTurns(
            history,
          ),
        ).toEqual([
          {
            role: "assistant",
            content: "Here is your answer.",
          },
        ]);
      },
    );

    it(
      "renders multiple completed tool calls in order",
      () => {
        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "call-a",
            tool: "step_a",
            arguments: {},
          },
          {
            type: "tool_result",
            callId: "call-a",
            success: true,
            verified: false,
            output: "a done",
          },
          {
            type: "tool_requested",
            callId: "call-b",
            tool: "step_b",
            arguments: {},
          },
          {
            type: "tool_result",
            callId: "call-b",
            success: true,
            verified: false,
            output: "b done",
          },
        ];

        const turns =
          renderHistoryAsPlainTurns(
            history,
          );

        expect(
          turns.map((turn) => turn.content),
        ).toEqual([
          "Tool call: step_a({})",
          "Result: succeeded\na done",
          "Tool call: step_b({})",
          "Result: succeeded\nb done",
        ]);
      },
    );
  },
);

describe(
  "agent/history-rendering.ts renderHistoryAsNativeTurns",
  () => {
    it(
      "renders a tool_requested/tool_result pair as an assistant tool-call turn and a matching tool-result turn",
      () => {
        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "call-1",
            tool: "create_docx",
            arguments: {
              path: "report.docx",
            },
          },
          {
            type: "tool_result",
            callId: "call-1",
            success: true,
            verified: true,
            output: "Created report.docx",
          },
        ];

        const turns =
          renderHistoryAsNativeTurns(
            history,
          );

        expect(turns).toEqual([
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "create_docx",
                argumentsJson: JSON.stringify({
                  path: "report.docx",
                }),
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            // Real output verbatim inside a status envelope, never prose;
            // postcondition_verified names the tool's own check only.
            content: JSON.stringify({
              status: "succeeded",
              postcondition_verified: true,
              output: "Created report.docx",
            }),
          },
        ]);
      },
    );

    it(
      "renders a protocol_condition as a labeled user note, matching the plain-text renderer",
      () => {
        const history: AgentEvent[] = [
          {
            type: "protocol_condition",
            detail: "example detail",
          },
        ];

        expect(
          renderHistoryAsNativeTurns(
            history,
          ),
        ).toEqual([
          {
            role: "user",
            content: "[Sky Code note: example detail]",
          },
        ]);
      },
    );
  },
);

describe(
  "agent/history-rendering.ts renderContextAsPlainTurns",
  () => {
    it(
      "renders priorTurns, then the goal, then this turn's history, in that order",
      () => {
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

        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "call-1",
            tool: "write_file",
            arguments: {
              path: "LICENSE",
            },
          },
          {
            type: "tool_result",
            callId: "call-1",
            success: true,
            verified: false,
            output: "Wrote LICENSE",
          },
        ];

        const context: AgentContext = {
          priorTurns,
          goal: "now add a LICENSE file",
          history,
        };

        expect(
          renderContextAsPlainTurns(
            context,
          ),
        ).toEqual([
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
            content: 'Tool call: write_file({"path":"LICENSE"})',
          },
          {
            role: "user",
            content: "Result: succeeded\nWrote LICENSE",
          },
        ]);
      },
    );

    it(
      "renders exactly the goal turn, with no leading turns, when priorTurns is empty",
      () => {
        const context: AgentContext = {
          priorTurns: [],
          goal: "write a file",
          history: [],
        };

        expect(
          renderContextAsPlainTurns(
            context,
          ),
        ).toEqual([
          {
            role: "user",
            content: "write a file",
          },
        ]);
      },
    );

    it(
      "never repeats the goal inside the rendered turns beyond the one goal turn",
      () => {
        const priorTurns: PlainConversationTurn[] = [
          {
            role: "user",
            content: "an unrelated earlier message",
          },
        ];

        const context: AgentContext = {
          priorTurns,
          goal: "the current request",
          history: [],
        };

        const turns =
          renderContextAsPlainTurns(
            context,
          );

        const goalOccurrences = turns.filter(
          (turn) => turn.content === "the current request",
        );

        expect(goalOccurrences).toHaveLength(
          1,
        );
      },
    );
  },
);

describe(
  "agent/history-rendering.ts renderContextAsNativeTurns",
  () => {
    it(
      "renders priorTurns as plain user/assistant turns, then the goal, then this turn's history as native tool-call turns",
      () => {
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

        const history: AgentEvent[] = [
          {
            type: "tool_requested",
            callId: "call-1",
            tool: "create_docx",
            arguments: {
              path: "report.docx",
            },
          },
          {
            type: "tool_result",
            callId: "call-1",
            success: true,
            verified: true,
            output: "Created report.docx",
          },
        ];

        const context: AgentContext = {
          priorTurns,
          goal: "now write a report",
          history,
        };

        expect(
          renderContextAsNativeTurns(
            context,
          ),
        ).toEqual([
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
            content: "now write a report",
          },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "call-1",
                name: "create_docx",
                argumentsJson: JSON.stringify({
                  path: "report.docx",
                }),
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            // Real output verbatim inside a status envelope, never prose;
            // postcondition_verified names the tool's own check only.
            content: JSON.stringify({
              status: "succeeded",
              postcondition_verified: true,
              output: "Created report.docx",
            }),
          },
        ]);
      },
    );

    it(
      "renders exactly the goal turn, with no leading turns, when priorTurns is empty",
      () => {
        const context: AgentContext = {
          priorTurns: [],
          goal: "write a file",
          history: [],
        };

        expect(
          renderContextAsNativeTurns(
            context,
          ),
        ).toEqual([
          {
            role: "user",
            content: "write a file",
          },
        ]);
      },
    );
  },
);
