import {
  describe,
  expect,
  it,
} from "vitest";

import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_DEFINITIONS_BY_NAME,
  buildMcpToolName,
  mcpToolDefinitionsToToolDefinitions,
  mcpToolDefinitionToToolDefinition,
} from "../src/agent/tool-schema.ts";

import type {
  McpToolDefinition,
} from "../src/mcp.ts";

/**
 * The exhaustive list of built-in tools confirmed directly from
 * tools.ts's parseSkyToolArgsForKnownTool switch. Kept here, independent of
 * tool-schema.ts's own array, so a definition silently added or removed from
 * BUILTIN_TOOL_DEFINITIONS is caught by this test rather than only being
 * self-consistent with itself.
 */
const EXPECTED_BUILTIN_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell_command",
  "web_search",
  "web_fetch",
  "mcp_call",
  "delegate_to_agent",
  "create_docx",
  "create_pdf",
  "create_xlsx",
  "create_pptx",
];

/**
 * The known-correct permission-category mapping for every built-in tool,
 * confirmed directly from toolhandlers.ts (including its explicit comment
 * that all four document-generation tools share write_file's category).
 * Kept independent of tool-schema.ts's own values for the same reason as
 * EXPECTED_BUILTIN_TOOL_NAMES above.
 */
const EXPECTED_PERMISSION_CATEGORY: Record<string, string> = {
  read_file: "read-file",
  write_file: "write-file",
  edit_file: "edit-file",
  run_shell_command: "shell-command",
  web_search: "web-search",
  web_fetch: "web-fetch",
  mcp_call: "mcp-call",
  delegate_to_agent: "sub-agent",
  create_docx: "write-file",
  create_pdf: "write-file",
  create_xlsx: "write-file",
  create_pptx: "write-file",
};

describe(
  "agent/tool-schema.ts BUILTIN_TOOL_DEFINITIONS",
  () => {
    it(
      "defines exactly the 12 known built-in tools, each exactly once",
      () => {
        const names =
          BUILTIN_TOOL_DEFINITIONS.map(
            (definition) => definition.name,
          );

        expect(
          new Set(names).size,
        ).toBe(
          names.length,
        );

        expect(
          [...names].sort(),
        ).toEqual(
          [...EXPECTED_BUILTIN_TOOL_NAMES].sort(),
        );
      },
    );

    it(
      "maps every built-in tool to its known-correct permission category",
      () => {
        for (
          const definition of
          BUILTIN_TOOL_DEFINITIONS
        ) {
          expect(
            definition.permissionCategory,
          ).toBe(
            EXPECTED_PERMISSION_CATEGORY[definition.name],
          );
        }
      },
    );

    it(
      "gives every built-in tool an object-typed JSON Schema with a required array",
      () => {
        for (
          const definition of
          BUILTIN_TOOL_DEFINITIONS
        ) {
          expect(
            definition.parameters.type,
          ).toBe(
            "object",
          );

          expect(
            Array.isArray(
              definition.parameters.required,
            ),
          ).toBe(
            true,
          );

          expect(
            typeof definition.description,
          ).toBe(
            "string",
          );

          expect(
            definition.description.length,
          ).toBeGreaterThan(
            0,
          );
        }
      },
    );

    it(
      "gives every example's top-level arguments all of that tool's required fields",
      () => {
        for (
          const definition of
          BUILTIN_TOOL_DEFINITIONS
        ) {
          const requiredFields =
            definition.parameters.required as string[];

          for (
            const example of
            definition.examples
          ) {
            for (
              const field of
              requiredFields
            ) {
              expect(
                Object.prototype.hasOwnProperty.call(
                  example.arguments,
                  field,
                ),
              ).toBe(
                true,
              );
            }
          }
        }
      },
    );

    it(
      "keeps BUILTIN_TOOL_DEFINITIONS_BY_NAME in sync with BUILTIN_TOOL_DEFINITIONS",
      () => {
        expect(
          BUILTIN_TOOL_DEFINITIONS_BY_NAME.size,
        ).toBe(
          BUILTIN_TOOL_DEFINITIONS.length,
        );

        for (
          const definition of
          BUILTIN_TOOL_DEFINITIONS
        ) {
          expect(
            BUILTIN_TOOL_DEFINITIONS_BY_NAME.get(
              definition.name,
            ),
          ).toBe(
            definition,
          );
        }
      },
    );
  },
);

describe(
  "agent/tool-schema.ts MCP mapping",
  () => {
    it(
      "builds a flattened, provider-safe tool name from server and tool name",
      () => {
        expect(
          buildMcpToolName(
            "filesystem",
            "list_directory",
          ),
        ).toBe(
          "mcp__filesystem__list_directory",
        );
      },
    );

    it(
      "maps an MCP tool definition to a canonical ToolDefinition, preserving its schema and description",
      () => {
        const mcpTool: McpToolDefinition = {
          serverName: "filesystem",
          name: "list_directory",
          description: "Lists files in a directory.",
          inputSchema: {
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
        };

        const definition =
          mcpToolDefinitionToToolDefinition(
            mcpTool,
          );

        expect(definition.name).toBe(
          "mcp__filesystem__list_directory",
        );

        expect(definition.description).toBe(
          "Lists files in a directory.",
        );

        expect(definition.parameters).toBe(
          mcpTool.inputSchema,
        );

        expect(definition.examples).toEqual(
          [],
        );

        expect(definition.permissionCategory).toBe(
          "mcp-call",
        );
      },
    );

    it(
      "synthesizes a fallback description naming the server and tool when the MCP server gave none",
      () => {
        const mcpTool: McpToolDefinition = {
          serverName: "filesystem",
          name: "list_directory",
          inputSchema: {
            type: "object",
          },
        };

        const definition =
          mcpToolDefinitionToToolDefinition(
            mcpTool,
          );

        expect(
          definition.description,
        ).toContain(
          "filesystem",
        );

        expect(
          definition.description,
        ).toContain(
          "list_directory",
        );
      },
    );

    it(
      "maps a list of MCP tool definitions in order",
      () => {
        const mcpTools: McpToolDefinition[] = [
          {
            serverName: "filesystem",
            name: "list_directory",
            inputSchema: {
              type: "object",
            },
          },
          {
            serverName: "filesystem",
            name: "read_file",
            inputSchema: {
              type: "object",
            },
          },
          {
            serverName: "search",
            name: "query",
            inputSchema: {
              type: "object",
            },
          },
        ];

        const definitions =
          mcpToolDefinitionsToToolDefinitions(
            mcpTools,
          );

        expect(
          definitions.map(
            (definition) => definition.name,
          ),
        ).toEqual([
          "mcp__filesystem__list_directory",
          "mcp__filesystem__read_file",
          "mcp__search__query",
        ]);
      },
    );
  },
);
