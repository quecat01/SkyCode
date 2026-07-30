export interface CliErrorReportOptions {
  operation:
    string;

  nextStep?:
    string;
}

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
