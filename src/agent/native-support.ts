/**
 * Runtime detection of endpoints that cannot perform native tool calling,
 * and the per-session memory of that finding.
 *
 * NativeStrategy is the default for every model (strategy-selection.ts).
 * The only thing that moves a model off it automatically is the provider
 * itself refusing native tool calling. This module decides what counts as
 * that refusal, deliberately narrowly:
 *
 * - Only an HTTP 400 or 422 qualifies. 401/403 (authentication), 429 (rate
 *   limiting), 5xx (server errors), network failures, and timeouts say
 *   nothing about native tool support, so they never trigger a fallback.
 * - The response body must say that tools or function calling specifically
 *   are unsupported. A rejection of some other request field does not
 *   qualify. In particular, LiteLLM's
 *   `UnsupportedParamsError ... does not support parameters:
 *   ['parallel_tool_calls']` (the failure that blocked the first native
 *   acceptance test) is a rejection of one optional field, not of tool
 *   calling, and must never cause a downgrade.
 * - Model behavior never qualifies: malformed arguments, several calls at
 *   once, no tool call at all, or a failed tool execution are handled
 *   inside NativeStrategy and never reach this module.
 *
 * Matching is on the provider's error text, so a provider that phrases its
 * rejection in a way none of the patterns below recognize is simply not
 * downgraded: the request fails visibly, exactly as it would without this
 * module, and the pattern can be added once that wording is known.
 *
 * A finding is remembered only in memory, for the current process, keyed by
 * endpoint and model, so later turns do not repeat a request the provider
 * has already refused. Nothing is persisted: a provider upgrade is picked up
 * the next time Sky Code starts.
 */
/**
 * The fields a failed native HTTP request carries (in production,
 * NativeRequestHttpError, chat.ts). Recognized by shape rather than by
 * importing that class, so agent/ code keeps depending on chat.ts only
 * through adapters/litellm-client.ts.
 */
export interface NativeHttpFailure {
  name: string;
  status: number;
  body: string;
}

/**
 * Narrows a thrown value to a failed native HTTP request.
 *
 * @param {unknown} error - Anything thrown by a native completion request.
 * @returns {boolean} True when it carries a numeric status and string body
 * and is named NativeRequestHttpError.
 */
function isNativeHttpFailure(
  error: unknown,
): error is NativeHttpFailure {
  if (
    typeof error !== "object" ||
    error === null
  ) {
    return false;
  }

  const record =
    error as Record<string, unknown>;

  return (
    record.name ===
      "NativeRequestHttpError" &&
    typeof record.status ===
      "number" &&
    typeof record.body ===
      "string"
  );
}

/**
 * Body patterns that state tool calling itself is unsupported, independent
 * of the LiteLLM parameter-list format handled separately below.
 *
 * Each `tool`/`function` keyword is preceded by a lookbehind that rejects a
 * word character, hyphen, or underscore, so the name of a different field
 * that merely contains the word (`parallel_tool_calls`) cannot match.
 */
const TOOLS_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  // Ollama: "registry.ollama.ai/library/<model> does not support tools".
  /\bdoes not support (?<![\w-])tools\b/i,
  // Generic phrasings: "tools are not supported", "tool calling is not
  // supported", "function calling not supported", "tool calls are not
  // supported for this model".
  /(?<![\w-])(?:tools?|function)(?:[ _-]?call(?:ing|s)?)? (?:is |are )?not supported/i,
  /\bdoes not support (?<![\w-])(?:tool|function)[ _-]?call(?:ing|s)?\b/i,
  /\bno support for (?<![\w-])(?:tools|tool[ _-]?call(?:ing|s)?|function[ _-]?calling)\b/i,
  // vLLM started without tool-call parsing: native tool requests are
  // refused outright ("auto" is the implied choice when tools are sent).
  // Matched without the quotes around "auto", which arrive JSON-escaped.
  /\btool choice requires --enable-auto-tool-choice\b/i,
];

/**
 * Request fields whose rejection means native tool calling itself is
 * unsupported. `tool_choice` and `parallel_tool_calls` are deliberately
 * absent: they are optional, Sky Code does not send them (see chat.ts), and
 * rejecting them says nothing about tool support.
 */
const TOOL_PROTOCOL_FIELDS: ReadonlySet<string> =
  new Set([
    "tools",
    "functions",
  ]);

/**
 * Extracts the parameter names from a LiteLLM UnsupportedParamsError
 * message ("... does not support parameters: ['tools', 'x'], ...").
 *
 * @param {string} body - Provider error body.
 * @returns {string[]} The listed parameter names, or an empty array when
 * the body contains no such list.
 */
