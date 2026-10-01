/**
 * Canonical tool schemas for Sky Code's model/provider-independent agent
 * execution layer.
 *
 * BUILTIN_TOOL_DEFINITIONS is the single source of truth for the shape of
 * every one of Sky Code's 12 existing built-in tools (see agent/types.ts's
 * ToolDefinition doc comment for why this matters: the same array is meant
 * to back execution-time argument validation, NativeStrategy's provider tool
 * definitions, and PromptedStrategy's selection prompt, so there is exactly
 * one place these shapes are described).
 *
 * Every schema here is hand-derived from tools.ts's own hand-written
 * argument validators (parseSkyToolArgsForKnownTool and its helpers:
 * requireString, requireRecord, requireStringArray, validateXlsxSheets,
 * validatePptxSlides, and friends), not by importing tools.ts itself, so
 * this module has no runtime dependency on the existing sky-tool parsing
 * path. That also means it can drift from the real validators if either side
 * changes without the other; keeping both in sync is a manual responsibility
 * until execution-time validation is wired through this module instead of
 * tools.ts's current hand-written checks.
 *
 * Two deliberate looseness choices, made so this canonical schema is never
 * stricter than Sky Code's real current behavior:
 * - `additionalProperties` is left unset (permissive) throughout, because
 *   the existing validators never reject unknown object keys.
 * - A field is only given `minLength: 1` / `minItems: 1` where the
 *   corresponding real validator is known (from reading tools.ts) to reject
 *   an empty value; where that was not confirmed, no such constraint is
 *   added, even where a stricter constraint might seem natural.
 *
 * This module also holds the one McpToolDefinition -> ToolDefinition
 * mapping (mcpToolDefinitionToToolDefinition), so that translation exists in
 * exactly one place rather than being duplicated between mcp.ts and future
 * strategy wiring.
 */
import type {
  McpToolDefinition,
} from "../mcp.js";

import type {
  PermissionAction,
} from "../permissions.js";

import type {
  JsonSchema,
  ToolDefinition,
} from "./types.js";

/**
 * Narrows a permission-category string literal to a real PermissionAction at
 * compile time, so a typo here (e.g. "write-fiel") is a build error instead
 * of a silent runtime mismatch. ToolDefinition.permissionCategory itself
 * stays a plain string (see types.ts) so this leaf module's callers are
 * never forced to import PermissionAction just to read a ToolDefinition.
 *
 * @param {PermissionAction} action - A real permission-action category.
 * @returns {PermissionAction} The same value, unchanged.
 */
function permission(
  action: PermissionAction,
): PermissionAction {
  return action;
}

/**
 * JSON Schema for one xlsx cell value, matching validateXlsxCellValue's
 * accepted shapes: a plain string, number, boolean, or a single-field
 * { date: string } object.
 */
const xlsxCellValueSchema: JsonSchema = {
  description:
    "One spreadsheet cell value: a string, a number, a boolean, or a date object.",
  oneOf: [
    {
      type: "string",
    },
    {
      type: "number",
    },
    {
      type: "boolean",
    },
    {
      type: "object",
      description:
        "A date cell.",
      properties: {
        date: {
          type: "string",
          description:
            "Date value, e.g. an ISO-8601 date string.",
        },
      },
      required: [
        "date",
      ],
    },
  ],
};

/**
 * JSON Schema for one worksheet within create_xlsx's `sheets` array,
 * matching validateXlsxSheets's per-sheet shape.
 */
const xlsxSheetSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description:
        "Worksheet name.",
    },
    headers: {
      type: "array",
      items: {
        type: "string",
      },
      description:
        "Optional header row.",
    },
    rows: {
      type: "array",
      items: {
        type: "array",
        items: xlsxCellValueSchema,
      },
      description:
        "Data rows. Each row is an array of cell values.",
    },
  },
  required: [
    "name",
    "rows",
  ],
};

