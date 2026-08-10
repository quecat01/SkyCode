/**
 * Model Context Protocol (MCP) client connections and tool execution for Sky
 * Code.
 *
 * Supports local stdio servers, legacy SSE servers, and Streamable HTTP
 * servers through the official MCP SDK. This module normalizes tool discovery
 * and tool-call results behind one McpConnection interface so the rest of Sky
 * Code does not need transport-specific logic.
 *
 * Connection helpers also clean up partially initialized transports on failure,
 * while multi-server startup and shutdown attempt to leave all successfully
 * opened connections in a consistent state.
 */
import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";

import {
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";

import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  HttpMcpServerConfig,
  McpServerConfig,
  SseMcpServerConfig,
  StdioMcpServerConfig,
} from "./config.js";

/**
 * Transport-independent description of one tool advertised by an MCP server.
 *
 * serverName preserves which configured server owns the tool so identically
 * named tools from different servers remain distinguishable.
 */
export interface McpToolDefinition {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
}

/**
 * Normalized result returned to Sky Code after an MCP tool call.
 *
 * output is the human/model-readable representation derived from MCP content.
 * rawResult preserves the original SDK result for callers that need information
 * not represented by the normalized text.
 */
export interface McpToolCallResult {
  success: boolean;
  output: string;
  rawResult: unknown;
}

/**
 * Common runtime interface implemented by every supported MCP transport.
 *
 * Implementations expose their configured server name and transport type while
 * presenting identical tool-listing, tool-calling, and shutdown operations.
 */
export interface McpConnection {
  readonly serverName: string;

  readonly transport:
    | "stdio"
    | "sse"
    | "http";

  listTools():
    Promise<McpToolDefinition[]>;

