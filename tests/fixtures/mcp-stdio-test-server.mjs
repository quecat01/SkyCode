#!/usr/bin/env node

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  StdioServerTransport,
} from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "sky-code-phase2-stdio-test",
  version: "1.0.0",
});

server.registerTool(
  "phase2_ping",
  {
    description:
      "Return a fixed response confirming that MCP stdio communication works.",
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text:
            "Sky Code MCP stdio connection works.",
        },
      ],
    };
  },
);

async function main() {
  const transport =
    new StdioServerTransport();

  await server.connect(
    transport,
  );

  console.error(
    "Sky Code Phase 2 MCP test server started.",
  );
}

main().catch((error) => {
  console.error(
    "MCP test server failed:",
    error,
  );

  process.exit(1);
});
