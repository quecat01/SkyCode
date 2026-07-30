import {
  formatSubAgentsForPrompt,
  type ActiveSubAgentDefinition,
} from "./agents.js";

import {
  formatCatalogSkillsForPrompt,
} from "./catalog-runtime.js";

import type {
  CatalogSkill,
} from "./catalog.js";

import type {
  McpToolDefinition,
} from "./mcp.js";

import {
  formatPluginSkillsForPrompt,
  type ActivePluginSkill,
} from "./plugins.js";

export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell_command",
  "mcp_call",
  "delegate_to_agent",
] as const;

export type ToolName =
  (typeof TOOL_NAMES)[number];

export interface ReadFileArgs {
  path: string;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface EditFileArgs {
  path: string;
  old_str: string;
  new_str: string;
}

export interface RunShellCommandArgs {
  command: string;
  background?: boolean;
}

export interface McpCallArgs {
  server: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DelegateToAgentArgs {
  agent: string;
  task: string;
  context?: string;
}

export type SkyToolRequest =
  | {
      tool: "read_file";
      args: ReadFileArgs;
    }
  | {
      tool: "write_file";
      args: WriteFileArgs;
    }
  | {
      tool: "edit_file";
      args: EditFileArgs;
    }
  | {
      tool: "run_shell_command";
      args: RunShellCommandArgs;
    }
  | {
      tool: "mcp_call";
      args: McpCallArgs;
    }
  | {
      tool: "delegate_to_agent";
      args: DelegateToAgentArgs;
    };

function formatMcpToolLines(
  mcpTools: readonly McpToolDefinition[],
): string[] {
  if (mcpTools.length === 0) {
    return [
      "",
      "No MCP tools are connected in this session.",
    ];
  }

  const lines = [
    "",
    "Connected MCP tools:",
  ];

  for (const tool of mcpTools) {
    const description =
      tool.description?.trim() ||
      "No description provided.";

    lines.push(
      `- Server "${tool.serverName}", tool "${tool.name}": ${description}`,
    );

    lines.push(
      `  Input schema: ${JSON.stringify(tool.inputSchema)}`,
    );
  }

  return lines;
}

export function createSkyCodeSystemPrompt(
  mcpTools:
    readonly McpToolDefinition[] = [],
  pluginSkills:
    readonly ActivePluginSkill[] = [],
  subAgents:
    readonly ActiveSubAgentDefinition[] = [],
  catalogSkills:
    readonly CatalogSkill[] = [],
): string {
  return [
    "You are Sky Code, an AI-powered CLI coding assistant.",
    "You help the user read, write, and edit files, run shell commands, and call connected MCP tools.",
    "",
    "You have access to these local tools:",
    "- read_file(path): Read the contents of a file",
    "- write_file(path, content): Write or create a file with the given content",
    "- edit_file(path, old_str, new_str): Replace old_str with new_str in a file",
    "- run_shell_command(command, background?): Run a shell command; set background to true for a long-running command that should not block the interactive prompt",
    "",
    "Connected MCP tools are called through:",
    "- mcp_call(server, name, arguments): Call a tool exposed by a connected MCP server",
    ...formatMcpToolLines(
      mcpTools,
    ),
    "",
    "Delegated sub-agent tasks are called through:",
    "- delegate_to_agent(agent, task, context?): Run one task in a separate sub-agent worker process",
    ...formatSubAgentsForPrompt(
      subAgents,
    ),
    ...formatPluginSkillsForPrompt(
      pluginSkills,
    ),
    ...formatCatalogSkillsForPrompt(
      catalogSkills,
    ),
    "",
    "When you want to use a tool, respond with ONLY a fenced code block tagged sky-tool containing a JSON object with \"tool\" and \"args\" keys.",
    "Do not include any other text in that response.",
    "Wait for the tool result before continuing.",
    "",
    "Local tool example:",
    "```sky-tool",
    "{\"tool\":\"read_file\",\"args\":{\"path\":\"/home/user/example.txt\"}}",
    "```",
    "",
    "MCP tool example:",
    "```sky-tool",
    "{\"tool\":\"mcp_call\",\"args\":{\"server\":\"example-server\",\"name\":\"example-tool\",\"arguments\":{}}}",
    "```",
    "",
    "Sub-agent delegation example:",
    "```sky-tool",
    "{\"tool\":\"delegate_to_agent\",\"args\":{\"agent\":\"code-reviewer\",\"task\":\"Review the supplied code for correctness problems.\",\"context\":\"Focus on src/index.ts.\"}}",
    "```",
  ].join("\n");
}

export const SKY_CODE_SYSTEM_PROMPT =
  createSkyCodeSystemPrompt();

const SKY_TOOL_BLOCK_PATTERN =
  /```sky-tool[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  allowEmpty: boolean = false,
): string {
  const value = args[key];

  if (typeof value !== "string") {
    throw new Error(
      `Tool argument "${key}" must be a string`,
    );
  }

  if (
    !allowEmpty &&
    value.trim() === ""
  ) {
    throw new Error(
      `Tool argument "${key}" must not be empty`,
    );
  }

  return value;
}

function requireRecord(
  args: Record<string, unknown>,
  key: string,
  allowMissing: boolean = false,
): Record<string, unknown> {
  const value = args[key];

  if (
    value === undefined &&
    allowMissing
  ) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(
      `Tool argument "${key}" must be a JSON object`,
    );
  }

  return value;
}

function isToolName(
  value: unknown,
): value is ToolName {
  return (
    typeof value === "string" &&
    TOOL_NAMES.includes(
      value as ToolName,
    )
  );
}

export function parseSkyToolRequest(
  responseText: string,
): SkyToolRequest | null {
  const trimmedResponse =
    responseText.trim();

  const matches = [
    ...trimmedResponse.matchAll(
      SKY_TOOL_BLOCK_PATTERN,
    ),
  ];

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    throw new Error(
      "The model response contains more than one sky-tool block",
    );
  }

  const match = matches[0];

  if (
    !match ||
    match.index !== 0
  ) {
    throw new Error(
      "A sky-tool request must begin the model response",
    );
  }

  const jsonText = match[1];

  if (jsonText === undefined) {
    throw new Error(
      "The sky-tool block is empty",
    );
  }

  let parsed: unknown;

  try {
    parsed =
      JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `The sky-tool block contains invalid JSON: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "The sky-tool JSON must contain an object",
    );
  }

  const tool = parsed.tool;
  const args = parsed.args;

  if (!isToolName(tool)) {
    throw new Error(
      `Unknown Sky Code tool: ${String(tool)}`,
    );
  }

  if (!isRecord(args)) {
    throw new Error(
      'The sky-tool JSON must contain an "args" object',
    );
  }

  switch (tool) {
    case "read_file":
      return {
        tool,
        args: {
          path: requireString(
            args,
            "path",
          ),
        },
      };

    case "write_file":
      return {
        tool,
        args: {
          path: requireString(
            args,
            "path",
          ),
          content:
            requireString(
              args,
              "content",
              true,
            ),
        },
      };

    case "edit_file":
      return {
        tool,
        args: {
          path: requireString(
            args,
            "path",
          ),
          old_str:
            requireString(
              args,
              "old_str",
            ),
          new_str:
            requireString(
              args,
              "new_str",
              true,
            ),
        },
      };

    case "run_shell_command": {
      const background =
        args.background;

      if (
        background !==
          undefined &&
        typeof background !==
          "boolean"
      ) {
        throw new Error(
          'Tool argument "background" must be a boolean',
        );
      }

      return {
        tool,
        args: {
          command:
            requireString(
              args,
              "command",
            ),
          ...(background ===
            undefined
            ? {}
            : {
                background,
              }),
        },
      };
    }

    case "mcp_call":
      return {
        tool,
        args: {
          server:
            requireString(
              args,
              "server",
            ),
          name:
            requireString(
              args,
              "name",
            ),
          arguments:
            requireRecord(
              args,
              "arguments",
              true,
            ),
        },
      };

    case "delegate_to_agent": {
      const context =
        args.context;

      if (
        context !==
          undefined &&
        typeof context !==
          "string"
      ) {
        throw new Error(
          'Tool argument "context" must be a string',
        );
      }

      return {
        tool,
        args: {
          agent:
            requireString(
              args,
              "agent",
            ),
          task:
            requireString(
              args,
              "task",
            ),
          ...(context ===
            undefined
            ? {}
            : {
                context,
              }),
        },
      };
    }
  }
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
}

