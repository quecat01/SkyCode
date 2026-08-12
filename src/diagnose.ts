/**
 * Standalone and interactive setup diagnostics for SkyCode.
 *
 * This module checks the local Node.js runtime, LiteLLM environment
 * configuration, endpoint connectivity and authentication, model availability,
 * SkyCode configuration, and session-directory permissions.
 *
 * Diagnostics are deliberately non-fatal. Every recoverable problem is
 * converted into a DiagnosticResult so `sky diagnose` remains useful even
 * when normal SkyCode startup would fail.
 */

import {
  constants as fsConstants,
} from "node:fs";

import {
  access,
  readFile,
  stat,
} from "node:fs/promises";

import {
  homedir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  loadConfig,
  type AppConfig,
} from "./config.js";

/**
 * Result of one SkyCode diagnostic check.
 *
 * `pass` means the condition was verified successfully, `fail` means the
 * condition was checked and found to be incorrect, and `skip` means the check
 * could not or should not be performed. Skip is also used for the optional
 * missing-config-file warning because the public result contract intentionally
 * contains no separate warning status.
 */
export interface DiagnosticResult {
  /** Human-readable diagnostic label displayed in the report. */
  label: string;

  /** Whether the check passed, failed, or was skipped. */
  status:
    | "pass"
    | "fail"
    | "skip";

  /** Concise result detail displayed beside the diagnostic label. */
  detail: string;

  /** Optional actionable guidance displayed beneath the result. */
  suggestion?: string;
}

/**
 * Removes trailing slash characters from an API base URL.
 *
 * This follows the same URL-normalization behavior used by src/chat.ts before
 * `/models` is appended, preventing accidental double slashes.
 *
 * @param {string} value - API URL text to normalize.
 * @returns {string} The URL with all trailing slash characters removed.
 * @throws {never} This function does not intentionally throw.
 *
 * Side effects: none.
 */
function removeTrailingSlashes(
  value: string,
): string {
  return value.replace(
    /\/+$/,
    "",
  );
}

/**
 * Converts an unknown error or thrown value into concise diagnostic text.
 *
 * @param {unknown} error - Error or arbitrary thrown value to describe.
 * @returns {string} Error.message when available, otherwise String(error).
 * @throws {never} This function does not intentionally throw.
 *
 * Side effects: none.
 */
function formatUnknownError(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

/**
 * Produces a user-friendly description for a failed LiteLLM network request.
 *
 * Abort errors are identified as the diagnostic ten-second timeout. Common
 * socket error codes such as ECONNREFUSED are translated into shorter messages,
 * while unknown network failures retain their original error text.
 *
 * @param {unknown} error - Error raised by fetch or request cancellation.
 * @returns {string} Concise network-failure detail for the report.
 * @throws {never} This function does not intentionally throw.
 *
 * Side effects: none.
 */
function formatNetworkFailure(
  error: unknown,
): string {
  if (
    error instanceof Error &&
    error.name === "AbortError"
  ) {
    return "timed out after 10 seconds";
  }

  const possibleCause =
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null
      ? error.cause as Record<
          string,
          unknown
        >
      : null;

  const errorCode =
    possibleCause &&
    typeof possibleCause.code === "string"
      ? possibleCause.code
      : "";

  switch (errorCode) {
    case "ECONNREFUSED":
      return "connection refused";

    case "ENOTFOUND":
      return "host not found";

    case "EHOSTUNREACH":
      return "host unreachable";

    case "ETIMEDOUT":
      return "connection timed out";

    default:
      return formatUnknownError(
        error,
      );
  }
}

/**
 * Extracts unique valid model identifiers from an OpenAI-compatible model-list
 * response.
 *
 * The behavior intentionally matches src/chat.ts: the top-level value must be
 * an object containing a `data` array, malformed individual entries are
 * ignored, and duplicate IDs are removed while preserving first-seen order.
 *
 * `null` indicates that the top-level model-list structure is invalid. An
 * empty array is different: it means the structure was valid but contained no
 * usable model identifiers.
 *
 * @param {unknown} payload - Parsed JSON received from the `/models` endpoint.
 * @returns {string[] | null} Unique model IDs, or null for an invalid response
 * structure.
 * @throws {never} This function does not intentionally throw.
 *
 * Side effects: none.
 */
function extractModelIds(
  payload: unknown,
): string[] | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const data =
    (
      payload as Record<
        string,
        unknown
      >
    ).data;

  if (!Array.isArray(data)) {
    return null;
  }

  const modelIds =
    data
      .map(
        (
          entry,
        ): string | null => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            return null;
          }

          const id =
            (
              entry as Record<
                string,
                unknown
              >
            ).id;

          return typeof id === "string"
            ? id
            : null;
        },
      )
      .filter(
        (
          modelId,
        ): modelId is string =>
          modelId !== null,
      );

  return [
    ...new Set(
      modelIds,
    ),
  ];
}

