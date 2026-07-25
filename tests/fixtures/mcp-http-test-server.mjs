#!/usr/bin/env node

import {
  randomUUID,
} from "node:crypto";

import {
  createServer as createHttpServer,
} from "node:http";

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const port =
  Number(process.argv[2]);

if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  console.error(
    "A valid TCP port must be provided.",
  );

  process.exit(1);
}

const requiredHeader =
  process.env.SKY_CODE_TEST_HEADER ??
  "enabled";

const activeSessions =
  new Map();

function createMcpServer() {
  const server =
    new McpServer({
      name:
        "sky-code-phase2-http-test",
      version:
        "1.0.0",
    });

  server.registerTool(
    "phase2_http_ping",
    {
      description:
        "Return a fixed response confirming that MCP Streamable HTTP communication works.",
    },
    async () => {
      return {
        content: [
          {
            type:
              "text",
            text:
              "Sky Code MCP Streamable HTTP connection works.",
          },
        ],
      };
    },
  );

  return server;
}

function hasRequiredHeader(
  request,
) {
  return (
    request.headers[
      "x-sky-code-test"
    ] === requiredHeader
  );
}

function getSessionId(
  request,
) {
  const value =
    request.headers[
      "mcp-session-id"
    ];

  if (
    Array.isArray(value)
  ) {
    return value[0];
  }

  return value;
}

async function readJsonBody(
  request,
) {
  const chunks = [];

  for await (
    const chunk of request
  ) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk),
    );
  }

  const text =
    Buffer.concat(
      chunks,
    ).toString("utf8");

  if (
    text.trim() === ""
  ) {
    return undefined;
  }

  return JSON.parse(text);
}

function sendText(
  response,
  statusCode,
  text,
) {
  response.writeHead(
    statusCode,
    {
      "Content-Type":
        "text/plain; charset=utf-8",
    },
  );

  response.end(text);
}

function sendJson(
  response,
  statusCode,
  value,
) {
  response.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8",
    },
  );

  response.end(
    JSON.stringify(value),
  );
}

function sendMcpError(
  response,
  statusCode,
  message,
) {
  sendJson(
    response,
    statusCode,
    {
      jsonrpc:
        "2.0",
      error: {
        code:
          -32000,
        message,
      },
      id:
        null,
    },
  );
}

function describeJsonRpcBody(
  value,
) {
  const messages =
    Array.isArray(value)
      ? value
      : [
          value,
        ];

  return messages
    .map(
      (
        message,
      ) => {
        if (
          typeof message !==
            "object" ||
          message === null
        ) {
          return "unknown";
        }

        if (
          typeof message.method ===
          "string"
        ) {
          return message.method;
        }

        if (
          Object.hasOwn(
            message,
            "result",
          )
        ) {
          return "result";
        }

        if (
          Object.hasOwn(
            message,
            "error",
          )
        ) {
          return "error";
        }

        return "unknown";
      },
    )
    .join(", ");
}

const httpServer =
  createHttpServer(
    async (
      request,
      response,
    ) => {
      try {
        const requestUrl =
          new URL(
            request.url ?? "/",
            `http://127.0.0.1:${port}`,
          );

        if (
          request.method ===
            "GET" &&
          requestUrl.pathname ===
            "/health"
        ) {
          sendText(
            response,
            200,
            "ready",
          );

          return;
        }

        if (
          request.method ===
            "GET" &&
          requestUrl.pathname ===
            "/sessions"
        ) {
          sendText(
            response,
            200,
            String(
              activeSessions.size,
            ),
          );

          return;
        }

        if (
          requestUrl.pathname !==
          "/mcp"
        ) {
          sendText(
            response,
            404,
            "Not found.",
          );

          return;
        }

        if (
          !hasRequiredHeader(
            request,
          )
        ) {
          sendText(
            response,
            401,
            "Missing or invalid test header.",
          );

          return;
        }

        console.error(
          `HTTP ${request.method} header accepted.`,
        );

        const sessionId =
          getSessionId(
            request,
          );

        let parsedBody;

        if (
          request.method ===
          "POST"
        ) {
          parsedBody =
            await readJsonBody(
              request,
            );

          console.error(
            `HTTP POST JSON-RPC: ${describeJsonRpcBody(parsedBody)}; session: ${sessionId ?? "none"}.`,
          );
        }

        let transport;

        if (
          sessionId !== undefined
        ) {
          const session =
            activeSessions.get(
              sessionId,
            );

          if (!session) {
            sendMcpError(
              response,
              404,
              "Unknown MCP session.",
            );

            return;
          }

          transport =
            session.transport;

          await transport
            .handleRequest(
              request,
              response,
              parsedBody,
            );

          return;
        }

        if (
          request.method !==
          "POST"
        ) {
          sendMcpError(
            response,
            400,
            "A session ID is required.",
          );

          return;
        }

        if (
          !isInitializeRequest(
            parsedBody,
          )
        ) {
          sendMcpError(
            response,
            400,
            "Expected an MCP initialization request.",
          );

          return;
        }

        const server =
          createMcpServer();

        let newTransport;

        newTransport =
          new StreamableHTTPServerTransport({
            sessionIdGenerator:
              () =>
                randomUUID(),

            onsessioninitialized:
              (newSessionId) => {
                activeSessions.set(
                  newSessionId,
                  {
                    transport:
                      newTransport,
                    server,
                  },
                );

                console.error(
                  "HTTP session initialized.",
                );
              },
          });

        newTransport.onclose =
          () => {
            const closedSessionId =
              newTransport.sessionId;

            if (
              closedSessionId !==
              undefined
            ) {
              activeSessions.delete(
                closedSessionId,
              );
            }

            console.error(
              "HTTP session closed.",
            );
          };

        await server.connect(
          newTransport,
        );

        await newTransport
          .handleRequest(
            request,
            response,
            parsedBody,
          );
      } catch (error) {
        console.error(
          "HTTP test server request failed:",
          error,
        );

        if (
          !response.headersSent
        ) {
          sendText(
            response,
            500,
            "Internal server error.",
          );
        } else {
          response.end();
        }
      }
    },
  );

httpServer.listen(
  port,
  "127.0.0.1",
  () => {
    console.log(
      `READY ${port}`,
    );
  },
);

let shuttingDown =
  false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown =
    true;

  const sessions = [
    ...activeSessions.values(),
  ];

  activeSessions.clear();

  await Promise.allSettled(
    sessions.map(
      async (
        session,
      ) => {
        await session.server
          .close();
      },
    ),
  );

  await new Promise(
    (
      resolve,
    ) => {
      httpServer.close(
        () => resolve(),
      );
    },
  );
}

async function handleShutdown() {
  try {
    await shutdown();
    process.exit(0);
  } catch (error) {
    console.error(
      "HTTP test server shutdown failed:",
      error,
    );

    process.exit(1);
  }
}

process.on(
  "SIGINT",
  handleShutdown,
);

process.on(
  "SIGTERM",
  handleShutdown,
);