  callTool(
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<McpToolCallResult>;

  close(): Promise<void>;
}

/**
 * Checks whether an unknown value is a non-null, non-array object.
 *
 * MCP responses cross a runtime boundary, so normalization code validates
 * object shape before reading fields.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when value can be treated as an object record.
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
 * Converts an arbitrary MCP value into readable text.
 *
 * Strings are preserved directly. Other values are pretty-printed as JSON when
 * possible; cyclic or otherwise non-serializable values fall back to String().
 *
 * @param {unknown} value - Value to render.
 * @returns {string} Readable representation of the value.
 */
function formatUnknownValue(
  value: unknown,
): string {
  if (
    typeof value === "string"
  ) {
    return value;
  }

  try {
    return JSON.stringify(
      value,
      null,
      2,
    );
  } catch {
    return String(value);
  }
}

/**
 * Converts one MCP content item into text suitable for Sky Code's tool-result
 * channel.
 *
 * Text and text-backed resources preserve their content. Image, audio,
 * resource-link, and binary-resource items use descriptive placeholders because
 * this result path is text based. Unknown shapes fall back to generic value
 * formatting.
 *
 * @param {unknown} item - MCP content item to normalize.
 * @returns {string} Text representation of the content item.
 */
function formatMcpContentItem(
  item: unknown,
): string {
  if (!isRecord(item)) {
    return formatUnknownValue(
      item,
    );
  }

  switch (item.type) {
    case "text":
      return typeof item.text ===
        "string"
        ? item.text
        : formatUnknownValue(
            item,
          );

    case "image": {
      const mimeType =
        typeof item.mimeType ===
          "string"
          ? item.mimeType
          : "unknown type";

      return `[MCP image content: ${mimeType}]`;
    }

    case "audio": {
      const mimeType =
        typeof item.mimeType ===
          "string"
          ? item.mimeType
          : "unknown type";

      return `[MCP audio content: ${mimeType}]`;
    }

    case "resource_link": {
      const name =
        typeof item.name ===
          "string"
          ? item.name
          : "unnamed resource";

      const uri =
        typeof item.uri ===
          "string"
          ? item.uri
          : "unknown URI";

      return `[MCP resource link: ${name} - ${uri}]`;
    }

    case "resource": {
      const resource =
        item.resource;

      if (!isRecord(resource)) {
        return formatUnknownValue(
          item,
        );
      }

      if (
        typeof resource.text ===
        "string"
      ) {
        return resource.text;
      }

      const uri =
        typeof resource.uri ===
          "string"
          ? resource.uri
          : "unknown URI";

      return `[MCP binary resource: ${uri}]`;
    }

    default:
      return formatUnknownValue(
        item,
      );
  }
}

/**
 * Normalizes an SDK MCP tool result into Sky Code's transport-independent
 * result shape.
 *
 * Protocol content items are preferred. If they produce no usable text,
 * structuredContent is used when present; otherwise the complete raw result is
 * formatted. MCP's isError flag determines success.
 *
 * @param {unknown} result - Raw MCP SDK tool result.
 * @returns {McpToolCallResult} Normalized success state, output, and raw result.
 */
function normalizeMcpToolResult(
  result: unknown,
): McpToolCallResult {
  if (!isRecord(result)) {
    return {
      success: false,
      output:
        "The MCP server returned an invalid tool result.",
      rawResult: result,
    };
  }

  const content =
    Array.isArray(
      result.content,
    )
      ? result.content
      : [];

  const formattedContent =
    content
      .map(
        formatMcpContentItem,
      )
      .filter(
        (value) =>
          value.trim() !== "",
      );

  if (
    formattedContent.length ===
      0 &&
    result.structuredContent !==
      undefined
  ) {
    formattedContent.push(
      formatUnknownValue(
        result.structuredContent,
      ),
    );
  }

  if (
    formattedContent.length ===
    0
  ) {
    formattedContent.push(
      formatUnknownValue(
        result,
      ),
    );
  }

  return {
    success:
      result.isError !== true,
    output:
      formattedContent.join(
        "\n",
      ),
    rawResult: result,
  };
}

/**
 * Retrieves every tool advertised by one connected MCP client.
 *
 * MCP tool listing may be paginated. Non-empty nextCursor values are followed
 * until the server reports no additional page. serverName is attached to every
 * returned tool definition.
 *
 * @param {Client} client - Connected MCP SDK client.
 * @param {string} serverName - Configured server name assigned to each tool.
 * @returns {Promise<McpToolDefinition[]>} Complete tool list across all pages.
 * @throws {Error} If an MCP listTools request fails.
 *
 * Side effect: may perform multiple MCP listTools requests.
 */
async function listClientTools(
  client: Client,
  serverName: string,
): Promise<McpToolDefinition[]> {
  const tools:
    McpToolDefinition[] = [];

  let cursor:
    string | undefined;

  do {
    const result =
      await client.listTools(
        cursor === undefined
          ? undefined
          : {
              cursor,
            },
      );

    for (
      const tool of
      result.tools
    ) {
      tools.push({
        serverName,
        name:
          tool.name,
        ...(tool.description ===
        undefined
          ? {}
          : {
              description:
                tool.description,
            }),
        inputSchema:
          tool.inputSchema,
        ...(tool.annotations ===
        undefined
          ? {}
          : {
              annotations:
                tool.annotations,
            }),
      });
    }

    cursor =
      typeof result.nextCursor ===
        "string" &&
      result.nextCursor.trim() !==
        ""
        ? result.nextCursor
        : undefined;
  } while (
    cursor !== undefined
  );

  return tools;
}

/**
 * Calls one MCP tool and normalizes its result.
 *
 * Empty or whitespace-only tool names are rejected before any MCP request is
 * sent. Arguments default to an empty object.
 *
 * @param {Client} client - Connected MCP SDK client.
 * @param {string} toolName - Non-empty MCP tool name.
 * @param {Record<string, unknown>} args - Tool arguments. Defaults to {}.
 * @returns {Promise<McpToolCallResult>} Normalized tool-call result.
 * @throws {Error} If toolName is empty or the MCP request fails.
 *
 * Side effect: sends an MCP callTool request.
 */
async function callClientTool(
  client: Client,
  toolName: string,
  args: Record<
    string,
    unknown
  > = {},
): Promise<McpToolCallResult> {
  if (
    toolName.trim() === ""
  ) {
    throw new Error(
      "MCP tool name must not be empty",
    );
  }

  const result =
    await client.callTool({
      name: toolName,
      arguments: args,
    });

  return normalizeMcpToolResult(
    result,
  );
}

/**
 * McpConnection implementation for an MCP server launched through stdio.
 *
 * In addition to the common interface, this implementation exposes the spawned
 * process ID and accumulated stderr for diagnostics.
 */
class StdioMcpConnection
  implements McpConnection
{
  public readonly transport =
    "stdio" as const;

  public constructor(
    public readonly serverName:
      string,

    private readonly client:
      Client,

    private readonly clientTransport:
      StdioClientTransport,

    private readonly readStderr:
      () => string,
  ) {}

  public get processId():
    number | null {
    return this.clientTransport
      .pid;
  }

  public getRecentStderr():
    string {
    return this.readStderr();
  }

  public async listTools():
    Promise<McpToolDefinition[]> {
    return listClientTools(
      this.client,
      this.serverName,
    );
  }

  public async callTool(
    toolName: string,
    args: Record<
      string,
      unknown
    > = {},
  ): Promise<McpToolCallResult> {
    return callClientTool(
      this.client,
      toolName,
      args,
    );
  }

  public async close():
    Promise<void> {
    await this.client.close();
  }
}

/**
 * McpConnection implementation for an MCP server reached through SSE.
 *
 * Tool operations delegate to the shared MCP client helpers; shutdown closes
 * the SDK client.
 */
class SseMcpConnection
  implements McpConnection
{
  public readonly transport =
    "sse" as const;

  public constructor(
    public readonly serverName:
      string,

    private readonly client:
      Client,
  ) {}

  public async listTools():
    Promise<McpToolDefinition[]> {
    return listClientTools(
      this.client,
      this.serverName,
    );
  }

  public async callTool(
    toolName: string,
    args: Record<
      string,
      unknown
    > = {},
  ): Promise<McpToolCallResult> {
    return callClientTool(
      this.client,
      toolName,
      args,
    );
  }

  public async close():
    Promise<void> {
    await this.client.close();
  }
}

/**
 * McpConnection implementation for MCP Streamable HTTP.
 *
 * HTTP shutdown attempts protocol-level session termination and then closes the
 * SDK client. Both operations are attempted even if termination fails.
 */
class HttpMcpConnection
  implements McpConnection
{
  public readonly transport =
    "http" as const;

  public constructor(
    public readonly serverName:
      string,

    private readonly client:
      Client,

    private readonly clientTransport:
      StreamableHTTPClientTransport,
  ) {}

  public async listTools():
    Promise<McpToolDefinition[]> {
    return listClientTools(
      this.client,
      this.serverName,
    );
  }

  public async callTool(
    toolName: string,
    args: Record<
      string,
      unknown
    > = {},
  ): Promise<McpToolCallResult> {
    return callClientTool(
      this.client,
      toolName,
      args,
    );
  }

  /**
   * Terminates the remote Streamable HTTP session and closes the local client.
   *
   * Client close is attempted even if terminateSession() fails. If both fail,
   * one combined diagnostic error is thrown.
   *
   * @returns {Promise<void>} Resolves when termination and close succeed.
   * @throws {Error} If session termination, client close, or both fail.
   *
   * Side effects: terminates the remote MCP session and closes local resources.
   */
  public async close():
    Promise<void> {
    let terminationError:
      unknown;

    try {
      await this.clientTransport
        .terminateSession();
    } catch (error) {
      terminationError =
        error;
    }

    try {
      await this.client.close();
    } catch (closeError) {
      if (
        terminationError !==
        undefined
      ) {
        throw new Error(
          `Unable to terminate MCP HTTP session: ${
            terminationError instanceof Error
              ? terminationError.message
              : String(terminationError)
          }; unable to close MCP HTTP connection: ${
            closeError instanceof Error
              ? closeError.message
              : String(closeError)
          }`,
        );
      }

      throw closeError;
    }

    if (
      terminationError !==
      undefined
    ) {
      throw terminationError;
    }
  }
}

/**
 * Creates the MCP SDK client identity used by Sky Code.
 *
 * @returns {Client} Unconnected MCP client identified as sky-code 0.1.0.
 */
function createMcpClient():
  Client {
  return new Client(
    {
      name:
        "sky-code",
      version:
        "0.1.0",
    },
    {
      capabilities: {},
    },
  );
}

/**
 * Converts Sky Code stdio MCP configuration into SDK server parameters.
 *
 * Custom environment variables are merged over the SDK default environment
 * instead of replacing it. stderr is always piped for startup diagnostics.
 *
 * @param {StdioMcpServerConfig} config - Configured stdio MCP server.
 * @returns {StdioServerParameters} Parameters for StdioClientTransport.
 */
function createStdioServerParameters(
  config:
    StdioMcpServerConfig,
): StdioServerParameters {
  const environment =
    config.env === undefined
      ? undefined
      : {
          ...getDefaultEnvironment(),
          ...config.env,
        };

  return {
    command:
      config.command,
    args:
      config.args,
    stderr:
      "pipe",
    ...(config.cwd ===
    undefined
      ? {}
      : {
          cwd:
            config.cwd,
        }),
    ...(environment ===
    undefined
      ? {}
      : {
          env:
            environment,
        }),
  };
}

/**
 * Parses and validates an MCP SSE server URL.
 *
 * Only http:// and https:// are accepted. WebSocket URLs receive a specific
 * rejection because this transport does not support them.
 *
 * @param {SseMcpServerConfig} config - Configured SSE MCP server.
 * @returns {URL} Validated HTTP(S) URL.
 * @throws {Error} If the URL is invalid or uses an unsupported protocol.
 */
function createSseUrl(
  config:
    SseMcpServerConfig,
): URL {
  const url =
    new URL(
      config.url,
    );

  if (
    url.protocol === "ws:" ||
    url.protocol === "wss:"
  ) {
    throw new Error(
      `MCP SSE server "${config.name}" does not support WebSocket URLs.`,
    );
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      `MCP SSE server "${config.name}" must use an http:// or https:// URL.`,
    );
  }