/** JSON Schema for a create_pptx title slide, matching validatePptxSlide's title case. */
const pptxTitleSlideSchema: JsonSchema = {
  type: "object",
  description:
    "A title slide.",
  properties: {
    type: {
      const: "title",
    },
    title: {
      type: "string",
      description:
        "Slide title.",
    },
    subtitle: {
      type: "string",
    },
    bullets: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
  required: [
    "type",
    "title",
  ],
};

/** JSON Schema for a create_pptx content slide, matching validatePptxSlide's content case. */
const pptxContentSlideSchema: JsonSchema = {
  type: "object",
  description:
    "A content slide, with optional bullets, a table, and/or an image.",
  properties: {
    type: {
      const: "content",
    },
    title: {
      type: "string",
    },
    bullets: {
      type: "array",
      items: {
        type: "string",
      },
    },
    table: {
      type: "object",
      properties: {
        headers: {
          type: "array",
          items: {
            type: "string",
          },
        },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      },
      required: [
        "headers",
        "rows",
      ],
    },
    image: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the image file.",
        },
        caption: {
          type: "string",
        },
      },
      required: [
        "path",
      ],
    },
  },
  required: [
    "type",
  ],
};

/** JSON Schema for a create_pptx chart slide, matching validatePptxSlide's chart case. */
const pptxChartSlideSchema: JsonSchema = {
  type: "object",
  description:
    "A chart slide.",
  properties: {
    type: {
      const: "chart",
    },
    title: {
      type: "string",
    },
    categories: {
      type: "array",
      items: {
        type: "string",
      },
    },
    series: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          values: {
            type: "array",
            items: {
              type: "number",
            },
          },
        },
        required: [
          "name",
          "values",
        ],
      },
    },
  },
  required: [
    "type",
    "categories",
    "series",
  ],
};

/**
 * JSON Schema for one create_pptx slide, discriminated by its `type` field,
 * matching validatePptxSlide's exhaustive switch (any other `type` value is
 * rejected).
 */
const pptxSlideSchema: JsonSchema = {
  description:
    "One slide, discriminated by its `type` field.",
  oneOf: [
    pptxTitleSlideSchema,
    pptxContentSlideSchema,
    pptxChartSlideSchema,
  ],
};

/**
 * Canonical definitions for all 12 of Sky Code's existing built-in tools.
 *
 * Order matches no particular significance; it mirrors the order the tools
 * were read from tools.ts's parseSkyToolArgsForKnownTool switch.
 */
