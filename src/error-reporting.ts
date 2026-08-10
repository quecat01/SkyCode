/**
 * CLI error normalization, credential redaction, and recovery guidance.
 *
 * This module converts arbitrary failures into short, consistent terminal
 * messages while removing several common credential forms and suggesting a
 * practical next step for recognized error categories.
 */

/**
 * Context used to turn an arbitrary failure into consistent CLI output.
 */
export interface CliErrorReportOptions {
  /** Human-readable operation name shown in the first failure line. */
  operation:
    string;

  /** Optional explicit recovery guidance that overrides inferred advice. */
  nextStep?:
    string;
}

/**
 * Converts an unknown thrown value into displayable error text.
 *
 * @param {unknown} error - Error instance or arbitrary thrown value.
 * @returns {string} Error.message for Error instances, otherwise String(error).
 *
 * Side effects: none.
 */
function getErrorMessage(
  error:
    unknown,
): string {
  if (
    error instanceof
      Error
  ) {
    return error.message;
  }

  return String(
    error,
  );
}

/**
 * Redacts common credential forms before an error message reaches the terminal.
 *
 * The current patterns cover Bearer tokens, common API-key assignments, and
 * `api_key`/`api-key`/`token` query parameters. This is defensive output
 * sanitization, not a general-purpose secret scanner.
 *
 * @param {string} value - Raw error text that may contain credentials.
 * @returns {string} Text with recognized sensitive values replaced by
 * `[redacted]`.
 *
 * Side effects: none.
 */
function redactSensitiveValues(
  value:
    string,
): string {
  return value
    .replace(
      /\bBearer\s+[^\s,;]+/gi,
      "Bearer [redacted]",
    )
    .replace(
      /\b(LITELLM_API_KEY|OPENAI_API_KEY|api[_-]?key)\s*[:=]\s*["']?[^"',;\s]+["']?/gi,
      "$1=[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|token)=)[^&\s]+/gi,
      "$1[redacted]",
    );
}

/**
 * Sanitizes and flattens error text for compact CLI reporting.
 *
 * Sensitive values are redacted first. CRLF line endings are normalized,
 * blank lines are discarded, remaining lines are trimmed and joined with
 * spaces, and repeated whitespace is collapsed. Empty results receive a
 * deterministic fallback message.
 *
 * @param {string} value - Raw error message text.
 * @returns {string} Redacted single-line error reason.
 *
 * Side effects: none.
 */
function normalizeMessage(
  value:
    string,
): string {
  const normalized =
    redactSensitiveValues(
      value,
    )
      .replace(
        /\r\n/g,
        "\n",
      )
      .split(
        "\n",
      )
      .map(
        (
          line,
        ) =>
          line.trim(),
      )
      .filter(
        (
          line,
        ) =>
          line !==
            "",
      )
      .join(
        " ",
      )
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  return normalized ===
    ""
    ? "No error details were provided."
    : normalized;
}

/**
 * Infers concise recovery guidance from a normalized error message.
 *
 * Checks are intentionally ordered from specific filesystem/authentication and
 * endpoint failures through broader network, timeout, JSON, and usage/config
 * errors. The first matching category wins.
 *
 * @param {string} message - Normalized error message to classify.
 * @returns {string | null} Suggested next step, or null when no known pattern
 * matches.
 *
 * Side effects: none.
 */
function inferNextStep(
  message:
    string,
): string | null {
  if (
    /\b(?:EACCES|EPERM)\b|permission denied/i.test(
      message,
    )
  ) {
    return "Check the file or directory ownership and permissions, then try again.";
  }

  if (
    /\bENOENT\b|no such file|not found/i.test(
      message,
    )
  ) {
    return "Check that the referenced file, directory, command, or catalog item exists.";
  }

  if (
    /\bHTTP (?:401|403)\b|unauthori[sz]ed|authentication failed/i.test(
      message,
    )
  ) {
    return "Check the configured credentials and confirm they are valid for this service.";
  }

  if (
    /\bHTTP 404\b|endpoint was not found/i.test(
      message,
    )
  ) {
    return "Check the configured service URL and endpoint path.";
  }

  if (
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network error|socket hang up/i.test(
      message,
    )
  ) {
    return "Check that the service is running, reachable, and configured with the correct address.";
  }

  if (
    /ETIMEDOUT|timed out|timeout/i.test(
      message,
    )
  ) {
    return "Check the service or command status, then try again.";
  }

  if (
    /invalid json|unable to parse|unexpected token|must contain a json object/i.test(
      message,
    )
  ) {
    return "Correct the referenced JSON or configuration file, then try again.";
  }

  if (
    /does not contain|must be|missing .* argument|usage:/i.test(
      message,
    )
  ) {
    return "Correct the command or configuration using the requirement shown above.";
  }

  return null;
}

/**
 * Normalizes the operation label used in CLI error headings.
 *
 * @param {string} operation - Caller-provided operation description.
 * @returns {string} Trimmed operation name, or `Operation` when empty.
 *
 * Side effects: none.
 */
function normalizeOperation(
  operation:
    string,
): string {
  const normalized =
    operation.trim();

  return normalized ===
    ""
    ? "Operation"
    : normalized;
}

/**
 * Formats an arbitrary failure as consistent, user-facing CLI report lines.
 *
 * The error reason is converted to text, redacted, and normalized before
 * display. A non-empty explicit nextStep takes precedence over inferred
 * recovery guidance. The result always contains operation and reason lines,
 * with a third `Next step:` line only when guidance is available.
 *
 * @param {unknown} error - Failure value to report.
 * @param {CliErrorReportOptions} options - Operation label and optional explicit
 * recovery guidance.
 * @returns {string[]} Ordered terminal-ready error report lines.
 *
 * Side effects: none.
 */
export function formatCliErrorReport(
  error:
    unknown,

  options:
    CliErrorReportOptions,
): string[] {
  const operation =
    normalizeOperation(
      options.operation,
    );

  const reason =
    normalizeMessage(
      getErrorMessage(
        error,
      ),
    );

  const nextStep =
    options.nextStep
      ?.trim() ||
    inferNextStep(
      reason,
    );

  const lines = [
    `${operation} failed.`,
    `Reason: ${reason}`,
  ];

  if (
    nextStep
  ) {
    lines.push(
      `Next step: ${nextStep}`,
    );
  }

  return lines;
}