  return url;
}

/**
 * Parses and validates an MCP Streamable HTTP server URL.
 *
 * Only http:// and https:// are accepted; WebSocket and other schemes are
 * rejected before transport construction.
 *
 * @param {HttpMcpServerConfig} config - Configured HTTP MCP server.
 * @returns {URL} Validated HTTP(S) URL.
 * @throws {Error} If the URL is invalid or uses an unsupported protocol.
 */
function createHttpUrl(
  config:
    HttpMcpServerConfig,
): URL {
  const url =
    new URL(
      config.url,
    );

  if (
    url.protocol === "ws:" ||
    url.protocol === "wss:"
  ) {
    throw new Error(
      `MCP Streamable HTTP server "${config.name}" does not support WebSocket URLs.`,
    );
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      `MCP Streamable HTTP server "${config.name}" must use an http:// or https:// URL.`,
    );
  }

  return url;
}

/**
 * Launches and connects to one configured stdio MCP server.
 *
 * Server stderr is accumulated during startup and retained for diagnostics.
 * Failed connection performs best-effort transport cleanup while preserving the
 * original connection error; captured stderr is appended when available.
 *
 * @param {StdioMcpServerConfig} config - Stdio server configuration.
 * @returns {Promise<McpConnection>} Connected stdio MCP connection.
 * @throws {Error} If the MCP client cannot connect.
 *
 * Side effects: may spawn an MCP process, capture stderr, and open a connection.
 */
