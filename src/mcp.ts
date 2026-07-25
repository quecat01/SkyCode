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

export interface McpToolDefinition {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: unknown;
}

export interface McpToolCallResult {
  success: boolean;
  output: string;
  rawResult: unknown;
}

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

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

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
  } catch (error) {
    await closeMcpConnections(
      connections,
    );

    throw error;
  }
}

export async function closeMcpConnections(
  connections:
    readonly McpConnection[],
): Promise<void> {
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
