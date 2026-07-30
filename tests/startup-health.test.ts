import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  AppConfig,
} from "../src/config.ts";

import {
  formatStartupHealthFailure,
  runStartupHealthCheck,
} from "../src/startup-health.ts";

function createConfig(
  overrides:
    Partial<AppConfig> = {},
): AppConfig {
  return {
    apiUrl:
      "http://litellm.test/v1",

    apiKey:
      "temporary-test-key",

    defaultModel:
      "model-two",

    defaultPermissionMode:
      "default",

    compactionThreshold:
      6_000,

    compactionStrategy:
      "summarise",

    compactionWindowSize:
      20,

    mcpServers: [],

    pluginDirs: [],

    ...overrides,
  };
}

describe(
  "startup LiteLLM health check",
  () => {
    it(
      "returns silently usable health information when LiteLLM is ready",
      async () => {
        const fetchModels =
          vi.fn(
            async () => [
              "model-one",
              "model-two",
            ],
          );

        await expect(
          runStartupHealthCheck(
            createConfig(),
            fetchModels,
          ),
        ).resolves.toEqual({
          defaultModel:
            "model-two",

          models: [
            "model-one",
            "model-two",
          ],
        });

        expect(
          fetchModels,
        ).toHaveBeenCalledOnce();
      },
    );

    it(
      "rejects a reachable LiteLLM instance with no configured models",
      async () => {
        await expect(
          runStartupHealthCheck(
            createConfig(),
            async () => [],
          ),
        ).rejects.toThrow(
          "is reachable but returned no available models",
        );
      },
    );

    it(
      "rejects an unavailable configured default model",
      async () => {
        await expect(
          runStartupHealthCheck(
            createConfig({
              defaultModel:
                "missing-model",
            }),
            async () => [
              "model-one",
              "model-two",
            ],
          ),
        ).rejects.toThrow(
          [
            'configured default model "missing-model" is not available',
            "Available models: model-one, model-two",
          ].join(
            ". ",
          ),
        );
      },
    );

    it(
      "formats authentication failures without exposing the API key",
      () => {
        const config =
          createConfig({
            apiKey:
              "secret-key-that-must-not-appear",
          });

        const message =
          formatStartupHealthFailure(
            config,
            new Error(
              "Unable to retrieve LiteLLM models: HTTP 401: Unauthorized",
            ),
          );

        expect(
          message,
        ).toContain(
          "LiteLLM authentication failed",
        );

        expect(
          message,
        ).toContain(
          "LITELLM_API_KEY",
        );

        expect(
          message,
        ).not.toContain(
          config.apiKey,
        );
      },
    );

    it(
      "formats unreachable LiteLLM errors in plain language",
      () => {
        expect(
          formatStartupHealthFailure(
            createConfig(),
            new TypeError(
              "fetch failed",
            ),
          ),
        ).toBe(
          [
            "Sky Code could not reach LiteLLM at http://litellm.test/v1.",
            "Check that LiteLLM is running and that LITELLM_API_URL is correct.",
          ].join(
            " ",
          ),
        );
      },
    );

    it(
      "formats a missing model endpoint with URL guidance",
      () => {
        expect(
          formatStartupHealthFailure(
            createConfig({
              apiUrl:
                "http://litellm.test/v1/",
            }),
            new Error(
              "Unable to retrieve LiteLLM models: HTTP 404: Not Found",
            ),
          ),
        ).toBe(
          [
            "The LiteLLM model endpoint was not found at http://litellm.test/v1/models.",
            "Check that LITELLM_API_URL points to the LiteLLM API base URL, normally ending in /v1.",
          ].join(
            " ",
          ),
        );
      },
    );
  },
);
