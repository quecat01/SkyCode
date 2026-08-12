import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  DiagnosticResult,
} from "../src/diagnose.ts";

/**
 * Shared mocked filesystem state used by diagnostics tests.
 *
 * The real config.ts module remains active. Only its filesystem and environment
 * inputs are controlled so these tests exercise the same loadConfig() behavior
 * used in production.
 */
const state =
  vi.hoisted(
    () => ({
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

      configFile:
        JSON.stringify({
          defaultModel:
            "model-two",
        }) as
          | string
          | null,

      sessionsExist:
        true,

      sessionsWritable:
        true,

      sessionsIsDirectory:
        true,
    }),
  );

/**
 * Creates a Node-style filesystem error with a specific error code.
 *
 * @param {string} code - Node filesystem error code such as ENOENT or EACCES.
 * @param {string} path - Path associated with the simulated failure.
 * @returns {NodeJS.ErrnoException} Error carrying the requested filesystem code.
 * @throws {never} This helper does not intentionally throw.
 *
 * Side effects: none.
 */
function createFsError(
  code: string,
  path: string,
): NodeJS.ErrnoException {
  const error =
    new Error(
      `${code}: simulated filesystem error, ${path}`,
    ) as NodeJS.ErrnoException;

  error.code =
    code;

  return error;
}

/**
 * Returns one diagnostic result by its report label.
 *
 * Tests fail immediately if the expected diagnostic check is absent so later
 * assertions cannot silently operate on undefined values.
 *
 * @param {DiagnosticResult[]} results - Results returned by runDiagnostics().
 * @param {string} label - Diagnostic label to locate.
 * @returns {DiagnosticResult} Matching diagnostic result.
 * @throws {Error} If the requested diagnostic label is absent.
 *
 * Side effects: none.
 */
function getResult(
  results:
    DiagnosticResult[],
  label:
    string,
): DiagnosticResult {
  const result =
    results.find(
      (
        item,
      ) =>
        item.label ===
        label,
    );

  if (!result) {
    throw new Error(
      `Missing diagnostic result: ${label}`,
    );
  }

  return result;
}

/**
 * Installs a successful or HTTP-error model-list fetch response.
 *
 * The returned object exposes only the Fetch Response members consumed by
 * diagnose.ts: status, statusText, and json().
 *
 * @param {string[]} models - Model IDs returned through the response body.
 * @param {number} status - HTTP status code. Defaults to 200.
 * @param {string} statusText - HTTP status text. Defaults to "OK".
 * @returns {ReturnType<typeof vi.fn>} Installed fetch mock.
 * @throws {never} This helper does not intentionally throw.
 *
 * Side effect: replaces global fetch for the current test.
 */
function installModelFetch(
  models:
    string[],
  status:
    number = 200,
  statusText:
    string = "OK",
) {
  const fetchMock =
    vi.fn(
      async () => ({
        status,
        statusText,

        json:
          async () => ({
            data:
              models.map(
                (
                  id,
                ) => ({
                  id,
                }),
              ),
          }),
      }),
    );

  vi.stubGlobal(
    "fetch",
    fetchMock,
  );

  return fetchMock;
}

/*
 * Do not allow repository or user .env files to influence diagnostics tests.
 * Environment values are assigned explicitly in beforeEach().
 */
vi.mock(
  "dotenv",
  () => ({
    config:
      () => ({}),
  }),
);

/*
 * Force every home-directory lookup through a deterministic mock path so no
 * test reads or modifies the real user's ~/.sky-code directory.
 */
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

/*
 * Mock only the filesystem operations used by config.ts and diagnose.ts.
 * Production configuration parsing remains real.
 */
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

      readFile:
        async (
          path:
            string |
            Buffer |
            URL,
        ): Promise<string> => {
          const filePath =
            String(
              path,
            );

          if (
            filePath.endsWith(
              "/config/defaults.json",
            )
          ) {
            return state
              .defaultsJson;
          }

          if (
            filePath ===
            "/mock-home/.sky-code/config.json"
          ) {
            if (
              state.configFile ===
              null
            ) {
              throw createFsError(
                "ENOENT",
                filePath,
              );
            }

            return state
              .configFile;
          }

          /*
           * The project-level config is deliberately absent unless a test
           * explicitly models it through another mechanism.
           */
          throw createFsError(
            "ENOENT",
            filePath,
          );
        },

      stat:
        async (
          path:
            string |
            Buffer |
            URL,
        ) => {
          const filePath =
            String(
              path,
            );

          if (
            filePath !==
            "/mock-home/.sky-code/sessions"
          ) {
            throw createFsError(
              "ENOENT",
              filePath,
            );
          }

          if (
            !state.sessionsExist
          ) {
            throw createFsError(
              "ENOENT",
              filePath,
            );
          }

          return {
            isDirectory:
              () =>
                state
                  .sessionsIsDirectory,
          };
        },

      access:
        async (
          path:
            string |
            Buffer |
            URL,
        ): Promise<void> => {
          const filePath =
            String(
              path,
            );

          if (
            filePath !==
            "/mock-home/.sky-code/sessions"
          ) {
            throw createFsError(
              "ENOENT",
              filePath,
            );
          }

          if (
            !state.sessionsExist
          ) {
            throw createFsError(
              "ENOENT",
              filePath,
            );
          }

          if (
            !state.sessionsWritable
          ) {
            throw createFsError(
              "EACCES",
              filePath,
            );
          }
        },
    };
  },
);

