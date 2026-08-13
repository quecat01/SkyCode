/**
 * Sky Code tool protocol and dispatch module.
 *
 * Defines the local, MCP, and sub-agent tools that the model may request,
 * builds the system prompt that teaches the model how to invoke them, parses
 * and validates `sky-tool` response blocks, and dispatches validated requests
 * to the active ToolHandlers implementation.
 *
 * index.ts uses this module to build the runtime system prompt and parse model
 * responses. toolhandlers.ts supplies the concrete handler implementations,
 * while MCP, plugin, catalog, and agent modules contribute capabilities that
 * are described dynamically in the generated prompt.
 */

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

/**
 * Tool identifiers that may appear in a model-generated `sky-tool` request.
 *
 * The readonly tuple is also used to derive ToolName and to validate tool names
 * received from untrusted model output at runtime.
 */
export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "run_shell_command",
  "mcp_call",
  "delegate_to_agent",
] as const;

/**
 * Union of every tool name recognized by Sky Code.
 *
 * Derived from TOOL_NAMES so the compile-time type and runtime validation list
 * remain synchronized.
 */
export type ToolName =
  (typeof TOOL_NAMES)[number];

/**
 * Arguments required by the read_file tool.
 */
export interface ReadFileArgs {
  /** File path whose contents should be read. */
  path: string;
}

/**
 * Arguments required by the write_file tool.
 */
export interface WriteFileArgs {
  /** Destination path to create or overwrite. */
  path: string;
  /** Complete content that should be written to the destination file. */
  content: string;
}

/**
 * Arguments required by the edit_file tool.
 *
 * edit_file performs a targeted replacement rather than rewriting an entire
 * file from scratch.
 */
export interface EditFileArgs {
  /** Path of the file to modify. */
  path: string;
  /** Existing text that must be located in the file. */
  old_str: string;
  /** Replacement text; an empty string is allowed to delete old_str. */
  new_str: string;
}

/**
 * Arguments accepted by the run_shell_command tool.
 */
export interface RunShellCommandArgs {
  /** Shell command text to execute. */
  command: string;
  /**
   * When true, requests background execution so a long-running command does
   * not block the interactive Sky Code prompt.
   */
  background?: boolean;
}

/**
 * Arguments required to invoke a tool exposed by a connected MCP server.
 */
export interface McpCallArgs {
  /** Configured MCP server name that owns the requested tool. */
  server: string;
  /** Name of the tool exposed by that MCP server. */
  name: string;
  /**
   * JSON-compatible argument object passed to the MCP tool. An omitted object
   * in model output is normalized to an empty object by the parser.
   */
  arguments: Record<string, unknown>;
}

/**
 * Arguments required to delegate one task to a configured sub-agent.
 */
export interface DelegateToAgentArgs {
  /** Name of the sub-agent that should receive the task. */
  agent: string;
  /** Task instruction sent to the selected sub-agent. */
  task: string;
  /** Optional additional context supplied with the delegated task. */
  context?: string;
}

/**
 * Fully validated tool request produced from a model `sky-tool` block.
 *
 * This discriminated union associates every tool name with the exact argument
 * object required by that tool. parseSkyToolRequest() is the boundary that
 * converts untrusted model JSON into one of these typed request variants.
 */
export type SkyToolRequest =
  | {
      /** Requests reading a file. */
      tool: "read_file";
      /** Validated read_file arguments. */
      args: ReadFileArgs;
    }
  | {
      /** Requests creating or replacing a file. */
      tool: "write_file";
      /** Validated write_file arguments. */
      args: WriteFileArgs;
    }
  | {
      /** Requests targeted text replacement within a file. */
      tool: "edit_file";
      /** Validated edit_file arguments. */
      args: EditFileArgs;
    }
  | {
      /** Requests execution of a shell command. */
      tool: "run_shell_command";
      /** Validated shell-command arguments. */
      args: RunShellCommandArgs;
    }
  | {
      /** Requests invocation of a connected MCP tool. */
      tool: "mcp_call";
      /** Validated MCP call arguments. */
      args: McpCallArgs;
    }
  | {
      /** Requests delegation of work to a configured sub-agent. */
      tool: "delegate_to_agent";
      /** Validated sub-agent delegation arguments. */
      args: DelegateToAgentArgs;
    };