export async function connectStdioMcpServer(
  config:
    StdioMcpServerConfig,
): Promise<McpConnection> {
  const transport =
    new StdioClientTransport(
      createStdioServerParameters(
        config,
      ),
    );

  let stderrOutput = "";

  transport.stderr?.on(
    "data",
    (chunk: unknown) => {
      stderrOutput +=
        Buffer.isBuffer(chunk)
          ? chunk.toString(
              "utf8",
            )
          : String(chunk);
    },
  );

  const client =
    createMcpClient();

  try {
    await client.connect(
      transport,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Preserve the original connection error.
    }

    const stderrDetails =
      stderrOutput.trim() === ""
        ? ""
        : `\nMCP server stderr:\n${stderrOutput.trim()}`;

    throw new Error(
      `Unable to connect to MCP server "${config.name}": ${
        error instanceof Error
          ? error.message
          : String(error)
      }${stderrDetails}`,
    );
  }

  return new StdioMcpConnection(
    config.name,
    client,
    transport,
    () => stderrOutput,
  );
}

/**
 * Connects to one configured MCP SSE server.
 *
 * Optional configured headers are supplied through the transport request
 * initialization. Failed connection performs a best-effort transport close.
 *
 * @param {SseMcpServerConfig} config - SSE server configuration.
 * @returns {Promise<McpConnection>} Connected SSE MCP connection.
 * @throws {Error} If URL validation or MCP connection fails.
 *
 * Side effect: opens an MCP SSE connection.
 */
