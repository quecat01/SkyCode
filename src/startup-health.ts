import {
  fetchAvailableModels,
} from "./chat.js";

import type {
  AppConfig,
} from "./config.js";

export interface StartupHealthResult {
  defaultModel:
    string;

  models:
    string[];
}

export type StartupModelFetcher = (
  config:
    AppConfig,
) => Promise<string[]>;

function removeTrailingSlashes(
  value:
    string,
): string {
  return value.replace(
    /\/+$/,
    "",
  );
}

function getErrorMessage(
  error:
    unknown,
): string {
  return error instanceof
    Error
    ? error.message
    : String(
        error,
      );
}

function formatAvailableModels(
  models:
    readonly string[],
): string {
  const displayedModels =
    models.slice(
      0,
      10,
    );

  const additionalCount =
    models.length -
    displayedModels.length;

  const suffix =
    additionalCount >
      0
      ? `, and ${additionalCount} more`
      : "";

  return `${displayedModels.join(
    ", ",
  )}${suffix}`;
}

export function formatStartupHealthFailure(
  config:
    AppConfig,

  error:
    unknown,
): string {
  const apiUrl =
    removeTrailingSlashes(
      config.apiUrl,
    );

  const message =
    getErrorMessage(
      error,
    );

  if (
    /\bHTTP (401|403)\b/i.test(
      message,
    )
  ) {
    return [
      `LiteLLM authentication failed at ${apiUrl}.`,
      "Check that LITELLM_API_KEY contains the correct LiteLLM key.",
    ].join(
      " ",
    );
  }

  if (
    /\bHTTP 404\b/i.test(
      message,
    )
  ) {
    return [
      `The LiteLLM model endpoint was not found at ${apiUrl}/models.`,
      "Check that LITELLM_API_URL points to the LiteLLM API base URL, normally ending in /v1.",
    ].join(
      " ",
    );
  }

  if (
    /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|network error|socket hang up/i.test(
      message,
    )
  ) {
    return [
      `Sky Code could not reach LiteLLM at ${apiUrl}.`,
      "Check that LiteLLM is running and that LITELLM_API_URL is correct.",
    ].join(
      " ",
    );
  }

  return `LiteLLM startup check failed at ${apiUrl}: ${message}`;
}

export async function runStartupHealthCheck(
  config:
    AppConfig,

  fetchModels:
    StartupModelFetcher =
      fetchAvailableModels,
): Promise<StartupHealthResult> {
  let models:
    string[];

  try {
    models =
      await fetchModels(
        config,
      );
  } catch (error) {
    throw new Error(
      formatStartupHealthFailure(
        config,
        error,
      ),
    );
  }

  if (
    models.length ===
      0
  ) {
    throw new Error(
      [
        `LiteLLM at ${removeTrailingSlashes(
          config.apiUrl,
        )} is reachable but returned no available models.`,
        "Check the LiteLLM model configuration.",
      ].join(
        " ",
      ),
    );
  }

  if (
    !models.includes(
      config.defaultModel,
    )
  ) {
    throw new Error(
      [
        `LiteLLM is reachable, but the configured default model "${config.defaultModel}" is not available.`,
        `Available models: ${formatAvailableModels(
          models,
        )}.`,
      ].join(
        " ",
      ),
    );
  }

  return {
    defaultModel:
      config.defaultModel,

    models: [
      ...models,
    ],
  };
}
