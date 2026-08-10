/**
 * Startup connectivity and model-availability validation for Sky Code.
 *
 * This module performs the lightweight LiteLLM check used during startup,
 * translates common connection/authentication failures into actionable messages,
 * and verifies that the configured default model is actually available.
 */
import {
  fetchAvailableModels,
} from "./chat.js";

import type {
  AppConfig,
} from "./config.js";

/**
 * Successful startup-health result.
 *
 * The result records the configured default model and a snapshot of the models
 * reported by LiteLLM when the health check completed.
 */
export interface StartupHealthResult {
  defaultModel:
    string;

  models:
    string[];
}

/**
 * Injectable model-list fetcher used by the startup health check.
 *
 * The production default is fetchAvailableModels; injection keeps startup
 * validation independently testable without requiring a live LiteLLM endpoint.
 *
 * @param {AppConfig} config - Sky Code configuration used to contact LiteLLM.
 * @returns {Promise<string[]>} Available model identifiers.
 */
export type StartupModelFetcher = (
  config:
    AppConfig,
) => Promise<string[]>;

/**
 * Removes trailing `/` characters from an API base URL for consistent messages.
 *
 * @param {string} value - URL or path text to normalize.
 * @returns {string} Input with all trailing slashes removed.
 *
 * Side effects: none.
 */
function removeTrailingSlashes(
  value:
    string,
): string {
  return value.replace(
    /\/+$/,
    "",
  );
}

/**
 * Converts an unknown thrown value into diagnostic text.
 *
 * @param {unknown} error - Error or arbitrary thrown value.
 * @returns {string} Error.message for Error instances, otherwise String(error).
 *
 * Side effects: none.
 */
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

/**
 * Formats a bounded list of available models for startup-error output.
 *
 * At most ten model names are displayed. When more are available, a concise
 * `and N more` suffix avoids producing an excessively long startup message.
 *
 * @param {readonly string[]} models - Available model identifiers.
 * @returns {string} Comma-separated model summary.
 *
 * Side effects: none.
 */
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

/**
 * Converts a LiteLLM startup failure into an actionable user-facing message.
 *
 * Authentication failures (HTTP 401/403), a missing `/models` endpoint (404),
 * and common network/socket failures receive targeted guidance. Other failures
 * retain the normalized API URL and original error text for diagnosis.
 *
 * @param {AppConfig} config - Configuration containing the LiteLLM API URL.
 * @param {unknown} error - Failure raised while fetching available models.
 * @returns {string} User-facing startup-health failure description.
 *
 * Side effects: none.
 */
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

/**
 * Verifies LiteLLM reachability and the configured default model during startup.
 *
 * The supplied model fetcher is called first. Fetch failures are wrapped with
 * formatStartupHealthFailure(). A reachable endpoint must return at least one
 * model, and config.defaultModel must appear in that list before startup health
 * is considered successful.
 *
 * A shallow copy of the model array is returned so callers receive a result
 * snapshot rather than the fetcher's original mutable array.
 *
 * @param {AppConfig} config - Active Sky Code configuration.
 * @param {StartupModelFetcher} fetchModels - Model fetcher; defaults to
 * fetchAvailableModels.
 * @returns {Promise<StartupHealthResult>} Verified default model and available
 * model snapshot.
 * @throws {Error} If model fetching fails, no models are returned, or the
 * configured default model is unavailable.
 *
 * Side effects: normally performs a LiteLLM `/models` network request through
 * fetchAvailableModels; injected fetchers may have their own side effects.
 */
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