export interface ToolHandlers {
  read_file(
    args: ReadFileArgs,
  ): Promise<ToolExecutionResult>;

  write_file(
    args: WriteFileArgs,
  ): Promise<ToolExecutionResult>;

  edit_file(
    args: EditFileArgs,
  ): Promise<ToolExecutionResult>;

  run_shell_command(
    args: RunShellCommandArgs,
  ): Promise<ToolExecutionResult>;

  mcp_call?(
    args: McpCallArgs,
  ): Promise<ToolExecutionResult>;

  delegate_to_agent?(
    args: DelegateToAgentArgs,
  ): Promise<ToolExecutionResult>;
}

export async function read_file(
  args: ReadFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.read_file(args);
}

export async function write_file(
  args: WriteFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.write_file(args);
}

export async function edit_file(
  args: EditFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.edit_file(args);
}

export async function run_shell_command(
  args: RunShellCommandArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.run_shell_command(
    args,
  );
}

export async function mcp_call(
  args: McpCallArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  if (!handlers.mcp_call) {
    return {
      success: false,
      output:
        "No MCP tool handler is active in this Sky Code session.",
    };
  }

  return handlers.mcp_call(args);
}

export async function delegate_to_agent(
  args: DelegateToAgentArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  if (
    !handlers
      .delegate_to_agent
  ) {
    return {
      success:
        false,
      output:
        "No sub-agent handler is active in this Sky Code session.",
    };
  }

  return handlers
    .delegate_to_agent(
      args,
    );
}

export async function executeSkyToolRequest(
  request: SkyToolRequest,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  switch (request.tool) {
    case "read_file":
      return read_file(
        request.args,
        handlers,
      );

    case "write_file":
      return write_file(
        request.args,
        handlers,
      );

    case "edit_file":
      return edit_file(
        request.args,
        handlers,
      );

    case "run_shell_command":
      return run_shell_command(
        request.args,
        handlers,
      );

    case "mcp_call":
      return mcp_call(
        request.args,
        handlers,
      );

    case "delegate_to_agent":
      return delegate_to_agent(
        request.args,
        handlers,
      );
  }
}