/**
 * Runs the ten SkyCode setup diagnostic checks in their required order.
 *
 * Configuration loading is attempted first and is fully contained so an
 * incomplete or invalid setup cannot crash diagnostics. The resulting
 * defaultModel is used only when configuration loading succeeds.
 *
 * Checks 5 through 8 share one authenticated GET request to the same `/models`
 * URL construction used by src/chat.ts. Network-dependent checks are skipped
 * when their URL or API-key prerequisites are unavailable, and checks 6
 * through 8 are skipped when LiteLLM cannot be reached.
 *
 * @returns {Promise<DiagnosticResult[]>} Results for all ten checks in report
 * order.
 * @throws {never} All expected configuration, filesystem, parsing, timeout,
 * and network errors are converted into diagnostic results.
 *
 * Side effects: reads SkyCode configuration and filesystem state, reads
 * environment variables, and may perform one authenticated HTTP GET request.
 */
export async function runDiagnostics():
  Promise<DiagnosticResult[]> {
  /*
   * loadConfig() must be attempted before the checks begin because it is the
   * authoritative existing SkyCode configuration loader. Its failure is kept
   * as diagnostic state instead of being allowed to terminate this command.
   */
  let loadedConfig:
    AppConfig | null =
    null;

  let configLoadError:
    string | null =
    null;

  try {
    loadedConfig =
      await loadConfig();
  } catch (error) {
    configLoadError =
      formatUnknownError(
        error,
      );
  }

  const results:
    DiagnosticResult[] = [];

  /*
   * Check 1 — Node.js version.
   *
   * process.versions.node is controlled by the running Node.js process, so the
   * major version can be inspected without filesystem or network activity.
   */
  const nodeVersion =
    process.versions.node;

  const nodeMajorVersion =
    Number.parseInt(
      nodeVersion.split(
        ".",
      )[0] ?? "",
      10,
    );

  if (
    Number.isFinite(
      nodeMajorVersion,
    ) &&
    nodeMajorVersion >= 20
  ) {
    results.push({
      label:
        "Node.js version",
      status:
        "pass",
      detail:
        `v${nodeVersion}  (v20+ required)`,
    });
  } else {
    results.push({
      label:
        "Node.js version",
      status:
        "fail",
      detail:
        `v${nodeVersion}  (v20+ required)`,
      suggestion:
        "Install Node.js v20 or newer before running SkyCode",
    });
  }

  /*
   * Check 2 — LITELLM_API_URL presence.
   *
   * The environment value is checked directly because this diagnostic is
   * specifically intended to identify whether that variable is available.
   */
  const apiUrl =
    typeof process.env
      .LITELLM_API_URL === "string"
      ? process.env
          .LITELLM_API_URL
          .trim()
      : "";

  if (apiUrl !== "") {
    results.push({
      label:
        "LITELLM_API_URL",
      status:
        "pass",
      detail:
        `set  →  ${apiUrl}`,
    });
  } else {
    results.push({
      label:
        "LITELLM_API_URL",
      status:
        "fail",
      detail:
        "not set",
      suggestion:
        "Run 'sky setup' or set LITELLM_API_URL",
    });
  }

  /*
   * Check 3 — LITELLM_API_KEY presence.
   *
   * Only presence is reported. The secret itself is never copied into a
   * diagnostic detail, suggestion, error, or network-failure message.
   */
  const apiKey =
    typeof process.env
      .LITELLM_API_KEY === "string"
      ? process.env
          .LITELLM_API_KEY
          .trim()
      : "";

  if (apiKey !== "") {
    results.push({
      label:
        "LITELLM_API_KEY",
      status:
        "pass",
      detail:
        "set  (value hidden)",
    });
  } else {
    results.push({
      label:
        "LITELLM_API_KEY",
      status:
        "fail",
      detail:
        "not set",
      suggestion:
        "Run 'sky setup' or set LITELLM_API_KEY",
    });
  }

  /*
   * Check 4 — URL format.
   *
   * A missing URL is a prerequisite skip rather than a second failure because
   * check 2 already identifies the missing environment variable.
   */
  let normalizedApiUrl:
    string | null =
    null;

  if (apiUrl === "") {
    results.push({
      label:
        "URL format",
      status:
        "skip",
      detail:
        "skipped (LITELLM_API_URL not set)",
    });
  } else {
    try {
      const parsedUrl =
        new URL(
          apiUrl,
        );

      if (
        parsedUrl.protocol !== "http:" &&
        parsedUrl.protocol !== "https:"
      ) {
        results.push({
          label:
            "URL format",
          status:
            "fail",
          detail:
            "invalid  (http:// or https:// required)",
          suggestion:
            "Set LITELLM_API_URL to an absolute http:// or https:// URL",
        });
      } else {
        normalizedApiUrl =
          removeTrailingSlashes(
            apiUrl,
          );

        results.push({
          label:
            "URL format",
          status:
            "pass",
          detail:
            "valid",
        });
      }
    } catch {
      results.push({
        label:
          "URL format",
        status:
          "fail",
        detail:
          "invalid",
        suggestion:
          "Set LITELLM_API_URL to an absolute http:// or https:// URL",
      });
    }
  }

  /*
   * Checks 5–8 — LiteLLM reachability, authentication, models, and default
   * model.
   *
   * All four checks intentionally share one request so diagnostics do not send
   * repeated model-list requests merely to report separate conditions.
   */
  if (
    normalizedApiUrl === null
  ) {
    const reason =
      apiUrl === ""
        ? "LITELLM_API_URL not set"
        : "URL format invalid";

    results.push(
      {
        label:
          "LiteLLM reachable",
        status:
          "skip",
        detail:
          `skipped (${reason})`,
      },
      {
        label:
          "Authentication",
        status:
          "skip",
        detail:
          `skipped (${reason})`,
      },
      {
        label:
          "Models available",
        status:
          "skip",
        detail:
          "skipped",
      },
      {
        label:
          "Default model",
        status:
          "skip",
        detail:
          "skipped",
      },
    );
  } else if (
    apiKey === ""
  ) {
    results.push(
      {
        label:
          "LiteLLM reachable",
        status:
          "skip",
        detail:
          "skipped (LITELLM_API_KEY not set)",
      },
      {
        label:
          "Authentication",
        status:
          "skip",
        detail:
          "skipped (LITELLM_API_KEY not set)",
      },
      {
        label:
          "Models available",
        status:
          "skip",
        detail:
          "skipped",
      },
      {
        label:
          "Default model",
        status:
          "skip",
        detail:
          "skipped",
      },
    );
  } else {
    const controller =
      new AbortController();

    /*
     * AbortController provides a hard upper bound for diagnostics so a broken
     * endpoint cannot leave `sky diagnose` hanging indefinitely.
     */
    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        10_000,
      );

    try {
      /*
       * This deliberately mirrors src/chat.ts:
       * remove trailing slashes from the configured base, then append /models.
       * A normal base ending in /v1 therefore requests /v1/models.
       */
      const response =
        await fetch(
          `${normalizedApiUrl}/models`,
          {
            method:
              "GET",
            headers: {
              Authorization:
                `Bearer ${apiKey}`,
              Accept:
                "application/json",
            },
            signal:
              controller.signal,
          },
        );

      const responseStatus =
        `${response.status}${
          response.statusText.trim() === ""
            ? ""
            : ` ${response.statusText}`
        }`;

      const reachabilityResult:
        DiagnosticResult = {
          label:
            "LiteLLM reachable",
          status:
            "pass",
          detail:
            responseStatus,
        };

      results.push(
        reachabilityResult,
      );

      /*
       * Check 6 is intentionally defined exactly as specified: HTTP 401 is an
       * authentication failure. Any other received HTTP status satisfies this
       * particular check, even though later model-list validation may fail.
       */
      if (
        response.status === 401
      ) {
        results.push({
          label:
            "Authentication",
          status:
            "fail",
          detail:
            "failed  (401 Unauthorized)",
          suggestion:
            "Check that LITELLM_API_KEY contains the correct LiteLLM key",
        });

        results.push(
          {
            label:
              "Models available",
            status:
              "skip",
            detail:
              "skipped (authentication failed)",
          },
          {
            label:
              "Default model",
            status:
              "skip",
            detail:
              "skipped (authentication failed)",
          },
        );
      } else {
        results.push({
          label:
            "Authentication",
          status:
            "pass",
          detail:
            "ok",
        });

        /*
         * Check 7 needs the response body only after authentication has been
         * checked. Invalid JSON or an unexpected model-list shape is reported
         * locally and never allowed to escape runDiagnostics().
         */
        let models:
          string[] | null =
          null;

        let modelListFailure:
          string | null =
          null;

        try {
          const payload:
            unknown =
            await response.json();

          models =
            extractModelIds(
              payload,
            );

          if (
            models === null
          ) {
            modelListFailure =
              "invalid model-list response";
          }
        } catch (error) {
          modelListFailure =
            `invalid model-list response: ${formatUnknownError(
              error,
            )}`;
        }

        if (
          modelListFailure !== null
        ) {
          results.push({
            label:
              "Models available",
            status:
              "fail",
            detail:
              modelListFailure,
            suggestion:
              "Check the LiteLLM model configuration and /v1/models response",
          });

          results.push({
            label:
              "Default model",
            status:
              "skip",
            detail:
              "skipped (model list unavailable)",
          });
        } else if (
          models !== null &&
          models.length === 0
        ) {
          reachabilityResult.detail =
            `${responseStatus}  →  0 models found`;

          results.push({
            label:
              "Models available",
            status:
              "fail",
            detail:
              "0 models",
            suggestion:
              "Configure at least one model in LiteLLM",
          });

          results.push({
            label:
              "Default model",
            status:
              "skip",
            detail:
              "skipped (no models available)",
          });
        } else if (
          models !== null
        ) {
          const modelLabel =
            models.length === 1
              ? "model"
              : "models";

          reachabilityResult.detail =
            `${responseStatus}  →  ${models.length} ${modelLabel} found`;

          results.push({
            label:
              "Models available",
            status:
              "pass",
            detail:
              `${models.length} ${modelLabel}`,
          });

          /*
           * Check 8 depends both on a usable model list and successful use of
           * SkyCode's existing configuration loader. A loadConfig() failure
           * means defaultModel is intentionally treated as unconfigured.
           */
          if (
            loadedConfig === null
          ) {
            results.push({
              label:
                "Default model",
              status:
                "skip",
              detail:
                "skipped (defaultModel not configured)",
            });
          } else if (
            models.includes(
              loadedConfig.defaultModel,
            )
          ) {
            results.push({
              label:
                "Default model",
              status:
                "pass",
              detail:
                `${loadedConfig.defaultModel}  ✓ in model list`,
            });
          } else {
            results.push({
              label:
                "Default model",
              status:
                "fail",
              detail:
                `${loadedConfig.defaultModel}  ✗ not in model list`,
              suggestion:
                "Select an available default model with 'sky setup'",
            });
          }
        }
      }
    } catch (error) {
      results.push({
        label:
          "LiteLLM reachable",
        status:
          "fail",
        detail:
          formatNetworkFailure(
            error,
          ),
        suggestion:
          "Check that LiteLLM is running and the URL in sky setup is correct",
      });

      results.push(
        {
          label:
            "Authentication",
          status:
            "skip",
          detail:
            "skipped (LiteLLM not reachable)",
        },
        {
          label:
            "Models available",
          status:
            "skip",
          detail:
            "skipped",
        },
        {
          label:
            "Default model",
          status:
            "skip",
          detail:
            "skipped",
        },
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  /*
   * Check 9 — global config file.
   *
   * A missing ~/.sky-code/config.json is intentionally a yellow non-failing
   * warning because environment-only configuration is supported. Existing
   * malformed JSON is a failure. If JSON itself is valid but loadConfig()
   * failed validation, the authoritative loader's specific error is retained.
   */
  const skyCodeDirectory =
    join(
      homedir(),
      ".sky-code",
    );

  const configPath =
    join(
      skyCodeDirectory,
      "config.json",
    );

  let configContents:
    string | null =
    null;

  try {
    configContents =
      await readFile(
        configPath,
        "utf8",
      );
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code === "ENOENT"
    ) {
      results.push({
        label:
          "Config file",
        status:
          "skip",
        detail:
          "~/.sky-code/config.json  (not found — optional)",
        suggestion:
          "SkyCode can run from environment variables without this file",
      });
    } else {
      results.push({
        label:
          "Config file",
        status:
          "fail",
        detail:
          `~/.sky-code/config.json  (unable to read: ${formatUnknownError(
            error,
          )})`,
        suggestion:
          "Check the file ownership and permissions, or run 'sky setup'",
      });
    }
  }

  if (
    configContents !== null
  ) {
    let jsonError:
      string | null =
      null;

    try {
      JSON.parse(
        configContents,
      );
    } catch (error) {
      jsonError =
        formatUnknownError(
          error,
        );
    }

    if (
      jsonError !== null
    ) {
      results.push({
        label:
          "Config file",
        status:
          "fail",
        detail:
          `~/.sky-code/config.json  (invalid JSON: ${jsonError})`,
        suggestion:
          "Correct the JSON syntax or run 'sky setup' to recreate the configuration",
      });
    } else if (
      configLoadError !== null
    ) {
      results.push({
        label:
          "Config file",
        status:
          "fail",
        detail:
          `~/.sky-code/config.json  (configuration load failed: ${configLoadError})`,
        suggestion:
          "Review the reported configuration error or run 'sky setup'",
      });
    } else {
      results.push({
        label:
          "Config file",
        status:
          "pass",
        detail:
          "~/.sky-code/config.json  (valid)",
      });
    }
  }

  /*
   * Check 10 — session directory.
   *
   * stat() verifies that the path is actually a directory and access(W_OK)
   * verifies write permission without creating or modifying any session file.
   */
  const sessionsPath =
    join(
      skyCodeDirectory,
      "sessions",
    );

  try {
    const sessionsStat =
      await stat(
        sessionsPath,
      );

    if (
      !sessionsStat.isDirectory()
    ) {
      results.push({
        label:
          "Session directory",
        status:
          "fail",
        detail:
          "~/.sky-code/sessions/  (not a directory)",
        suggestion:
          "Replace the path with a writable sessions directory",
      });
    } else {
      try {
        await access(
          sessionsPath,
          fsConstants.W_OK,
        );

        results.push({
          label:
            "Session directory",
          status:
            "pass",
          detail:
            "~/.sky-code/sessions/  (writable)",
        });
      } catch (error) {
        results.push({
          label:
            "Session directory",
          status:
            "fail",
          detail:
            `~/.sky-code/sessions/  (not writable: ${formatUnknownError(
              error,
            )})`,
          suggestion:
            "Check ownership and write permissions for ~/.sky-code/sessions/",
        });
      }
    }
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code === "ENOENT"
    ) {
      results.push({
        label:
          "Session directory",
        status:
          "fail",
        detail:
          "~/.sky-code/sessions/  (not found)",
        suggestion:
          "Run SkyCode setup or create a writable ~/.sky-code/sessions/ directory",
      });
    } else {
      results.push({
        label:
          "Session directory",
        status:
          "fail",
        detail:
          `~/.sky-code/sessions/  (${formatUnknownError(
            error,
          )})`,
        suggestion:
          "Check ownership and permissions for ~/.sky-code/sessions/",
      });
    }
  }

  return results;
}

