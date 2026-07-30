import {
  spawn,
  type ChildProcess,
} from "node:child_process";

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  createServer as createNetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fileURLToPath,
} from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  runSubAgentTask,
} from "../src/agents.ts";

import {
  fetchAvailableModels,
  streamChatCompletion,
} from "../src/chat.ts";

import {
  closeMcpConnections,
  connectHttpMcpServer,
  connectSseMcpServer,
  connectStdioMcpServer,
} from "../src/mcp.ts";

import {
  loadPlugins,
} from "../src/plugins.ts";
import {
  loadConfig,
  type AppConfig,
} from "../src/config.ts";
import {
  createSessionLogger,
} from "../src/session.ts";
import {
  SKY_CODE_SYSTEM_PROMPT,
} from "../src/tools.ts";

const testConfig: AppConfig = {
  apiUrl: "http://litellm.test/v1",
  apiKey: "temporary-test-key",
  defaultModel: "test-model",
  defaultPermissionMode: "default",
  compactionThreshold: 6_000,
  compactionStrategy: "summarise",
  compactionWindowSize: 20,
  mcpServers: [],
  pluginDirs: [],
};

describe("LiteLLM integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retrieves and deduplicates the live model list", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "model-one",
            },
            {
              id: "model-two",
            },
            {
              id: "model-one",
            },
            {
              invalid: true,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    });

    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    await expect(
      fetchAvailableModels(testConfig),
    ).resolves.toEqual([
      "model-one",
      "model-two",
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();

    const requestUrl =
      fetchMock.mock.calls[0]?.[0];

    const requestOptions =
      fetchMock.mock.calls[0]?.[1];

    expect(requestUrl).toBe(
      "http://litellm.test/v1/models",
    );

    expect(requestOptions).toMatchObject({
      method: "GET",
      headers: {
        Authorization:
          "Bearer temporary-test-key",
        Accept: "application/json",
      },
    });
  });

  it("parses a streaming chat response and sends the system prompt", async () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Sky "}}]}\n\n',
          ),
        );

        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Code"}}]}\n\n',
          ),
        );

        controller.enqueue(
          encoder.encode(
            "data: [DONE]\n\n",
          ),
        );

        controller.close();
      },
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        stream,
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/event-stream",
          },
        },
      );
    });

    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    const streamedParts: string[] = [];

    const result =
      await streamChatCompletion(
        testConfig,
        "test-model",
        [
          {
            role: "user",
            content: "Say the name.",
          },
        ],
        (content) => {
          streamedParts.push(content);
        },
      );

    expect(result).toBe(
      "Sky Code",
    );

    expect(streamedParts).toEqual([
      "Sky ",
      "Code",
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();

    const requestOptions =
      fetchMock.mock.calls[0]?.[1];

    expect(requestOptions?.method).toBe(
      "POST",
    );

    const requestBody = JSON.parse(
      String(requestOptions?.body),
    );

    expect(requestBody.model).toBe(
      "test-model",
    );

    expect(requestBody.stream).toBe(
      true,
    );

    expect(requestBody.messages[0]).toEqual({
      role: "system",
      content:
        SKY_CODE_SYSTEM_PROMPT,
    });

    expect(requestBody.messages[1]).toEqual({
      role: "user",
      content: "Say the name.",
    });
  });
});

