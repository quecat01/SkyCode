import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state =
  vi.hoisted(
    () => ({
      files:
        new Map<
          string,
          string
        >(),

      modes:
        new Map<
          string,
          number
        >(),

      promptAnswers:
        [] as Array<
          Record<
            string,
            unknown
          >
        >,

      promptCalls:
        [] as unknown[],

      forceExistsSync:
        null as
          | boolean
          | null,

      defaultsJson:
        JSON.stringify({
          apiUrl:
            "http://YOUR_LITELLM_HOST:4000/v1",

          defaultModel:
            "chatgpt-gpt-5.5",

          defaultPermissionMode:
            "default",

          mcpServers: [],

          pluginDirs: [],

          compactionThreshold:
            6000,

          compactionStrategy:
            "summarise",

          compactionWindowSize:
            20,
        }),
    }),
  );

function createEnoent(
  path: string,
): NodeJS.ErrnoException {
  const error =
    new Error(
      `ENOENT: no such file or directory, ${path}`,
    ) as NodeJS.ErrnoException;

  error.code =
    "ENOENT";

  return error;
}

vi.mock(
  "inquirer",
  () => ({
    default: {
      prompt:
        async (
          questions:
            unknown,
        ) => {
          state.promptCalls.push(
            questions,
          );

          const answer =
            state.promptAnswers
              .shift();

          if (
            !answer
          ) {
            throw new Error(
              "Test did not provide enough Inquirer answers.",
            );
          }

          return answer;
        },
    },
  }),
);

vi.mock(
  "node:os",
  async () => {
    const actual =
      await vi.importActual<
        typeof import("node:os")
      >(
        "node:os",
      );

    return {
      ...actual,

      homedir:
        () =>
          "/mock-home",
    };
  },
);

vi.mock(
  "node:fs",
  async () => {
    const actual =
      await vi.importActual<
        typeof import("node:fs")
      >(
        "node:fs",
      );

    return {
      ...actual,

      existsSync:
        (
          path:
            string |
            Buffer |
            URL,
        ): boolean => {
          if (
            state.forceExistsSync !==
            null
          ) {
            return state
              .forceExistsSync;
          }

          const filePath =
            String(
              path,
            );

          if (
            state.files.has(
              filePath,
            )
          ) {
            return true;
          }

          return actual.existsSync(
            path,
          );
        },
    };
  },
);

vi.mock(
  "node:fs/promises",
  async () => {
    const actual =
      await vi.importActual<
        typeof import(
          "node:fs/promises"
        )
      >(
        "node:fs/promises",
      );

    return {
      ...actual,

      access:
        async (
          path:
            string,
        ): Promise<void> => {
          if (
            state.files.has(
              path,
            )
          ) {
            return;
          }

          throw createEnoent(
            path,
          );
        },

      mkdir:
        async (): Promise<
          undefined
        > =>
          undefined,

      readFile:
        async (
          path:
            string,
        ): Promise<
          string
        > => {
          if (
            path.endsWith(
              "/config/defaults.json",
            )
          ) {
            return state
              .defaultsJson;
          }

          const contents =
            state.files.get(
              path,
            );

          if (
            contents ===
            undefined
          ) {
            throw createEnoent(
              path,
            );
          }

          return contents;
        },

      writeFile:
        async (
          path:
            string,
          contents:
            string,
          options?:
            {
              mode?:
                number;
            },
        ): Promise<void> => {
          state.files.set(
            path,
            String(
              contents,
            ),
          );

          if (
            typeof options
              ?.mode ===
            "number"
          ) {
            state.modes.set(
              path,
              options.mode,
            );
          }
        },

      rename:
        async (
          oldPath:
            string,
          newPath:
            string,
        ): Promise<void> => {
          const contents =
            state.files.get(
              oldPath,
            );

          if (
            contents ===
            undefined
          ) {
            throw createEnoent(
              oldPath,
            );
          }

          const mode =
            state.modes.get(
              oldPath,
            );

          state.files.set(
            newPath,
            contents,
          );

          state.files.delete(
            oldPath,
          );

          if (
            mode !==
            undefined
          ) {
            state.modes.set(
              newPath,
              mode,
            );

            state.modes.delete(
              oldPath,
            );
          }
        },

      chmod:
        async (
          path:
            string,
          mode:
            number,
        ): Promise<void> => {
          state.modes.set(
            path,
            mode,
          );
        },

      unlink:
        async (
          path:
            string,
        ): Promise<void> => {
          state.files.delete(
            path,
          );

          state.modes.delete(
            path,
          );
        },
    };
  },
);