/**
 * Formats connected MCP tool definitions for inclusion in the system prompt.
 *
 * Each connected tool contributes its server name, tool name, description, and
 * serialized input schema so the model knows both what can be called and which
 * argument shape the MCP server expects.
 *
 * @param {readonly McpToolDefinition[]} mcpTools - MCP tools discovered from
 * the currently connected servers.
 * @returns {string[]} Prompt lines describing the available MCP tools, or a
 * message stating that no MCP tools are connected.
 */
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
    // A missing or whitespace-only MCP description should still produce a
    // useful prompt line rather than displaying an empty description.
    const description =
      tool.description?.trim() ||
      "No description provided.";

    lines.push(
      `- Server "${tool.serverName}", tool "${tool.name}": ${description}`,
    );

    // Keep the original input schema machine-readable inside the otherwise
    // human-readable prompt so the model can construct valid arguments.
    lines.push(
      `  Input schema: ${JSON.stringify(tool.inputSchema)}`,
    );
  }

  return lines;
}

/**
 * Builds the complete system prompt that defines Sky Code's tool-using
 * behavior for the model.
 *
 * The static local-tool instructions are combined with capabilities discovered
 * at runtime: connected MCP tools, configured sub-agents, plugin skills, and
 * enabled catalog skills. The prompt also defines the strict `sky-tool` fenced
 * block protocol used by parseSkyToolRequest().
 *
 * @param {readonly McpToolDefinition[]} mcpTools - MCP tools connected for the
 * current session.
 * @param {readonly ActivePluginSkill[]} pluginSkills - Active skills supplied
 * by loaded plugins.
 * @param {readonly ActiveSubAgentDefinition[]} subAgents - Active sub-agents
 * available for delegated tasks.
 * @param {readonly CatalogSkill[]} catalogSkills - Enabled catalog skills
 * available to the current session.
 * @returns {string} Complete newline-delimited system prompt sent to the model.
 */
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

/**
 * Default Sky Code system prompt generated without session-specific MCP tools,
 * plugin skills, sub-agents, or catalog skills.
 *
 * Callers that know the active runtime capabilities should instead call
 * createSkyCodeSystemPrompt() with those definitions.
 */
export const SKY_CODE_SYSTEM_PROMPT =
  createSkyCodeSystemPrompt();

