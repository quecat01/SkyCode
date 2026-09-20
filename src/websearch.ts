/**
 * Web search integration for the Sky Code web_search tool.
 *
 * Queries You.com's keyless public search endpoint directly with the Node
 * built-in fetch. No API key or other credential is required or accepted,
 * consistent with Sky Code's locked decision restricting client credentials to
 * LITELLM_API_URL/LITELLM_API_KEY.
 */
import type {
  ToolExecutionResult,
} from "./tools.js";

import {
  formatError,
} from "./utils.js";

/**
 * Keyless You.com search endpoint used for every web_search request.
 */
const YOU_SEARCH_URL =
  "https://api.you.com/v1/agents/search";

/**
 * Maximum number of results requested from the search provider.
 */
const REQUESTED_RESULT_COUNT = 10;

/**
 * Maximum number of results included in the formatted tool output, keeping
 * responses compact for the model regardless of how many the provider returns.
 */
const MAX_FORMATTED_RESULTS = 8;

/**
 * Maximum length of a single result's snippet text before truncation.
 */
const MAX_SNIPPET_LENGTH = 300;

/**
 * One normalized search result, regardless of whether it originated from the
 * provider's web or news result list.
 */
interface NormalizedSearchResult {
  /** Result title as reported by the provider. */
  title: string;
  /** Destination URL for the result. */
  url: string;
  /** Short descriptive text for the result, truncated for display. */
  snippet: string;
  /** True when the result came from the provider's news results. */
  isNews: boolean;
}

/**
 * Shape of one raw result entry returned by the You.com search endpoint.
 *
 * All fields are optional because the provider does not guarantee every field
 * is present for every result.
 */
interface RawYouSearchResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

/**
 * Shape of the parsed JSON response body returned by the You.com search
 * endpoint.
 */
interface YouSearchResponseBody {
  results?: {
    web?: RawYouSearchResult[];
    news?: RawYouSearchResult[];
  };
}

/**
 * Collapses whitespace and truncates text to at most maxLength characters.
 *
 * @param {string} text - Raw text to normalize.
 * @param {number} maxLength - Maximum length of the returned string.
 * @returns {string} Whitespace-collapsed, length-limited text.
 */
function truncateSnippet(
  text: string,
  maxLength: number,
): string {
  const collapsed =
    text
      .replace(/\s+/g, " ")
      .trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxLength).trimEnd()}...`;
}

/**
 * Converts one raw provider result into a NormalizedSearchResult.
 *
 * A result missing both a title and a URL is not useful to show, so this
 * returns null for the caller to filter out.
 *
 * @param {RawYouSearchResult} raw - Raw result entry from the parsed response.
 * @param {boolean} isNews - True when raw came from the news result list.
 * @returns {NormalizedSearchResult | null} Normalized result, or null when the
 * entry has neither a title nor a URL.
 */
function normalizeResult(
  raw: RawYouSearchResult,
  isNews: boolean,
): NormalizedSearchResult | null {
  const title =
    raw.title?.trim() ?? "";
  const url =
    raw.url?.trim() ?? "";

  if (title.length === 0 && url.length === 0) {
    return null;
  }

  const snippetSource =
    Array.isArray(raw.snippets) &&
      raw.snippets.length > 0
      ? raw.snippets.join(" ")
      : raw.description ?? "";

  return {
    title,
    url,
    snippet:
      truncateSnippet(
        snippetSource,
        MAX_SNIPPET_LENGTH,
      ),
    isNews,
  };
}

/**
 * Formats normalized results as plain, numbered text for the model.
 *
 * @param {NormalizedSearchResult[]} results - Results to format, already
 * capped to the maximum count that should be shown.
 * @returns {string} Human- and model-readable formatted result list.
 */
function formatResults(
  results: NormalizedSearchResult[],
): string {
  return results
    .map(
      (result, index) => {
        const lines = [
          `${index + 1}. ${result.title || result.url}${
            result.isNews ? " (news)" : ""
          }`,
        ];

        if (result.url.length > 0) {
          lines.push(
            `   ${result.url}`,
          );
        }

        if (result.snippet.length > 0) {
          lines.push(
            `   ${result.snippet}`,
          );
        }

        return lines.join("\n");
      },
    )
    .join("\n\n");
}

/**
 * Searches the web for the given query using You.com's keyless search
 * endpoint and returns a formatted result summary.
 *
 * Every failure mode (network error, non-2xx response, unparseable body) is
 * converted into a normal failed ToolExecutionResult rather than thrown, so
 * the model receives and can react to the failure. A quota-exhausted response
 * (402) is reported distinctly from other failures since it reflects the
 * shared free tier's daily limit rather than a genuine search error.
 *
 * @param {string} query - Search query text supplied by the model.
 * @returns {Promise<ToolExecutionResult>} Formatted search results, an
 * explanation that no results were found, or a failure explanation.
 *
 * Side effect: performs an outbound HTTPS request to api.you.com.
 */
export async function searchWeb(
  query: string,
): Promise<ToolExecutionResult> {
  const searchUrl =
    new URL(YOU_SEARCH_URL);

  searchUrl.searchParams.set(
    "query",
    query,
  );
  searchUrl.searchParams.set(
    "count",
    String(REQUESTED_RESULT_COUNT),
  );

  let response: Response;

  try {
    response =
      await fetch(
        searchUrl.toString(),
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            // The keyless endpoint can advertise gzip with body bytes that
            // Node's fetch decoder rejects; requesting identity encoding
            // avoids that failure entirely.
            "Accept-Encoding": "identity",
          },
        },
      );
  } catch (error) {
    return {
      success: false,
      output:
        `Web search failed: ${formatError(error)}`,
    };
  }

  if (!response.ok) {
    if (response.status === 402) {
      return {
        success: false,
        output:
          "Web search is temporarily unavailable: the shared free search quota has been exhausted for today.",
      };
    }

    return {
      success: false,
      output:
        `Web search failed: ${response.status} ${response.statusText}`,
    };
  }

  let body: YouSearchResponseBody;

  try {
    body =
      (await response.json()) as YouSearchResponseBody;
  } catch (error) {
    return {
      success: false,
      output:
        `Web search failed: could not parse the search response (${formatError(error)})`,
    };
  }

  const webResults =
    Array.isArray(body.results?.web)
      ? body.results!.web!
      : [];
  const newsResults =
    Array.isArray(body.results?.news)
      ? body.results!.news!
      : [];

  const normalized =
    [
      ...webResults.map(
        (result) =>
          normalizeResult(result, false),
      ),
      ...newsResults.map(
        (result) =>
          normalizeResult(result, true),
      ),
    ].filter(
      (result): result is NormalizedSearchResult =>
        result !== null,
    );

  if (normalized.length === 0) {
    return {
      success: true,
      output:
        "No information was found online for the search query.",
    };
  }

  return {
    success: true,
    output:
      formatResults(
        normalized.slice(
          0,
          MAX_FORMATTED_RESULTS,
        ),
      ),
  };
}