describe("Configuration integration", () => {
  let testDirectory: string;
  let originalApiUrl: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(async () => {
    testDirectory = await mkdtemp(
      join(
        tmpdir(),
        "sky-code-config-integration-",
      ),
    );

    originalApiUrl =
      process.env.LITELLM_API_URL;

    originalApiKey =
      process.env.LITELLM_API_KEY;
  });

  afterEach(async () => {
    if (originalApiUrl === undefined) {
      delete process.env.LITELLM_API_URL;
    } else {
      process.env.LITELLM_API_URL =
        originalApiUrl;
    }

    if (originalApiKey === undefined) {
      delete process.env.LITELLM_API_KEY;
    } else {
      process.env.LITELLM_API_KEY =
        originalApiKey;
    }

    await rm(
      testDirectory,
      {
        recursive: true,
        force: true,
      },
    );
  });

  it("applies environment values over project configuration", async () => {
    const projectConfigDirectory =
      join(
        testDirectory,
        ".sky-code",
      );

    await mkdir(
      projectConfigDirectory,
      {
        recursive: true,
      },
    );

    await writeFile(
      join(
        projectConfigDirectory,
        "config.json",
      ),
      JSON.stringify(
        {
          apiUrl:
            "http://project.test/v1",
          defaultModel:
            "project-model",
          defaultPermissionMode:
            "default",
          mcpServers: [
            {
              name:
                "test-stdio-server",
              transport:
                "stdio",
              command:
                "node",
              args: [
                "test-server.js",
              ],
              cwd:
                "/tmp",
              env: {
                TEST_VALUE:
                  "enabled",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.LITELLM_API_URL =
      "http://environment.test/v1";

    process.env.LITELLM_API_KEY =
      "environment-key";

    const config =
      await loadConfig(
        testDirectory,
      );

    expect(config).toEqual({
      apiUrl:
        "http://environment.test/v1",
      apiKey:
        "environment-key",
      defaultModel:
        "project-model",
      defaultPermissionMode:
        "default",
      compactionThreshold:
        6_000,
      compactionStrategy:
        "summarise",
      compactionWindowSize:
        20,
      mcpServers: [
        {
          name:
            "test-stdio-server",
          transport:
            "stdio",
          command:
            "node",
          args: [
            "test-server.js",
          ],
          cwd:
            "/tmp",
          env: {
            TEST_VALUE:
              "enabled",
          },
        },
      ],
      pluginDirs: [],
    });
  });
});

describe("Session logging integration", () => {
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(
      join(
        tmpdir(),
        "sky-code-session-integration-",
      ),
    );
  });

  afterEach(async () => {
    await rm(
      testDirectory,
      {
        recursive: true,
        force: true,
      },
    );
  });

  it("writes an append-only JSONL session with private permissions", async () => {
    const logger =
      await createSessionLogger(
        testDirectory,
      );

    await logger.append({
      type: "session_start",
      model: "test-model",
    });

    await logger.append({
      type: "message",
      role: "user",
      content: "Hello",
      model: "test-model",
    });

    await logger.append({
      type: "session_end",
      model: "test-model",
    });

    const contents =
      await readFile(
        logger.filePath,
        "utf8",
      );

    const records = contents
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(line),
      );

    expect(records).toHaveLength(3);

    expect(
      records.map(
        (record) => record.type,
      ),
    ).toEqual([
      "session_start",
      "message",
      "session_end",
    ]);

    expect(
      records.every(
        (record) =>
          record.sessionId ===
          logger.sessionId,
      ),
    ).toBe(true);

    const details =
      await stat(
        logger.filePath,
      );

    expect(
      details.mode & 0o777,
    ).toBe(0o600);
  });
});

interface RunningFixture {
  process:
    ChildProcess;

  getStderr():
    string;
}

async function reserveLocalPort():
  Promise<number> {
  const server =
    createNetServer();

  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      server.once(
        "error",
        reject,
      );

      server.listen(
        0,
        "127.0.0.1",
        () => {
          server.off(
            "error",
            reject,
          );

          resolve();
        },
      );
    },
  );

  const address =
    server.address();

  if (
    address ===
      null ||
    typeof address ===
      "string"
  ) {
    server.close();

    throw new Error(
      "Unable to reserve a local TCP port",
    );
  }

  const port =
    address.port;

  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      server.close(
        (
          error,
        ) => {
          if (error) {
            reject(
              error,
            );

            return;
          }

          resolve();
        },
      );
    },
  );

  return port;
}