// Match complete fenced `sky-tool` blocks globally so the parser can inspect
// the leading request and determine whether later complete blocks contain
// additional valid tool requests. The capture group contains only the JSON body
// between the opening and closing fences.
const SKY_TOOL_BLOCK_PATTERN =
  /```sky-tool[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Determines whether an unknown value is a non-null object and not an array.
 *
 * Used as the basic structural guard before reading keys from model-generated
 * JSON objects.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when the value can be treated as a string-keyed
 * object; otherwise false.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Retrieves and validates a string argument from a tool argument object.
 *
 * By default, empty or whitespace-only strings are rejected. Callers may allow
 * empty strings for fields where emptiness has intentional meaning, such as
 * writing an empty file or replacing text with nothing.
 *
 * @param {Record<string, unknown>} args - Parsed tool argument object.
 * @param {string} key - Property name whose value should be validated.
 * @param {boolean} allowEmpty - Whether an empty string is acceptable.
 * Defaults to false.
 * @returns {string} The original string value without trimming or otherwise
 * modifying it.
 * @throws {Error} If the property is not a string or is empty when allowEmpty
 * is false.
 */
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

  // Return the original value because whitespace can be significant in file
  // contents, edit strings, shell commands, and other tool arguments.
  return value;
}

/**
 * Retrieves and validates an object-valued tool argument.
 *
 * When allowMissing is true, an absent property is normalized to an empty
 * object. This is used for MCP calls whose `arguments` object may legitimately
 * contain no fields.
 *
 * @param {Record<string, unknown>} args - Parsed tool argument object.
 * @param {string} key - Property name whose value should be validated.
 * @param {boolean} allowMissing - Whether an undefined property should become
 * an empty object. Defaults to false.
 * @returns {Record<string, unknown>} The supplied object, or an empty object
 * when the property is omitted and allowMissing is true.
 * @throws {Error} If the required property is missing or is not a JSON object.
 */
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

/**
 * Type guard that determines whether an unknown value is a recognized Sky Code
 * tool name.
 *
 * @param {unknown} value - Candidate tool identifier.
 * @returns {boolean} True when the value appears in TOOL_NAMES; otherwise
 * false.
 */
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

/**
 * Parses and validates the JSON body captured from one complete `sky-tool`
 * fenced block.
 *
 * This helper contains the JSON, tool-name, args-object, and tool-specific
 * validation shared by the leading request and any later complete blocks that
 * are inspected only to determine whether a multi-block warning is required.
 *
 * @param {string} jsonText - Raw text captured between the opening and closing
 * fences of one complete `sky-tool` block.
 * @returns {SkyToolRequest} Fully validated Sky Code tool request.
 * @throws {Error} If the block contains invalid JSON, the JSON is not an
 * object, the tool name is unknown, args is not an object, or a tool-specific
 * argument fails validation.
 *
 * Side effects: none.
 */
function parseSkyToolBlockJson(
  jsonText: string,
): SkyToolRequest {
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

  // The recognized tool name acts as the discriminator that determines which
  // arguments must be present and which optional values are permitted.
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
          // Empty content is valid because writing a zero-length file is a
          // legitimate operation.
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
          // An empty replacement intentionally supports deleting old_str.
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
          // Preserve omission rather than materializing background: undefined
          // in the normalized request.
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
          // MCP tools with no parameters may omit `arguments`; normalize that
          // case to the empty object required by McpCallArgs.
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
          // Keep optional context absent when the model did not supply it.
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

/**
 * Parses and validates a model response containing a Sky Code tool request.
 *
 * A valid leading tool request must begin the trimmed model response and must
 * contain a complete fenced `sky-tool` block whose contents are a JSON object
 * containing recognized `tool` and object-valued `args` properties.
 *
 * The leading block is validated exactly as before. Later complete fenced
 * blocks are inspected only to determine whether they also contain fully valid
 * Sky Code tool requests. If more than one valid request is present, only the
 * leading request is returned and a terminal warning explains that the
 * additional valid requests were ignored and suggests running /compact.
 *
 * Later complete blocks containing invalid JSON or otherwise failing normal
 * Sky Code tool validation are not counted as additional valid blocks and do
 * not trigger the multi-block warning. An ordinary model response with no
 * complete sky-tool block still returns null.
 *
 * @param {string} responseText - Complete assistant response returned by the
 * model.
 * @param {{ warnOnMultiple?: boolean }} [options] - warnOnMultiple (default
 * true) controls whether the multi-block terminal warning is emitted. Callers
 * that re-parse a stored assistant message for internal bookkeeping (for
 * example, reconstructing tool-result pairing from a previous session's
 * history) should pass `{ warnOnMultiple: false }` so a warning about a past,
 * already-resolved turn is not replayed as if it were live.
 * @returns {SkyToolRequest | null} Validated leading tool request, or null when
 * the response does not contain a complete sky-tool block.
 * @throws {Error} If the leading tool block does not start the response, its
 * JSON is invalid, the tool name is unknown, args is not an object, or a
 * tool-specific argument fails validation.
 *
 * Side effect: writes a warning to stderr when more than one complete fenced
 * block contains a fully valid Sky Code tool request, unless suppressed via
 * `options.warnOnMultiple`.
 */
export function parseSkyToolRequest(
  responseText: string,
  options?: { warnOnMultiple?: boolean },
): SkyToolRequest | null {
  const warnOnMultiple =
    options?.warnOnMultiple ??
      true;

  const trimmedResponse =
    responseText.trim();

  const matches = [
    ...trimmedResponse.matchAll(
      SKY_TOOL_BLOCK_PATTERN,
    ),
  ];

  // No complete tool block means this is an ordinary assistant response.
  if (matches.length === 0) {
    return null;
  }

  const match = matches[0];

  // Preserve the existing protocol rule for the primary request: ordinary
  // assistant prose cannot appear before the first complete tool block.
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

  // Validate the leading request before inspecting later blocks. This preserves
  // its existing error behavior instead of hiding a malformed primary request.
  const request =
    parseSkyToolBlockJson(
      jsonText,
    );

  let validBlockCount = 1;

  for (
    const additionalMatch of
    matches.slice(1)
  ) {
    const additionalJsonText =
      additionalMatch[1];

    if (
      additionalJsonText ===
        undefined
    ) {
      continue;
    }

    try {
      parseSkyToolBlockJson(
        additionalJsonText,
      );

      validBlockCount += 1;
    } catch {
      // A malformed later block cannot be executed, so it must not turn an
      // otherwise valid primary request into a multi-block warning.
    }
  }

  if (validBlockCount > 1 && warnOnMultiple) {
    console.warn(
      [
        `Warning: The model returned ${validBlockCount} sky-tool blocks. Only the first was used.`,
        "This can happen when the conversation is very long. Consider running /compact.",
        "",
      ].join("\n"),
    );
  }

  return request;
}

/**
 * Standard result returned by every Sky Code tool handler.
 */
export interface ToolExecutionResult {
  /** True when the requested operation completed successfully. */
  success: boolean;
  /**
   * Human- or model-readable result text. On failure this normally explains
   * why the operation could not be completed.
   */
  output: string;
}

/**
 * Runtime implementations for tools that Sky Code can dispatch.
 *
 * Core local handlers are required. MCP and sub-agent handlers are optional
 * because a session may have no MCP connections or configured sub-agents.
 */
export interface ToolHandlers {
  /**
   * Executes a read_file request.
   *
   * @param {ReadFileArgs} args - Validated file-read arguments.
   * @returns {Promise<ToolExecutionResult>} Result of the read operation.
   */
  read_file(
    args: ReadFileArgs,
  ): Promise<ToolExecutionResult>;

  /**
   * Executes a write_file request.
   *
   * @param {WriteFileArgs} args - Validated file-write arguments.
   * @returns {Promise<ToolExecutionResult>} Result of the write operation.
   */
  write_file(
    args: WriteFileArgs,
  ): Promise<ToolExecutionResult>;

  /**
   * Executes an edit_file request.
   *
   * @param {EditFileArgs} args - Validated targeted-edit arguments.
   * @returns {Promise<ToolExecutionResult>} Result of the edit operation.
   */
  edit_file(
    args: EditFileArgs,
  ): Promise<ToolExecutionResult>;

  /**
   * Executes a run_shell_command request.
   *
   * @param {RunShellCommandArgs} args - Validated shell-command arguments.
   * @returns {Promise<ToolExecutionResult>} Result of the shell operation or
   * background-task creation.
   */
  run_shell_command(
    args: RunShellCommandArgs,
  ): Promise<ToolExecutionResult>;

  /**
   * Executes an MCP tool request when MCP support is active.
   *
   * @param {McpCallArgs} args - Validated MCP server/tool arguments.
   * @returns {Promise<ToolExecutionResult>} Result returned by the MCP handler.
   */
  mcp_call?(
    args: McpCallArgs,
  ): Promise<ToolExecutionResult>;

  /**
   * Delegates work to a sub-agent when agent support is active.
   *
   * @param {DelegateToAgentArgs} args - Validated delegation arguments.
   * @returns {Promise<ToolExecutionResult>} Result of the delegated task.
   */
  delegate_to_agent?(
    args: DelegateToAgentArgs,
  ): Promise<ToolExecutionResult>;
}

/**
 * Dispatches a read_file request to the configured read handler.
 *
 * @param {ReadFileArgs} args - Validated read_file arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} Result returned by the read handler.
 *
 * Side effect: whatever filesystem access is performed by handlers.read_file().
 */
export async function read_file(
  args: ReadFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.read_file(args);
}

/**
 * Dispatches a write_file request to the configured write handler.
 *
 * @param {WriteFileArgs} args - Validated write_file arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} Result returned by the write handler.
 *
 * Side effect: may create or overwrite a file through handlers.write_file().
 */
export async function write_file(
  args: WriteFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.write_file(args);
}

/**
 * Dispatches an edit_file request to the configured edit handler.
 *
 * @param {EditFileArgs} args - Validated edit_file arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} Result returned by the edit handler.
 *
 * Side effect: may modify a file through handlers.edit_file().
 */
export async function edit_file(
  args: EditFileArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.edit_file(args);
}

/**
 * Dispatches a run_shell_command request to the configured shell handler.
 *
 * @param {RunShellCommandArgs} args - Validated shell-command arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} Result returned by the shell handler.
 *
 * Side effect: may spawn a foreground or background process through the
 * configured handler.
 */
export async function run_shell_command(
  args: RunShellCommandArgs,
  handlers: ToolHandlers,
): Promise<ToolExecutionResult> {
  return handlers.run_shell_command(
    args,
  );
}

/**
 * Dispatches an MCP request when an MCP handler exists.
 *
 * Sessions without active MCP support return a normal failed tool result rather
 * than throwing, allowing the model conversation to receive and respond to the
 * unavailable-capability message.
 *
 * @param {McpCallArgs} args - Validated MCP tool-call arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} MCP handler result, or a failed
 * result explaining that no MCP handler is active.
 *
 * Side effect: may perform an MCP request through handlers.mcp_call().
 */
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

/**
 * Dispatches a task to a configured sub-agent handler.
 *
 * Sessions without active sub-agent support return a failed ToolExecutionResult
 * rather than throwing, so the unavailable capability is communicated through
 * the ordinary tool-result path.
 *
 * @param {DelegateToAgentArgs} args - Validated sub-agent delegation
 * arguments.
 * @param {ToolHandlers} handlers - Active tool-handler collection.
 * @returns {Promise<ToolExecutionResult>} Delegation result, or a failed
 * result explaining that no sub-agent handler is active.
 *
 * Side effect: may start a delegated agent task through the active handler.
 */
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

/**
 * Executes one validated SkyToolRequest using the active handler collection.
 *
 * The request's discriminating `tool` property determines which thin dispatch
 * wrapper receives its already validated argument object.
 *
 * @param {SkyToolRequest} request - Parsed and validated model tool request.
 * @param {ToolHandlers} handlers - Active tool implementations for the current
 * Sky Code session.
 * @returns {Promise<ToolExecutionResult>} Result of the selected tool.
 *
 * Side effects: depend on the requested tool and may include filesystem
 * access, shell execution, MCP calls, or delegated sub-agent work.
 */
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