vi.mock(
  "dotenv",
  () => ({
    config:
      (
        options?: {
          path?:
            string;
        },
      ) => {
        const filePath =
          options?.path;

        if (
          !filePath
        ) {
          return {};
        }

        const contents =
          state.files.get(
            filePath,
          );

        if (
          contents ===
          undefined
        ) {
          return {};
        }

        const parsed:
          Record<
            string,
            string
          > = {};

        for (
          const line of
          contents.split(
            /\r?\n/,
          )
        ) {
          const trimmed =
            line.trim();

          if (
            trimmed ===
              "" ||
            trimmed.startsWith(
              "#",
            )
          ) {
            continue;
          }

          const equalsIndex =
            trimmed.indexOf(
              "=",
            );

          if (
            equalsIndex <
            1
          ) {
            continue;
          }

          const key =
            trimmed
              .slice(
                0,
                equalsIndex,
              )
              .trim();

          const value =
            trimmed
              .slice(
                equalsIndex +
                  1,
              )
              .trim();

          parsed[key] =
            value;

          if (
            process.env[
              key
            ] ===
            undefined
          ) {
            process.env[
              key
            ] =
              value;
          }
        }

        return {
          parsed,
        };
      },
  }),
);

const originalApiUrl =
  process.env
    .LITELLM_API_URL;

const originalApiKey =
  process.env
    .LITELLM_API_KEY;

beforeEach(
  () => {
    vi.resetModules();

    state.files.clear();
    state.modes.clear();

    state.promptAnswers.length =
      0;

    state.promptCalls.length =
      0;

    state.forceExistsSync =
      null;

    delete process.env
      .LITELLM_API_URL;

    delete process.env
      .LITELLM_API_KEY;
  },
);

afterEach(
  () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

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
  },
);

function queueSuccessfulSetupAnswers():
  void {
  state.promptAnswers.push(
    {
      apiUrl:
        "http://litellm.test:4000/v1",
    },

    {
      apiKey:
        "temporary-test-key",
    },

    {
      selection:
        "2",
    },

    {
      selection:
        "1",
    },
  );
}