export async function connectSseMcpServer(
  config:
    SseMcpServerConfig,
): Promise<McpConnection> {
  const url =
    createSseUrl(
      config,
    );

  const transport =
    new SSEClientTransport(
      url,
      config.headers ===
      undefined
        ? undefined
        : {
            requestInit: {
              headers:
                config.headers,
            },
          },
    );

  const client =
    createMcpClient();

  try {
    await client.connect(
      transport,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Preserve the original connection error.
    }

    throw new Error(
      `Unable to connect to MCP SSE server "${config.name}" at ${config.url}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  return new SseMcpConnection(
    config.name,
    client,
  );
}

/**
 * Connects to one configured MCP Streamable HTTP server.
 *
 * Optional configured headers are passed to the transport. Failed startup
 * performs best-effort transport cleanup while preserving the original error.
 *
 * @param {HttpMcpServerConfig} config - HTTP server configuration.
 * @returns {Promise<McpConnection>} Connected HTTP MCP connection.
 * @throws {Error} If URL validation or MCP connection fails.
 *
 * Side effect: opens an MCP Streamable HTTP connection.
 */
export async function connectHttpMcpServer(
  config:
    HttpMcpServerConfig,
): Promise<McpConnection> {
  const url =
    createHttpUrl(
      config,
    );

  const transport =
    new StreamableHTTPClientTransport(
      url,
      config.headers ===
      undefined
        ? undefined
        : {
            requestInit: {
              headers:
                config.headers,
            },
          },
    );

  const client =
    createMcpClient();

  try {
    await client.connect(
      transport,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // Preserve the original connection error.
    }

    throw new Error(
      `Unable to connect to MCP Streamable HTTP server "${config.name}" at ${config.url}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  return new HttpMcpConnection(
    config.name,
    client,
    transport,
  );
}

/**
 * Connects all configured MCP servers in configuration order.
 *
 * Each server is dispatched to its transport-specific connector. If any
 * connection fails, connections established earlier in this call are closed
 * before the startup error is rethrown.
 *
 * @param {McpServerConfig[]} serverConfigs - MCP server configurations.
 * @returns {Promise<McpConnection[]>} Connections in configuration order.
 * @throws {Error} If any server connection fails.
 *
 * Side effects: may launch processes, open network connections, and roll back
 * previously opened connections.
 */
export async function connectConfiguredMcpServers(
  serverConfigs:
    McpServerConfig[],
): Promise<McpConnection[]> {
  const connections:
    McpConnection[] = [];

  try {
    for (
      const config of
      serverConfigs
    ) {
      switch (
        config.transport
      ) {
        case "stdio":
          connections.push(
            await connectStdioMcpServer(
              config,
            ),
          );
          break;

        case "sse":
          connections.push(
            await connectSseMcpServer(
              config,
            ),
          );
          break;

        case "http":
          connections.push(
            await connectHttpMcpServer(
              config,
            ),
          );
          break;
      }
    }

    return connections;
  // Multi-server startup is treated as one unit: roll back connections
  // established before the first failure.
  } catch (error) {
    await closeMcpConnections(
      connections,
    );

    throw error;
  }
}

/**
 * Closes a collection of MCP connections while attempting every close.
 *
 * Promise.allSettled() prevents one failure from stopping cleanup of the other
 * connections. Any rejection messages are aggregated after all attempts finish.
 *
 * @param {readonly McpConnection[]} connections - Connections to close.
 * @returns {Promise<void>} Resolves when every connection closes successfully.
 * @throws {Error} After cleanup if one or more connections failed to close.
 *
 * Side effect: closes every supplied MCP connection.
 */
export async function closeMcpConnections(
  connections:
    readonly McpConnection[],
): Promise<void> {
  // Use allSettled so every connection receives a close attempt even if one
  // connection rejects.
  const results =
    await Promise.allSettled(
      connections.map(
        (connection) =>
          connection.close(),
      ),
    );

  const failures =
    results.filter(
      (
        result,
      ): result is
        PromiseRejectedResult =>
        result.status ===
        "rejected",
    );

  if (
    failures.length > 0
  ) {
    const messages =
      failures.map(
        (failure) =>
          failure.reason
            instanceof Error
            ? failure.reason
                .message
            : String(
                failure.reason,
              ),
      );

    throw new Error(
      `Unable to close ${failures.length} MCP connection(s): ${messages.join("; ")}`,
    );
  }
}