async function startNetworkFixture(
  fixtureName:
    string,
  port:
    number,
  environment:
    Record<string, string> = {},
): Promise<RunningFixture> {
  const fixturePath =
    fileURLToPath(
      new URL(
        `./fixtures/${fixtureName}`,
        import.meta.url,
      ),
    );

  const fixtureProcess =
    spawn(
      process.execPath,
      [
        fixturePath,
        String(
          port,
        ),
      ],
      {
        env: {
          ...process.env,
          ...environment,
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

  let stderrOutput =
    "";

  fixtureProcess.stderr?.on(
    "data",
    (
      chunk,
    ) => {
      stderrOutput +=
        chunk.toString(
          "utf8",
        );
    },
  );

  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      let stdoutOutput =
        "";

      const timeout =
        setTimeout(
          () => {
            cleanup();

            reject(
              new Error(
                `Fixture ${fixtureName} did not become ready. Stderr: ${stderrOutput}`,
              ),
            );
          },
          5000,
        );

      function cleanup():
        void {
        clearTimeout(
          timeout,
        );

        fixtureProcess.stdout?.off(
          "data",
          handleData,
        );

        fixtureProcess.off(
          "error",
          handleError,
        );

        fixtureProcess.off(
          "exit",
          handleExit,
        );
      }

      function handleData(
        chunk:
          Buffer,
      ): void {
        stdoutOutput +=
          chunk.toString(
            "utf8",
          );

        if (
          stdoutOutput.includes(
            `READY ${port}`,
          )
        ) {
          cleanup();
          resolve();
        }
      }

      function handleError(
        error:
          Error,
      ): void {
        cleanup();
        reject(
          error,
        );
      }

      function handleExit(
        code:
          number | null,
        signal:
          NodeJS.Signals | null,
      ): void {
        cleanup();

        reject(
          new Error(
            `Fixture ${fixtureName} exited before becoming ready with code ${code ?? "null"} and signal ${signal ?? "none"}. Stderr: ${stderrOutput}`,
          ),
        );
      }

      fixtureProcess.stdout?.on(
        "data",
        handleData,
      );

      fixtureProcess.once(
        "error",
        handleError,
      );

      fixtureProcess.once(
        "exit",
        handleExit,
      );
    },
  );

  return {
    process:
      fixtureProcess,

    getStderr() {
      return stderrOutput;
    },
  };
}

async function stopFixture(
  fixture:
    RunningFixture,
): Promise<void> {
  if (
    fixture.process.exitCode !==
      null ||
    fixture.process.signalCode !==
      null
  ) {
    return;
  }

  await new Promise<void>(
    (
      resolve,
    ) => {
      let finished =
        false;

      const forceTimeout =
        setTimeout(
          () => {
            if (
              fixture.process.exitCode ===
                null &&
              fixture.process.signalCode ===
                null
            ) {
              fixture.process.kill(
                "SIGKILL",
              );
            }
          },
          2000,
        );

      const completionTimeout =
        setTimeout(
          () => {
            finish();
          },
          4000,
        );

      function finish():
        void {
        if (finished) {
          return;
        }

        finished =
          true;

        clearTimeout(
          forceTimeout,
        );

        clearTimeout(
          completionTimeout,
        );

        resolve();
      }

      fixture.process.once(
        "exit",
        finish,
      );

      fixture.process.kill(
        "SIGTERM",
      );
    },
  );
}

describe(
  "Phase 2 integration",
  () => {
    it(
      "connects and calls tools through stdio, SSE, and Streamable HTTP MCP transports",
      async () => {
        const headerValue =
          "phase2-integration";

        const ssePort =
          await reserveLocalPort();

        const httpPort =
          await reserveLocalPort();

        const sseFixture =
          await startNetworkFixture(
            "mcp-sse-test-server.mjs",
            ssePort,
            {
              SKY_CODE_TEST_HEADER:
                headerValue,
            },
          );

        const httpFixture =
          await startNetworkFixture(
            "mcp-http-test-server.mjs",
            httpPort,
            {
              SKY_CODE_TEST_HEADER:
                headerValue,
            },
          );

        const connections =
          [];

        try {
          connections.push(
            await connectStdioMcpServer({
              name:
                "integration-stdio",
              transport:
                "stdio",
              command:
                process.execPath,
              args: [
                fileURLToPath(
                  new URL(
                    "./fixtures/mcp-stdio-test-server.mjs",
                    import.meta.url,
                  ),
                ),
              ],
            }),
          );

          connections.push(
            await connectSseMcpServer({
              name:
                "integration-sse",
              transport:
                "sse",
              url:
                `http://127.0.0.1:${ssePort}/sse`,
              headers: {
                "x-sky-code-test":
                  headerValue,
              },
            }),
          );

          connections.push(
            await connectHttpMcpServer({
              name:
                "integration-http",
              transport:
                "http",
              url:
                `http://127.0.0.1:${httpPort}/mcp`,
              headers: {
                "x-sky-code-test":
                  headerValue,
              },
            }),
          );

          const stdioTools =
            await connections[0]
              ?.listTools();

          const sseTools =
            await connections[1]
              ?.listTools();

          const httpTools =
            await connections[2]
              ?.listTools();

          expect(
            stdioTools?.map(
              (
                tool,
              ) =>
                tool.name,
            ),
          ).toContain(
            "phase2_ping",
          );

          expect(
            sseTools?.map(
              (
                tool,
              ) =>
                tool.name,
            ),
          ).toContain(
            "phase2_sse_ping",
          );

          expect(
            httpTools?.map(
              (
                tool,
              ) =>
                tool.name,
            ),
          ).toContain(
            "phase2_http_ping",
          );

          await expect(
            connections[0]
              ?.callTool(
                "phase2_ping",
              ),
          ).resolves.toMatchObject({
            success:
              true,
            output:
              "Sky Code MCP stdio connection works.",
          });

          await expect(
            connections[1]
              ?.callTool(
                "phase2_sse_ping",
              ),
          ).resolves.toMatchObject({
            success:
              true,
            output:
              "Sky Code MCP SSE connection works.",
          });

          await expect(
            connections[2]
              ?.callTool(
                "phase2_http_ping",
              ),
          ).resolves.toMatchObject({
            success:
              true,
            output:
              "Sky Code MCP Streamable HTTP connection works.",
          });
        } finally {
          await closeMcpConnections(
            connections,
          );

          await stopFixture(
            sseFixture,
          );

          await stopFixture(
            httpFixture,
          );
        }

        expect(
          sseFixture.getStderr(),
        ).toContain(
          "SSE GET header accepted.",
        );

        expect(
          sseFixture.getStderr(),
        ).toContain(
          "SSE POST header accepted.",
        );

        expect(
          httpFixture.getStderr(),
        ).toContain(
          "HTTP session initialized.",
        );

        expect(
          httpFixture.getStderr(),
        ).toContain(
          "HTTP session closed.",
        );
      },
      20_000,
    );

    it(
      "loads a complete project plugin manifest from disk",
      async () => {
        const rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-phase2-plugin-integration-",
            ),
          );

        const projectDirectory =
          join(
            rootDirectory,
            "project",
          );

        const homeDirectory =
          join(
            rootDirectory,
            "home",
          );

        const pluginDirectory =
          join(
            projectDirectory,
            ".sky-code-plugin",
          );

        try {
          await mkdir(
            pluginDirectory,
            {
              recursive:
                true,
            },
          );

          await mkdir(
            homeDirectory,
            {
              recursive:
                true,
            },
          );

          await writeFile(
            join(
              pluginDirectory,
              "plugin.json",
            ),
            JSON.stringify(
              {
                name:
                  "phase2-integration-plugin",
                version:
                  "1.0.0",
                description:
                  "A complete Phase 2 integration plugin.",
                skills: [
                  {
                    name:
                      "phase2-review",
                    description:
                      "Review a Phase 2 task.",
                    prompt:
                      "Review the supplied Phase 2 task.",
                    command:
                      "/phase2-review",
                  },
                ],
                agents: [
                  {
                    name:
                      "phase2-agent",
                    description:
                      "Handles a delegated Phase 2 task.",
                    systemPrompt:
                      "Complete the delegated Phase 2 task.",
                  },
                ],
                hooks: [],
                mcpServers: [
                  {
                    name:
                      "phase2-plugin-stdio",
                    transport:
                      "stdio",
                    command:
                      process.execPath,
                    args: [
                      fileURLToPath(
                        new URL(
                          "./fixtures/mcp-stdio-test-server.mjs",
                          import.meta.url,
                        ),
                      ),
                    ],
                  },
                ],
              },
              null,
              2,
            ),
            "utf8",
          );

          const plugins =
            await loadPlugins({
              projectDirectory,
              homeDirectory,
              pluginDirs:
                [],
            });

          expect(
            plugins,
          ).toHaveLength(
            1,
          );

          expect(
            plugins[0],
          ).toMatchObject({
            name:
              "phase2-integration-plugin",
            version:
              "1.0.0",
            description:
              "A complete Phase 2 integration plugin.",
            source:
              "project",
            skills: [
              {
                name:
                  "phase2-review",
                command:
                  "/phase2-review",
              },
            ],
            agents: [
              {
                name:
                  "phase2-agent",
              },
            ],
            mcpServers: [
              {
                name:
                  "phase2-plugin-stdio",
                transport:
                  "stdio",
              },
            ],
          });
        } finally {
          await rm(
            rootDirectory,
            {
              recursive:
                true,
              force:
                true,
            },
          );
        }
      },
    );

    it(
      "spawns a sub-agent worker and receives its IPC result",
      async () => {
        const result =
          await runSubAgentTask(
            {
              name:
                "phase2-integration-agent",
              description:
                "A deterministic integration-test agent.",
              systemPrompt:
                "Complete the integration test task.",
              model:
                "phase2-agent-model",
            },
            {
              task:
                "Verify sub-agent IPC.",
              context:
                "Return the delegated values.",
            },
            {
              apiUrl:
                "http://litellm.test/v1",
              apiKey:
                "integration-test-key",
              defaultModel:
                "default-integration-model",
            },
            {
              workerPath:
                fileURLToPath(
                  new URL(
                    "./fixtures/agent-test-worker.mjs",
                    import.meta.url,
                  ),
                ),
              timeoutMs:
                5000,
            },
          );

        expect(
          result.workerPid,
        ).not.toBe(
          process.pid,
        );

        expect(
          result.model,
        ).toBe(
          "phase2-agent-model",
        );

        expect(
          JSON.parse(
            result.output,
          ),
        ).toEqual({
          agentName:
            "phase2-integration-agent",
          description:
            "A deterministic integration-test agent.",
          systemPrompt:
            "Complete the integration test task.",
          model:
            "phase2-agent-model",
          task:
            "Verify sub-agent IPC.",
          context:
            "Return the delegated values.",
        });
      },
    );
  },
);

