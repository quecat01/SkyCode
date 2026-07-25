#!/usr/bin/env node

import {
  createServer as createHttpServer,
} from "node:http";

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  SSEServerTransport,
} from "@modelcontextprotocol/sdk/server/sse.js";

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
        "sky-code-phase2-sse-test",
      version:
        "1.0.0",
    });

  server.registerTool(
    "phase2_sse_ping",
    {
      description:
        "Return a fixed response confirming that MCP SSE communication works.",
    },
    async () => {
      return {
        content: [
          {
            type:
              "text",
            text:
              "Sky Code MCP SSE connection works.",
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
          requestUrl.pathname ===
            "/sse" ||
          requestUrl.pathname ===
            "/messages"
        ) {
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
        }

        if (
          request.method ===
            "GET" &&
          requestUrl.pathname ===
            "/sse"
        ) {
          console.error(
            "SSE GET header accepted.",
          );

          const transport =
            new SSEServerTransport(
              "/messages",
              response,
            );

          const server =
            createMcpServer();

          activeSessions.set(
            transport.sessionId,
            {
              transport,
              server,
            },
          );

          transport.onclose =
            () => {
              activeSessions.delete(
                transport.sessionId,
              );
            };

          await server.connect(
            transport,
          );

          return;
        }

        if (
          request.method ===
            "POST" &&
          requestUrl.pathname ===
            "/messages"
        ) {
          console.error(
            "SSE POST header accepted.",
          );

          const sessionId =
            requestUrl.searchParams.get(
              "sessionId",
            );

          if (!sessionId) {
            sendText(
              response,
              400,
              "Missing sessionId.",
            );

            return;
          }

          const session =
            activeSessions.get(
              sessionId,
            );

          if (!session) {
            sendText(
              response,
              404,
              "Unknown session.",
            );

            return;
          }

          const parsedBody =
            await readJsonBody(
              request,
            );

          await session.transport
            .handlePostMessage(
              request,
              response,
              parsedBody,
            );

          return;
        }

        sendText(
          response,
          404,
          "Not found.",
        );
      } catch (error) {
        console.error(
          "SSE test server request failed:",
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

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  const sessions = [
    ...activeSessions.values(),
  ];

  activeSessions.clear();

  await Promise.allSettled(
    sessions.map(
      async (
        session,
      ) => {
        await session.server.close();
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
      "SSE test server shutdown failed:",
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
