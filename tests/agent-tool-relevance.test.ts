import {
  describe,
  expect,
  it,
} from "vitest";

import {
  selectRelevantTools,
} from "../src/agent/tool-relevance.ts";

import {
  BUILTIN_TOOL_DEFINITIONS,
} from "../src/agent/tool-schema.ts";

import type {
  AgentContext,
  AgentEvent,
  ToolDefinition,
} from "../src/agent/types.ts";

const ALL_TOOLS: ToolDefinition[] = [
  ...BUILTIN_TOOL_DEFINITIONS,
];

const ALL_NAMES =
  ALL_TOOLS.map(
    (tool) => tool.name,
  );

function contextFor(
  goal: string,
  history: AgentEvent[] = [],
): AgentContext {
  return {
    priorTurns: [],
    goal,
    history,
  };
}

function namesFor(
  goal: string,
  history: AgentEvent[] = [],
): string[] {
  return selectRelevantTools(
    contextFor(
      goal,
      history,
    ),
    ALL_TOOLS,
  ).tools.map(
    (tool) => tool.name,
  );
}

describe(
  "agent/tool-relevance.ts selectRelevantTools",
  () => {
    it(
      "offers the four document tools, plus read-only inspection, for the four-document request",
      () => {
        const names =
          namesFor(
            "Create a project status DOCX, an XLSX budget workbook, a PDF summary, and a PPTX presentation about the Q3 launch.",
          );

        expect(names).toEqual(
          expect.arrayContaining([
            "create_docx",
            "create_xlsx",
            "create_pdf",
            "create_pptx",
          ]),
        );

        expect(names).toContain(
          "read_file",
        );

        for (
          const unrelated of [
            "run_shell_command",
            "web_search",
            "web_fetch",
            "mcp_call",
            "delegate_to_agent",
          ]
        ) {
          expect(names).not.toContain(
            unrelated,
          );
        }
      },
    );

    it(
      'does not pull in the shell for everyday verbs like "make" or "build"',
      () => {
        const names =
          namesFor(
            "Please make a PDF and build a slide deck for the board meeting.",
          );

        expect(names).not.toContain(
          "run_shell_command",
        );
        expect(names).toContain(
          "create_pdf",
        );
      },
    );

    it(
      "offers web tools for a web lookup request and nothing that writes files",
      () => {
        const names =
          namesFor(
            "Search the web for the latest Node.js LTS release notes.",
          );

        expect(names).toContain(
          "web_search",
        );
        expect(names).toContain(
          "web_fetch",
        );
        expect(names).not.toContain(
          "create_docx",
        );
        expect(names).not.toContain(
          "write_file",
        );
      },
    );

    it(
      "offers the shell for an explicit command request",
      () => {
        expect(
          namesFor(
            "Run the test suite with npm and tell me what fails.",
          ),
        ).toContain(
          "run_shell_command",
        );
      },
    );

    it(
      "falls back to every tool when the request is too short or generic to judge",
      () => {
        for (
          const goal of [
            "yes",
            "do it",
            "continue please",
            "Try again with a different name for it",
          ]
        ) {
          const selection =
            selectRelevantTools(
              contextFor(goal),
              ALL_TOOLS,
            );

          expect(
            selection.tools.map(
              (tool) => tool.name,
            ),
          ).toEqual(
            ALL_NAMES,
          );
          expect(selection.matchedCategories).toEqual(
            [],
          );
        }
      },
    );

    it(
      "falls back to every tool when no category matches",
      () => {
        const selection =
          selectRelevantTools(
            contextFor(
              "What is the capital city of Australia, roughly speaking?",
            ),
            ALL_TOOLS,
          );

        expect(
          selection.tools.map(
            (tool) => tool.name,
          ),
        ).toEqual(
          ALL_NAMES,
        );
        expect(selection.reason).toContain(
          "every tool was offered",
        );
      },
    );

    it(
      "always keeps a tool already requested earlier in this turn, so the offered set never shrinks mid-turn",
      () => {
        const names =
          namesFor(
            "Create a DOCX report and a PDF copy of the same report.",
            [
              {
                type: "tool_requested",
                callId: "c1",
                tool: "run_shell_command",
                arguments: {
                  command: "ls",
                },
              },
            ],
          );

        expect(names).toContain(
          "run_shell_command",
        );
      },
    );

    it(
      "always keeps a tool outside every known category (for example an MCP-exposed tool)",
      () => {
        const external: ToolDefinition = {
          name: "notion__create_page",
          description: "Creates a page.",
          parameters: {
            type: "object",
            properties: {},
          },
          examples: [],
          permissionCategory: "mcp-call",
        };

        const selection =
          selectRelevantTools(
            contextFor(
              "Create a DOCX report for the quarterly planning review.",
            ),
            [
              ...ALL_TOOLS,
              external,
            ],
          );

        expect(
          selection.tools.map(
            (tool) => tool.name,
          ),
        ).toContain(
          "notion__create_page",
        );
      },
    );

    it(
      "preserves the original tool order and returns the canonical definitions themselves",
      () => {
        const selection =
          selectRelevantTools(
            contextFor(
              "Create a PPTX deck and an XLSX workbook for the team review.",
            ),
            ALL_TOOLS,
          );

        const originalOrder =
          ALL_TOOLS.filter(
            (tool) =>
              selection.tools.includes(
                tool,
              ),
          );

        expect(selection.tools).toEqual(
          originalOrder,
        );

        for (
          const tool of selection.tools
        ) {
          expect(ALL_TOOLS).toContain(
            tool,
          );
        }
      },
    );

    it(
      "never returns an empty tool list",
      () => {
        const onlyUnrelated =
          ALL_TOOLS.filter(
            (tool) =>
              tool.name ===
              "delegate_to_agent",
          );

        const selection =
          selectRelevantTools(
            contextFor(
              "Create a DOCX report for the quarterly planning review.",
            ),
            onlyUnrelated,
          );

        expect(selection.tools).toEqual(
          onlyUnrelated,
        );
      },
    );
  },
);