function extractUnsupportedParams(
  body: string,
): string[] {
  const match =
    /does not support parameters:\s*\[([^\]]*)\]/i.exec(
      body,
    );

  if (!match) {
    return [];
  }

  return match[1]!
    .split(",")
    .map(
      (item) =>
        item
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .trim(),
    )
    .filter(
      (item) => item !== "",
    );
}

/**
 * Decides whether one HTTP failure is the provider refusing native tool
 * calling.
 *
 * @param {number} status - HTTP status code.
 * @param {string} body - Response body text.
 * @returns {boolean} True only for a 400/422 whose body says tools or
 * function calling are unsupported.
 *
 * Side effects: none.
 */
export function isNativeToolsRejection(
  status: number,
  body: string,
): boolean {
  if (
    status !== 400 &&
    status !== 422
  ) {
    return false;
  }

  const listedParams =
    extractUnsupportedParams(
      body,
    );

  if (listedParams.length > 0) {
    // A LiteLLM parameter list is authoritative about what was rejected: it
    // counts only if the list names a tool-protocol field itself.
    return listedParams.some(
      (param) =>
        TOOL_PROTOCOL_FIELDS.has(
          param,
        ),
    );
  }

  return TOOLS_UNSUPPORTED_PATTERNS.some(
    (pattern) =>
      pattern.test(body),
  );
}

/**
 * Decides whether a thrown error is the provider refusing native tool
 * calling.
 *
 * @param {unknown} error - Anything thrown by a native completion request.
 * @returns {boolean} True only for a failed native HTTP request
 * (NativeRequestHttpError, chat.ts) that isNativeToolsRejection() accepts.
 * Network failures (TypeError), timeouts (AbortError), and every other error
 * are false.
 *
 * Side effects: none.
 */
export function isNativeToolsUnsupportedError(
  error: unknown,
): error is NativeHttpFailure {
  return (
    isNativeHttpFailure(error) &&
    isNativeToolsRejection(
      error.status,
      error.body,
    )
  );
}

/**
 * One remembered native-tools rejection.
 */
export interface NativeRejection {
  /** Short, log-safe description of the provider's rejection. */
  reason: string;
  /** When it was observed. */
  observedAt: Date;
}

/**
 * In-memory record, for the current process only, of endpoint + model
 * combinations that demonstrably rejected native tool calling.
 */
export class NativeSupportCache {
  private rejections =
    new Map<string, NativeRejection>();

  /**
   * Builds the cache key for one endpoint and model.
   *
   * @param {string} endpoint - API base URL the request went to.
   * @param {string} model - Model identifier, exactly as configured.
   * @returns {string} The key.
   */
  private static key(
    endpoint: string,
    model: string,
  ): string {
    return `${endpoint.replace(/\/+$/, "")}\u0000${model.trim()}`;
  }

  /**
   * @param {string} endpoint - API base URL.
   * @param {string} model - Model identifier.
   * @returns {NativeRejection | undefined} The remembered rejection, if
   * this endpoint + model has refused native tool calling this session.
   */
  get(
    endpoint: string,
    model: string,
  ): NativeRejection | undefined {
    return this.rejections.get(
      NativeSupportCache.key(
        endpoint,
        model,
      ),
    );
  }

  /**
   * Records that this endpoint + model refused native tool calling.
   *
   * @param {string} endpoint - API base URL.
   * @param {string} model - Model identifier.
   * @param {string} reason - Short description of the rejection.
   * @returns {void} Nothing.
   *
   * Side effects: mutates this cache.
   */
  markRejected(
    endpoint: string,
    model: string,
    reason: string,
  ): void {
    this.rejections.set(
      NativeSupportCache.key(
        endpoint,
        model,
      ),
      {
        reason,
        observedAt: new Date(),
      },
    );
  }
}

/**
 * Builds a short, single-line description of a native-tools rejection for
 * diagnostics, so a long provider body does not flood the session log.
 *
 * @param {NativeHttpFailure} error - The qualifying rejection.
 * @returns {string} e.g. 'provider rejected native tools (HTTP 400: ...)'.
 */
export function describeNativeRejection(
  error: NativeHttpFailure,
): string {
  const oneLine =
    error.body
      .replace(/\s+/g, " ")
      .trim();

  const excerpt =
    oneLine.length > 240
      ? `${oneLine.slice(0, 240)}...`
      : oneLine;

  return `provider rejected native tools (HTTP ${error.status}: ${excerpt})`;
}