function installSuccessfulFetchMock() {
  const fetchMock =
    vi.fn(
      async () => ({
        ok:
          true,

        status:
          200,

        json:
          async () => ({
            data: [
              {
                id:
                  "model-one",
              },

              {
                id:
                  "model-two",
              },
            ],
          }),
      }),
    );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

describe(
  "Sky Code setup wizard",
  () => {
    it(
      "exits cleanly when the user declines to reconfigure an existing config",
      async () => {
        state.files.set(
          "/mock-home/.sky-code/config.json",
          JSON.stringify({
            apiUrl:
              "http://existing.test/v1",
          }),
        );

        state.promptAnswers.push(
          {
            reconfigure:
              false,
          },
        );

        const {
          runSetup,
        } =
          await import(
            "../src/setup.ts"
          );

        await expect(
          runSetup(),
        ).resolves.toBeUndefined();

        expect(
          state.files.get(
            "/mock-home/.sky-code/config.json",
          ),
        ).toContain(
          "http://existing.test/v1",
        );

        expect(
          state.files.has(
            "/mock-home/.sky-code/.env",
          ),
        ).toBe(
          false,
        );

        expect(
          state.promptCalls,
        ).toHaveLength(
          1,
        );
      },
    );

    it(
      "writes config.json with the selected setup values",
      async () => {
        queueSuccessfulSetupAnswers();

        installSuccessfulFetchMock();

        const {
          runSetup,
        } =
          await import(
            "../src/setup.ts"
          );

        await runSetup();

        const contents =
          state.files.get(
            "/mock-home/.sky-code/config.json",
          );

        expect(
          contents,
        ).toBeDefined();

        expect(
          JSON.parse(
            contents ??
              "",
          ),
        ).toEqual({
          apiUrl:
            "http://litellm.test:4000/v1",

          defaultModel:
            "model-two",

          defaultPermissionMode:
            "default",
        });

        expect(
          state.modes.get(
            "/mock-home/.sky-code/config.json",
          ),
        ).toBe(
          0o644,
        );
      },
    );

    it(
      "writes the global .env with correct content and owner-only permissions",
      async () => {
        queueSuccessfulSetupAnswers();

        installSuccessfulFetchMock();

        const {
          runSetup,
        } =
          await import(
            "../src/setup.ts"
          );

        await runSetup();

        expect(
          state.files.get(
            "/mock-home/.sky-code/.env",
          ),
        ).toBe(
          [
            "# Sky Code environment variables",
            "# Generated by sky setup",
            "",
            "LITELLM_API_URL=http://litellm.test:4000/v1",
            "LITELLM_API_KEY=temporary-test-key",
            "",
          ].join(
            "\n",
          ),
        );

        expect(
          state.modes.get(
            "/mock-home/.sky-code/.env",
          ),
        ).toBe(
          0o600,
        );
      },
    );

    it(
      "tests the configured /v1/models endpoint and uses the returned model list",
      async () => {
        queueSuccessfulSetupAnswers();

        const fetchMock =
          installSuccessfulFetchMock();

        const {
          runSetup,
        } =
          await import(
            "../src/setup.ts"
          );

        await runSetup();

        expect(
          fetchMock,
        ).toHaveBeenCalledOnce();

        expect(
          fetchMock,
        ).toHaveBeenCalledWith(
          "http://litellm.test:4000/v1/models",
          expect.objectContaining({
            method:
              "GET",

            headers: {
              Accept:
                "application/json",

              Authorization:
                "Bearer temporary-test-key",
            },
          }),
        );

        const config =
          JSON.parse(
            state.files.get(
              "/mock-home/.sky-code/config.json",
            ) ??
              "",
          );

        expect(
          config.defaultModel,
        ).toBe(
          "model-two",
        );
      },
    );

    it(
      "handles a failed connection and offers retry, skip, and exit options",
      async () => {
        state.promptAnswers.push(
          {
            apiUrl:
              "http://unreachable.test:4000/v1",
          },

          {
            apiKey:
              "temporary-test-key",
          },

          {
            action:
              "2",
          },

          {
            model:
              "manual-model",
          },

          {
            selection:
              "1",
          },
        );

        const fetchMock =
          vi.fn(
            async () => {
              throw new TypeError(
                "fetch failed",
              );
            },
          );

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const logSpy =
          vi.spyOn(
            console,
            "log",
          ).mockImplementation(
            () =>
              undefined,
          );

        const {
          runSetup,
        } =
          await import(
            "../src/setup.ts"
          );

        await runSetup();

        const output =
          logSpy.mock.calls
            .flat()
            .join(
              "\n",
            );

        expect(
          output,
        ).toContain(
          "1. Try a different URL",
        );

        expect(
          output,
        ).toContain(
          "2. Skip this check and continue anyway",
        );

        expect(
          output,
        ).toContain(
          "3. Exit setup",
        );

        const config =
          JSON.parse(
            state.files.get(
              "/mock-home/.sky-code/config.json",
            ) ??
              "",
          );

        expect(
          config.defaultModel,
        ).toBe(
          "manual-model",
        );
      },
    );

    it(
      "shows the setup instruction when Sky Code has no configuration",
      async () => {
        state.forceExistsSync =
          false;

        const originalArgv =
          [...process.argv];

        process.argv.splice(
          2,
        );

        const logSpy =
          vi.spyOn(
            console,
            "log",
          ).mockImplementation(
            () =>
              undefined,
          );

        try {
          const {
            runCli,
          } =
            await import(
              "../src/index.ts"
            );

          await expect(
            runCli(),
          ).resolves.toBeUndefined();
        } finally {
          process.argv.splice(
            0,
            process.argv.length,
            ...originalArgv,
          );
        }

        expect(
          logSpy,
        ).toHaveBeenCalledWith(
          "SkyCode is not configured yet.",
        );

        expect(
          logSpy,
        ).toHaveBeenCalledWith(
          "Run 'sky setup' to get started.",
        );
      },
    );

    it(
      "loads API environment values from ~/.sky-code/.env as a fallback",
      async () => {
        state.files.set(
          "/mock-home/.sky-code/.env",
          [
            "LITELLM_API_URL=http://global-env.test:4000/v1",
            "LITELLM_API_KEY=global-env-test-key",
            "",
          ].join(
            "\n",
          ),
        );

        const {
          loadConfig,
        } =
          await import(
            "../src/config.ts"
          );

        const config =
          await loadConfig(
            "/mock-project",
          );

        expect(
          config.apiUrl,
        ).toBe(
          "http://global-env.test:4000/v1",
        );

        expect(
          config.apiKey,
        ).toBe(
          "global-env-test-key",
        );

        expect(
          config.defaultModel,
        ).toBe(
          "chatgpt-gpt-5.5",
        );

        expect(
          config.defaultPermissionMode,
        ).toBe(
          "default",
        );
      },
    );
  },
);