describe(
  "Phase 3 integration",
  () => {
    it(
      "persists, searches, and resumes a directory-specific session",
      async () => {
        const rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-phase3-session-integration-",
            ),
          );

        try {
          const projectDirectory =
            join(
              rootDirectory,
              "project",
            );

          const sessionDirectory =
            join(
              rootDirectory,
              "sessions",
            );

          await mkdir(
            projectDirectory,
            {
              recursive:
                true,
            },
          );

          const {
            createSessionLogger:
              createPhase3SessionLogger,
          } =
            await import(
              "../src/session.ts"
            );

          const {
            searchSessionHistory,
          } =
            await import(
              "../src/history.ts"
            );

          const {
            findLatestResumableSession,
          } =
            await import(
              "../src/session-resume.ts"
            );

          const logger =
            await createPhase3SessionLogger(
              sessionDirectory,
            );

          await logger.append({
            type:
              "session_start",

            workingDirectory:
              projectDirectory,

            model:
              "phase3-model",
          });

          await logger.append({
            type:
              "message",

            role:
              "user",

            content:
              "Remember the Phase 3 codeword ORANGE-728.",

            model:
              "phase3-model",
          });

          await logger.append({
            type:
              "message",

            role:
              "assistant",

            content:
              "The codeword is ORANGE-728.",

            model:
              "phase3-model",
          });

          await logger.append({
            type:
              "session_end",

            model:
              "phase3-model",
          });

          const matches =
            await searchSessionHistory(
              logger.filePath,
              "orange-728",
            );

          expect(
            matches.map(
              (
                match,
              ) =>
                match.role,
            ),
          ).toEqual([
            "user",
            "assistant",
          ]);

          const resumable =
            await findLatestResumableSession(
              projectDirectory,
              sessionDirectory,
            );

          expect(
            resumable,
          ).not.toBeNull();

          expect(
            resumable?.model,
          ).toBe(
            "phase3-model",
          );

          expect(
            resumable?.messages,
          ).toEqual([
            {
              role:
                "user",

              content:
                "Remember the Phase 3 codeword ORANGE-728.",
            },
            {
              role:
                "assistant",

              content:
                "The codeword is ORANGE-728.",
            },
          ]);
        } finally {
          await rm(
            rootDirectory,
            {
              recursive:
                true,

              force:
                true,
            },
          );
        }
      },
    );

    it(
      "adds and activates catalog commands and skills without restarting",
      async () => {
        const rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-phase3-catalog-integration-",
            ),
          );

        try {
          const projectDirectory =
            join(
              rootDirectory,
              "project",
            );

          const catalogDirectory =
            join(
              rootDirectory,
              "catalog",
            );

          await mkdir(
            projectDirectory,
            {
              recursive:
                true,
            },
          );

          await writeFile(
            join(
              projectDirectory,
              "phase3-review.json",
            ),
            JSON.stringify(
              {
                type:
                  "command",

                name:
                  "/phase3-review",

                description:
                  "Review a Phase 3 file",

                prompt:
                  "Review {{file}} carefully.",
              },
              null,
              2,
            ),
            "utf8",
          );

          await writeFile(
            join(
              projectDirectory,
              "phase3-careful.json",
            ),
            JSON.stringify(
              {
                type:
                  "skill",

                name:
                  "phase3-careful",

                description:
                  "Apply careful Phase 3 reasoning",

                systemPromptAddition:
                  "Verify every Phase 3 conclusion.",
              },
              null,
              2,
            ),
            "utf8",
          );

          const {
            loadCatalog,
          } =
            await import(
              "../src/catalog.ts"
            );

          const {
            CatalogManager,
          } =
            await import(
              "../src/catalog-management.ts"
            );

          const {
            resolveCatalogCommand,
          } =
            await import(
              "../src/catalog-runtime.ts"
            );

          const {
            createSkyCodeSystemPrompt,
          } =
            await import(
              "../src/tools.ts"
            );

          const catalog =
            await loadCatalog({
              catalogDirectory,
            });

          const manager =
            new CatalogManager({
              catalog,

              workingDirectory:
                projectDirectory,
            });

          await manager.execute({
            action:
              "add",

            file:
              "./phase3-review.json",
          });

          await manager.execute({
            action:
              "add",

            file:
              "./phase3-careful.json",
          });

          const enabled =
            await manager.execute({
              action:
                "enable",

              name:
                "phase3-careful",
            });

          const resolved =
            resolveCatalogCommand(
              "/phase3-review src/index.ts",
              enabled.catalog.commands,
            );

          expect(
            resolved,
          ).toMatchObject({
            kind:
              "prompt",

            conversationInput:
              "Review src/index.ts carefully.",
          });

          const systemPrompt =
            createSkyCodeSystemPrompt(
              [],
              [],
              [],
              enabled.activeSkills,
            );

          expect(
            systemPrompt,
          ).toContain(
            "Verify every Phase 3 conclusion.",
          );
        } finally {
          await rm(
            rootDirectory,
            {
              recursive:
                true,

              force:
                true,
            },
          );
        }
      },
    );

    it(
      "passes startup health failures through clean credential-safe reporting",
      async () => {
        const {
          runStartupHealthCheck,
        } =
          await import(
            "../src/startup-health.ts"
          );

        const {
          formatCliErrorReport,
        } =
          await import(
            "../src/error-reporting.ts"
          );

        const secretKey =
          "phase3-integration-secret";

        let startupError:
          unknown;

        try {
          await runStartupHealthCheck(
            {
              ...testConfig,

              apiUrl:
                "http://phase3-unreachable.test/v1",

              apiKey:
                secretKey,
            },
            async () => {
              throw new TypeError(
                `fetch failed with Bearer ${secretKey}`,
              );
            },
          );
        } catch (error) {
          startupError =
            error;
        }

        expect(
          startupError,
        ).toBeDefined();

        const report =
          formatCliErrorReport(
            startupError,
            {
              operation:
                "Sky Code startup",
            },
          );

        expect(
          report[0],
        ).toBe(
          "Sky Code startup failed.",
        );

        expect(
          report.join(
            "\n",
          ),
        ).toContain(
          "could not reach LiteLLM",
        );

        expect(
          report.join(
            "\n",
          ),
        ).not.toContain(
          secretKey,
        );
      },
    );
  },
);
