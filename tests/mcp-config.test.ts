import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  loadConfig,
} from "../src/config.ts";

describe(
  "MCP SSE configuration",
  () => {
    let testDirectory:
      string;

    let originalApiUrl:
      string | undefined;

    let originalApiKey:
      string | undefined;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-sse-config-",
            ),
          );

        originalApiUrl =
          process.env
            .LITELLM_API_URL;

        originalApiKey =
          process.env
            .LITELLM_API_KEY;

        process.env
          .LITELLM_API_URL =
          "http://litellm.test/v1";

        process.env
          .LITELLM_API_KEY =
          "temporary-test-key";
      },
    );

    afterEach(
      async () => {
        if (
          originalApiUrl ===
          undefined
        ) {
          delete process.env
            .LITELLM_API_URL;
        } else {
          process.env
            .LITELLM_API_URL =
            originalApiUrl;
        }

        if (
          originalApiKey ===
          undefined
        ) {
          delete process.env
            .LITELLM_API_KEY;
        } else {
          process.env
            .LITELLM_API_KEY =
            originalApiKey;
        }

        await rm(
          testDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      },
    );

    async function writeProjectConfig(
      value: unknown,
    ): Promise<void> {
      const configDirectory =
        join(
          testDirectory,
          ".sky-code",
        );

      await mkdir(
        configDirectory,
        {
          recursive: true,
        },
      );

      await writeFile(
        join(
          configDirectory,
          "config.json",
        ),
        JSON.stringify(
          value,
          null,
          2,
        ),
        "utf8",
      );
    }

    it(
      "loads an SSE server with optional headers",
      async () => {
        await writeProjectConfig({
          mcpServers: [
            {
              name:
                "test-sse-server",
              transport:
                "sse",
              url:
                "http://127.0.0.1:3000/sse",
              headers: {
                Authorization:
                  "Bearer test-token",
              },
            },
          ],
        });

        const config =
          await loadConfig(
            testDirectory,
          );

        expect(
          config.mcpServers,
        ).toEqual([
          {
            name:
              "test-sse-server",
            transport:
              "sse",
            url:
              "http://127.0.0.1:3000/sse",
            headers: {
              Authorization:
                "Bearer test-token",
            },
          },
        ]);
      },
    );

    it(
      "loads a Streamable HTTP server with optional headers",
      async () => {
        await writeProjectConfig({
          mcpServers: [
            {
              name:
                "test-http-server",
              transport:
                "http",
              url:
                "http://127.0.0.1:3000/mcp",
              headers: {
                Authorization:
                  "Bearer test-token",
              },
            },
          ],
        });

        const config =
          await loadConfig(
            testDirectory,
          );

        expect(
          config.mcpServers,
        ).toEqual([
          {
            name:
              "test-http-server",
            transport:
              "http",
            url:
              "http://127.0.0.1:3000/mcp",
            headers: {
              Authorization:
                "Bearer test-token",
            },
          },
        ]);
      },
    );

    it(
      "rejects WebSocket URLs for Streamable HTTP servers",
      async () => {
        await writeProjectConfig({
          mcpServers: [
            {
              name:
                "invalid-http-server",
              transport:
                "http",
              url:
                "wss://example.test/mcp",
            },
          ],
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          "does not support WebSocket URLs",
        );
      },
    );

    it(
      "rejects WebSocket URLs for SSE servers",
      async () => {
        await writeProjectConfig({
          mcpServers: [
            {
              name:
                "invalid-sse-server",
              transport:
                "sse",
              url:
                "wss://example.test/mcp",
            },
          ],
        });

        await expect(
          loadConfig(
            testDirectory,
          ),
        ).rejects.toThrow(
          "does not support WebSocket URLs",
        );
      },
    );
  },
);
