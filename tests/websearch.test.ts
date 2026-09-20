import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  searchWeb,
} from "../src/websearch.ts";

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function stubFetchOnce(
  responseFactory: (request: CapturedRequest) => Response,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: unknown,
        init?: RequestInit,
      ) => {
        const request: CapturedRequest = {
          url: String(input),
          init,
        };

        requests.push(request);

        return responseFactory(request);
      },
    ),
  );

  return requests;
}

afterEach(
  () => {
    vi.unstubAllGlobals();
  },
);

describe(
  "searchWeb",
  () => {
    it(
      "queries the keyless You.com endpoint with no credential",
      async () => {
        const requests =
          stubFetchOnce(
            () =>
              new Response(
                JSON.stringify({
                  results: {
                    web: [
                      {
                        url: "https://example.com/a",
                        title: "Result A",
                        description: "Description A",
                      },
                    ],
                  },
                }),
                { status: 200 },
              ),
          );

        await searchWeb("example query");

        expect(requests).toHaveLength(1);

        const requestUrl =
          new URL(requests[0].url);

        expect(requestUrl.origin + requestUrl.pathname).toBe(
          "https://api.you.com/v1/agents/search",
        );
        expect(requestUrl.searchParams.get("query")).toBe(
          "example query",
        );

        const headers =
          new Headers(requests[0].init?.headers);

        expect(headers.get("Accept-Encoding")).toBe("identity");
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.has("X-API-Key")).toBe(false);
      },
    );

    it(
      "formats web and news results with titles, URLs, and snippets",
      async () => {
        stubFetchOnce(
          () =>
            new Response(
              JSON.stringify({
                results: {
                  web: [
                    {
                      url: "https://example.com/weather",
                      title: "Weather forecast",
                      snippets: ["Sunny with a high of 75F."],
                    },
                  ],
                  news: [
                    {
                      url: "https://example.com/news",
                      title: "Breaking story",
                      description: "A short description of the story.",
                    },
                  ],
                },
              }),
              { status: 200 },
            ),
        );

        const result =
          await searchWeb("weather");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Weather forecast");
        expect(result.output).toContain(
          "https://example.com/weather",
        );
        expect(result.output).toContain(
          "Sunny with a high of 75F.",
        );
        expect(result.output).toContain("Breaking story");
        expect(result.output).toContain("(news)");
      },
    );

    it(
      "caps formatted results at eight even when more are returned",
      async () => {
        const webResults =
          Array.from(
            { length: 10 },
            (_, index) => ({
              url: `https://example.com/${index}`,
              title: `Result ${index}`,
              description: `Description ${index}`,
            }),
          );

        stubFetchOnce(
          () =>
            new Response(
              JSON.stringify({
                results: { web: webResults },
              }),
              { status: 200 },
            ),
        );

        const result =
          await searchWeb("many results");

        expect(result.success).toBe(true);
        expect(result.output).toContain("Result 7");
        expect(result.output).not.toContain("Result 8");
      },
    );

    it(
      "reports success with an explanatory message when there are no results",
      async () => {
        stubFetchOnce(
          () =>
            new Response(
              JSON.stringify({ results: {} }),
              { status: 200 },
            ),
        );

        const result =
          await searchWeb("nothing found");

        expect(result.success).toBe(true);
        expect(result.output).toBe(
          "No information was found online for the search query.",
        );
      },
    );

    it(
      "reports quota exhaustion distinctly on a 402 response",
      async () => {
        stubFetchOnce(
          () =>
            new Response(
              "",
              { status: 402, statusText: "Payment Required" },
            ),
        );

        const result =
          await searchWeb("quota check");

        expect(result.success).toBe(false);
        expect(result.output.toLowerCase()).toContain("quota");
      },
    );

    it(
      "reports other non-2xx responses as a failure with the status code",
      async () => {
        stubFetchOnce(
          () =>
            new Response(
              "",
              { status: 500, statusText: "Internal Server Error" },
            ),
        );

        const result =
          await searchWeb("server error");

        expect(result.success).toBe(false);
        expect(result.output).toContain("500");
      },
    );

    it(
      "reports a network failure as a normal failed result rather than throwing",
      async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () => {
              throw new Error("getaddrinfo ENOTFOUND api.you.com");
            },
          ),
        );

        const result =
          await searchWeb("offline");

        expect(result.success).toBe(false);
        expect(result.output).toContain(
          "getaddrinfo ENOTFOUND api.you.com",
        );
      },
    );
  },
);