export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Reads and returns the full text contents of a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to the file to read.",
        },
      },
      required: [
        "path",
      ],
    },
    examples: [
      {
        arguments: {
          path: "src/index.ts",
        },
      },
    ],
    permissionCategory: permission("read-file"),
  },
  {
    name: "write_file",
    description:
      "Writes text content to a file at the given path, creating it if it does not exist and overwriting it if it does.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to the file to write.",
        },
        content: {
          type: "string",
          description:
            "Full contents to write. An empty string writes an empty file.",
        },
      },
      required: [
        "path",
        "content",
      ],
    },
    examples: [
      {
        arguments: {
          path: "notes.md",
          content: "# Notes\n\n- first item\n",
        },
      },
    ],
    permissionCategory: permission("write-file"),
  },
  {
    name: "edit_file",
    description:
      "Replaces one exact occurrence of old_str with new_str in the file at path. old_str must match the file's current contents exactly.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to the file to edit.",
        },
        old_str: {
          type: "string",
          minLength: 1,
          description:
            "Exact existing text to find and replace. Must be non-empty.",
        },
        new_str: {
          type: "string",
          description:
            "Replacement text. An empty string deletes old_str.",
        },
      },
      required: [
        "path",
        "old_str",
        "new_str",
      ],
    },
    examples: [
      {
        arguments: {
          path: "src/config.ts",
          old_str: "const PORT = 3000;",
          new_str: "const PORT = 4000;",
        },
      },
    ],
    permissionCategory: permission("edit-file"),
  },
  {
    name: "run_shell_command",
    description:
      "Runs a shell command in the current working directory and returns its output. When background is true, the command is started without waiting for it to finish.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description:
            "Shell command to execute.",
        },
        background: {
          type: "boolean",
          description:
            "If true, runs the command without blocking for completion.",
        },
      },
      required: [
        "command",
      ],
    },
    examples: [
      {
        arguments: {
          command: "npm test",
        },
      },
      {
        arguments: {
          command: "npm run dev",
          background: true,
        },
        note: "Long-running command started in the background.",
      },
    ],
    permissionCategory: permission("shell-command"),
  },
  {
    name: "web_search",
    description:
      "Searches the web for the given query and returns results.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description:
            "Search query.",
        },
      },
      required: [
        "query",
      ],
    },
    examples: [
      {
        arguments: {
          query: "TypeScript NodeNext module resolution",
        },
      },
    ],
    permissionCategory: permission("web-search"),
  },
  {
    name: "web_fetch",
    description:
      "Fetches the contents of a web page at the given URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description:
            "URL to fetch.",
        },
      },
      required: [
        "url",
      ],
    },
    examples: [
      {
        arguments: {
          url: "https://docs.litellm.ai/docs/providers/ollama",
        },
      },
    ],
    permissionCategory: permission("web-fetch"),
  },
  {
    name: "mcp_call",
    description:
      "Calls a tool exposed by a connected MCP server, identified by server name and tool name.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          description:
            "Name of the configured MCP server to call.",
        },
        name: {
          type: "string",
          minLength: 1,
          description:
            "Name of the tool to call on that server.",
        },
        arguments: {
          type: "object",
          default: {},
          description:
            "Arguments object for the MCP tool call. Defaults to an empty object when omitted.",
        },
      },
      required: [
        "server",
        "name",
      ],
    },
    examples: [
      {
        arguments: {
          server: "filesystem",
          name: "list_directory",
          arguments: {
            path: ".",
          },
        },
      },
    ],
    permissionCategory: permission("mcp-call"),
  },
  {
    name: "delegate_to_agent",
    description:
      "Delegates a task to a named sub-agent, optionally with additional context.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          minLength: 1,
          description:
            "Name of the sub-agent to delegate to.",
        },
        task: {
          type: "string",
          minLength: 1,
          description:
            "Task description to hand off.",
        },
        context: {
          type: "string",
          description:
            "Optional additional context for the sub-agent.",
        },
      },
      required: [
        "agent",
        "task",
      ],
    },
    examples: [
      {
        arguments: {
          agent: "researcher",
          task: "Summarize the changes in the last 5 commits.",
        },
      },
    ],
    permissionCategory: permission("sub-agent"),
  },
  {
    name: "create_docx",
    description:
      "Creates a Word (.docx) document at path from Markdown-formatted content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to write the document to.",
        },
        content: {
          type: "string",
          minLength: 1,
          description:
            "Markdown-formatted source content for the document.",
        },
      },
      required: [
        "path",
        "content",
      ],
    },
    examples: [
      {
        arguments: {
          path: "report.docx",
          content: "# Report\n\nSummary text here.",
        },
      },
    ],
    permissionCategory: permission("write-file"),
  },
  {
    name: "create_pdf",
    description:
      "Creates a PDF document at path from Markdown-formatted content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to write the document to.",
        },
        content: {
          type: "string",
          minLength: 1,
          description:
            "Markdown-formatted source content for the document.",
        },
      },
      required: [
        "path",
        "content",
      ],
    },
    examples: [
      {
        arguments: {
          path: "report.pdf",
          content: "# Report\n\nSummary text here.",
        },
      },
    ],
    permissionCategory: permission("write-file"),
  },
  {
    name: "create_xlsx",
    description:
      "Creates an Excel (.xlsx) workbook at path from one or more worksheets.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to write the workbook to.",
        },
        sheets: {
          type: "array",
          minItems: 1,
          items: xlsxSheetSchema,
          description:
            "One or more worksheets to include, in order.",
        },
      },
      required: [
        "path",
        "sheets",
      ],
    },
    examples: [
      {
        arguments: {
          path: "summary.xlsx",
          sheets: [
            {
              name: "Project Summary",
              headers: [
                "Field",
                "Value",
              ],
              rows: [
                [
                  "Project name",
                  "Riverside substation upgrade",
                ],
                [
                  "Estimated cost",
                  125000,
                ],
              ],
            },
          ],
        },
      },
    ],
    permissionCategory: permission("write-file"),
  },
  {
    name: "create_pptx",
    description:
      "Creates a PowerPoint (.pptx) presentation at path from one or more slides. Each slide is a title slide, a content slide (bullets, a table, and/or an image), or a chart slide.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Path to write the presentation to.",
        },
        slides: {
          type: "array",
          minItems: 1,
          items: pptxSlideSchema,
          description:
            "One or more slides, in order.",
        },
      },
      required: [
        "path",
        "slides",
      ],
    },
    examples: [
      {
        arguments: {
          path: "kickoff.pptx",
          slides: [
            {
              type: "title",
              title: "Riverside Substation Upgrade",
              subtitle: "Daniel Mercer and Rebecca Stone",
            },
            {
              type: "chart",
              title: "Cost Comparison",
              categories: [
                "Current",
                "Proposed",
              ],
              series: [
                {
                  name: "Estimated cost",
                  values: [
                    100,
                    200,
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
    permissionCategory: permission("write-file"),
  },
];

/**
 * BUILTIN_TOOL_DEFINITIONS indexed by name, for O(1) lookup by execution-time
 * validation and strategy wiring. Built once at module load from the same
 * array; never mutated.
 */
export const BUILTIN_TOOL_DEFINITIONS_BY_NAME: ReadonlyMap<string, ToolDefinition> =
  new Map(
    BUILTIN_TOOL_DEFINITIONS.map(
      (definition) => [
        definition.name,
        definition,
      ],
    ),
  );

/**
 * Builds the flat tool name used for an MCP-originated ToolDefinition.
 *
 * OpenAI-compatible native tool-calling APIs (what NativeStrategy targets
 * through LiteLLM) restrict function/tool names to a limited character set
 * and do not accept the "/" Sky Code already uses when displaying an MCP
 * tool in error messages (executeMcpTool's
 * `MCP tool "${server}/${name}" failed`, in toolhandlers.ts). "__" is used
 * as the delimiter here instead, so the flattened name stays safe for that
 * use.
 *
 * This is intentionally one-directional. A server name may itself contain
 * "__", so splitting a flattened name back apart is ambiguous in general;
 * the wiring layer that builds these definitions should keep its own
 * (serverName, name) pairing (e.g. a Map keyed by the flattened name)
 * rather than trying to parse one back out of the name string.
 *
 * @param {string} serverName - Name of the MCP server the tool belongs to.
 * @param {string} name - The tool's own name, as reported by that server.
 * @returns {string} A flattened tool name safe for native tool-calling APIs.
 */
export function buildMcpToolName(
  serverName: string,
  name: string,
): string {
  return `mcp__${serverName}__${name}`;
}

/**
 * Converts one MCP server's tool definition into Sky Code's canonical
 * ToolDefinition shape.
 *
 * This is the only place this translation happens; strategy wiring and any
 * future native-tool-per-MCP-tool exposure should call this (or
 * mcpToolDefinitionsToToolDefinitions()) rather than re-deriving it.
 *
 * No example arguments are synthesized: an invented example could describe
 * an argument shape the real MCP tool does not actually accept, which would
 * be worse than no example at all. `parameters` is passed through
 * unchanged, since McpToolDefinition.inputSchema is already
 * JSON-Schema-shaped.
 *
 * @param {McpToolDefinition} mcpTool - The MCP server's own tool definition,
 * as returned by its list-tools call.
 * @returns {ToolDefinition} The equivalent canonical tool definition.
 */
export function mcpToolDefinitionToToolDefinition(
  mcpTool: McpToolDefinition,
): ToolDefinition {
  return {
    name: buildMcpToolName(
      mcpTool.serverName,
      mcpTool.name,
    ),
    description:
      mcpTool.description ??
      `MCP tool "${mcpTool.name}" on server "${mcpTool.serverName}". This server did not provide a description.`,
    parameters: mcpTool.inputSchema,
    examples: [],
    permissionCategory: permission("mcp-call"),
  };
}

/**
 * Converts a list of MCP tool definitions into their canonical
 * ToolDefinition equivalents, preserving order.
 *
 * @param {readonly McpToolDefinition[]} mcpTools - Tool definitions from one
 * or more connected MCP servers (e.g. loadMcpTools()'s return value, in
 * index.ts).
 * @returns {ToolDefinition[]} The equivalent canonical tool definitions, in
 * the same order.
 */
export function mcpToolDefinitionsToToolDefinitions(
  mcpTools: readonly McpToolDefinition[],
): ToolDefinition[] {
  return mcpTools.map(
    mcpToolDefinitionToToolDefinition,
  );
}