/** Original API URL restored after every diagnostics test. */
const originalApiUrl =
  process.env
    .LITELLM_API_URL;

/** Original API key restored after every diagnostics test. */
const originalApiKey =
  process.env
    .LITELLM_API_KEY;

beforeEach(
  () => {
    /*
     * Reset module instances so config.ts starts each test with only the
     * explicitly prepared environment and mocked filesystem state.
     */
    vi.resetModules();

    state.configFile =
      JSON.stringify({
        defaultModel:
          "model-two",
      });

    state.sessionsExist =
      true;

    state.sessionsWritable =
      true;

    state.sessionsIsDirectory =
      true;

    process.env
      .LITELLM_API_URL =
      "http://litellm.test:4000/v1";

    process.env
      .LITELLM_API_KEY =
      "temporary-test-key";
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

describe(
  "SkyCode diagnostics",
  () => {
    it(
      "passes all ten checks with a healthy configuration and model endpoint",
      async () => {
        const fetchMock =
          installModelFetch([
            "model-one",
            "model-two",
          ]);

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          results,
        ).toHaveLength(
          10,
        );

        expect(
          results.map(
            (
              result,
            ) =>
              result.status,
          ),
        ).toEqual(
          Array(10).fill(
            "pass",
          ),
        );

        expect(
          getResult(
            results,
            "Default model",
          ).detail,
        ).toContain(
          "model-two",
        );

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
              Authorization:
                "Bearer temporary-test-key",

              Accept:
                "application/json",
            },
          }),
        );
      },
    );

    it(
      "fails the API URL check and skips checks 4 through 8 when LITELLM_API_URL is not set",
      async () => {
        delete process.env
          .LITELLM_API_URL;

        const fetchMock =
          vi.fn();

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "LITELLM_API_URL",
          ).status,
        ).toBe(
          "fail",
        );

        for (
          const label of [
            "URL format",
            "LiteLLM reachable",
            "Authentication",
            "Models available",
            "Default model",
          ]
        ) {
          expect(
            getResult(
              results,
              label,
            ).status,
          ).toBe(
            "skip",
          );
        }

        expect(
          fetchMock,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "fails the API key check and skips network checks when LITELLM_API_KEY is not set",
      async () => {
        delete process.env
          .LITELLM_API_KEY;

        const fetchMock =
          vi.fn();

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "LITELLM_API_KEY",
          ).status,
        ).toBe(
          "fail",
        );

        for (
          const label of [
            "LiteLLM reachable",
            "Authentication",
            "Models available",
            "Default model",
          ]
        ) {
          expect(
            getResult(
              results,
              label,
            ).status,
          ).toBe(
            "skip",
          );
        }

        expect(
          fetchMock,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "fails URL validation and skips network checks for an invalid URL",
      async () => {
        process.env
          .LITELLM_API_URL =
          "not-a-valid-url";

        const fetchMock =
          vi.fn();

        vi.stubGlobal(
          "fetch",
          fetchMock,
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "URL format",
          ).status,
        ).toBe(
          "fail",
        );

        for (
          const label of [
            "LiteLLM reachable",
            "Authentication",
            "Models available",
            "Default model",
          ]
        ) {
          expect(
            getResult(
              results,
              label,
            ).status,
          ).toBe(
            "skip",
          );
        }

        expect(
          fetchMock,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      "fails reachability and skips dependent checks when LiteLLM refuses the connection",
      async () => {
        const connectionError =
          new TypeError(
            "fetch failed",
          ) as TypeError & {
            cause?:
              unknown;
          };

        connectionError.cause = {
          code:
            "ECONNREFUSED",
        };

        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () => {
              throw connectionError;
            },
          ),
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "LiteLLM reachable",
          ),
        ).toMatchObject({
          status:
            "fail",

          detail:
            "connection refused",
        });

        for (
          const label of [
            "Authentication",
            "Models available",
            "Default model",
          ]
        ) {
          expect(
            getResult(
              results,
              label,
            ).status,
          ).toBe(
            "skip",
          );
        }
      },
    );

    it(
      "fails authentication and skips model checks when LiteLLM returns 401",
      async () => {
        installModelFetch(
          [],
          401,
          "Unauthorized",
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "LiteLLM reachable",
          ).status,
        ).toBe(
          "pass",
        );

        expect(
          getResult(
            results,
            "Authentication",
          ).status,
        ).toBe(
          "fail",
        );

        expect(
          getResult(
            results,
            "Models available",
          ).status,
        ).toBe(
          "skip",
        );

        expect(
          getResult(
            results,
            "Default model",
          ).status,
        ).toBe(
          "skip",
        );
      },
    );

    it(
      "fails model availability and skips the default model check for an empty model list",
      async () => {
        installModelFetch(
          [],
        );

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "Models available",
          ),
        ).toMatchObject({
          status:
            "fail",

          detail:
            "0 models",
        });

        expect(
          getResult(
            results,
            "Default model",
          ).status,
        ).toBe(
          "skip",
        );
      },
    );

    it(
      "fails the default model check when the configured model is not available",
      async () => {
        state.configFile =
          JSON.stringify({
            defaultModel:
              "missing-model",
          });

        installModelFetch([
          "model-one",
          "model-two",
        ]);

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "Default model",
          ),
        ).toMatchObject({
          status:
            "fail",

          detail:
            "missing-model  ✗ not in model list",
        });
      },
    );

    it(
      "reports a missing config file as a non-failing warning",
      async () => {
        state.configFile =
          null;

        installModelFetch([
          "chatgpt-gpt-5.5",
        ]);

        const {
          formatDiagnostics,
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "Config file",
          ),
        ).toMatchObject({
          status:
            "skip",
        });

        expect(
          getResult(
            results,
            "Config file",
          ).detail,
        ).toContain(
          "not found",
        );

        /*
         * The optional missing file must not increase the failed-check count.
         */
        expect(
          formatDiagnostics(
            results,
            false,
          ),
        ).toContain(
          "All checks passed.",
        );
      },
    );

    it(
      "fails the session directory check when the directory is not writable",
      async () => {
        state.sessionsWritable =
          false;

        installModelFetch([
          "model-one",
          "model-two",
        ]);

        const {
          runDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results =
          await runDiagnostics();

        expect(
          getResult(
            results,
            "Session directory",
          ).status,
        ).toBe(
          "fail",
        );

        expect(
          getResult(
            results,
            "Session directory",
          ).detail,
        ).toContain(
          "not writable",
        );
      },
    );

    it(
      "includes ANSI colour codes when formatting TTY output",
      async () => {
        const {
          formatDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results:
          DiagnosticResult[] = [
            {
              label:
                "Passing check",
              status:
                "pass",
              detail:
                "ok",
            },
            {
              label:
                "Failing check",
              status:
                "fail",
              detail:
                "failed",
              suggestion:
                "Fix this setting",
            },
            {
              label:
                "Skipped check",
              status:
                "skip",
              detail:
                "skipped",
            },
          ];

        const formatted =
          formatDiagnostics(
            results,
            true,
          );

        expect(
          formatted,
        ).toContain(
          "\x1b[97m",
        );

        expect(
          formatted,
        ).toContain(
          "\x1b[32m",
        );

        expect(
          formatted,
        ).toContain(
          "\x1b[31m",
        );

        expect(
          formatted,
        ).toContain(
          "\x1b[33m",
        );

        expect(
          formatted,
        ).toContain(
          "\x1b[0m",
        );
      },
    );

    it(
      "omits ANSI colour codes when formatting non-TTY output",
      async () => {
        const {
          formatDiagnostics,
        } =
          await import(
            "../src/diagnose.ts"
          );

        const results:
          DiagnosticResult[] = [
            {
              label:
                "Passing check",
              status:
                "pass",
              detail:
                "ok",
            },
            {
              label:
                "Skipped check",
              status:
                "skip",
              detail:
                "skipped",
            },
          ];

        const formatted =
          formatDiagnostics(
            results,
            false,
          );

        expect(
          formatted,
        ).not.toMatch(
          /\x1b\[[0-9;]*m/,
        );

        expect(
          formatted,
        ).toContain(
          "SkyCode Diagnostics",
        );
      },
    );
  },
);