/**
 * Formats diagnostic results as the user-facing SkyCode diagnostic report.
 *
 * Terminal output uses bright white for the heading, green for passing checks,
 * red for failures, and yellow for skipped checks, warnings, and suggestions.
 * Non-TTY output contains exactly the same textual content without ANSI escape
 * sequences.
 *
 * @param {DiagnosticResult[]} results - Diagnostic results in display order.
 * @param {boolean} isTTY - Whether ANSI terminal colours should be emitted.
 * @returns {string} Complete diagnostic report ready to print.
 * @throws {never} This function does not intentionally throw.
 *
 * Side effects: none.
 */
export function formatDiagnostics(
  results:
    DiagnosticResult[],
  isTTY:
    boolean,
): string {
  /**
   * Applies one ANSI colour when terminal colouring is enabled.
   *
   * @param {string} code - ANSI numeric colour code.
   * @param {string} text - Text to colour.
   * @returns {string} Coloured text for TTY output, otherwise unchanged text.
   * @throws {never} This function does not intentionally throw.
   *
   * Side effects: none.
   */
  function colour(
    code: string,
    text: string,
  ): string {
    return isTTY
      ? `\x1b[${code}m${text}\x1b[0m`
      : text;
  }

  const lines:
    string[] = [
      colour(
        "97",
        "SkyCode Diagnostics",
      ),
      colour(
        "97",
        "────────────────────────────────────────────",
      ),
    ];

  for (
    const result of
    results
  ) {
    const symbol =
      result.status === "pass"
        ? "✓"
        : "✗";

    const line =
      `${symbol} ${result.label.padEnd(
        20,
      )}${result.detail}`;

    const colourCode =
      result.status === "pass"
        ? "32"
        : result.status === "fail"
          ? "31"
          : "33";

    lines.push(
      colour(
        colourCode,
        line,
      ),
    );

    if (
      result.suggestion
    ) {
      lines.push(
        colour(
          "33",
          `  → ${result.suggestion}`,
        ),
      );
    }
  }

  const failedChecks =
    results.filter(
      (
        result,
      ) =>
        result.status === "fail",
    ).length;

  lines.push(
    "",
  );

  if (
    failedChecks === 0
  ) {
    lines.push(
      "All checks passed.",
    );
  } else if (
    failedChecks === 1
  ) {
    lines.push(
      "1 check failed.",
    );
  } else {
    lines.push(
      `${failedChecks} checks failed.`,
    );
  }

  /*
   * Ending with an empty line gives console.log(formatDiagnostics(...)) the
   * blank separator shown in the required report format.
   */
  lines.push(
    "",
  );

  return lines.join(
    "\n",
  );
}
