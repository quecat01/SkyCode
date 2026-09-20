import {
  describe,
  expect,
  it,
} from "vitest";

import {
  fetchWebPage,
  isBlockedAddress,
  WebFetchNetworkError,
  type PerformRequestOptions,
  type PerformRequestResult,
  type WebFetchDependencies,
} from "../src/webfetch.ts";

function htmlResponse(
  body: string,
  overrides: Partial<PerformRequestResult> = {},
): PerformRequestResult {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(body, "utf8"),
    truncated: false,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<WebFetchDependencies> = {},
): WebFetchDependencies {
  return {
    lookupHost: async () => [
      { address: "93.184.216.34", family: 4 },
    ],
    performRequest: async () =>
      htmlResponse(
        "<html><head><title>Example</title></head><body><p>Hello world.</p></body></html>",
      ),
    ...overrides,
  };
}

describe(
  "isBlockedAddress",
  () => {
    it.each([
      ["127.0.0.1", true],
      ["127.255.255.255", true],
      ["10.0.0.5", true],
      ["172.16.5.5", true],
      ["172.31.255.255", true],
      ["192.168.1.1", true],
      ["169.254.169.254", true],
      ["100.64.0.1", true],
      ["0.0.0.0", true],
      ["224.0.0.1", true],
      ["255.255.255.255", true],
      ["8.8.8.8", false],
      ["93.184.216.34", false],
      ["1.1.1.1", false],
    ])(
      "classifies IPv4 %s as blocked=%s",
      (address, expected) => {
        expect(
          isBlockedAddress(address),
        ).toBe(expected);
      },
    );

    it.each([
      ["::1", true],
      ["::", true],
      ["fe80::1", true],
      ["fc00::1", true],
      ["fdff::1", true],
      ["ff02::1", true],
      ["::ffff:127.0.0.1", true],
      ["::ffff:10.0.0.5", true],
      ["2001:4860:4860::8888", false],
      ["::ffff:8.8.8.8", false],
    ])(
      "classifies IPv6 %s as blocked=%s",
      (address, expected) => {
        expect(
          isBlockedAddress(address),
        ).toBe(expected);
      },
    );

    it(
      "fails closed on an unparseable address",
      () => {
        expect(
          isBlockedAddress("not-an-ip"),
        ).toBe(true);
      },
    );
  },
);

describe(
  "fetchWebPage",
  () => {
    it(
      "fetches and extracts readable text from an allowed HTTPS URL",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/article",
            makeDeps(),
          );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Title: Example");
        expect(result.output).toContain("Hello world.");
        expect(result.output).toContain("Status: 200");
        expect(result.output).toContain(
          "untrusted data from the public web",
        );
      },
    );

    it(
      "strips script and style content before extracting text",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/article",
            makeDeps({
              performRequest: async () =>
                htmlResponse(
                  "<html><body><script>stealSecrets()</script><style>.x{color:red}</style><p>Visible text.</p></body></html>",
                ),
            }),
          );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Visible text.");
        expect(result.output).not.toContain("stealSecrets");
        expect(result.output).not.toContain("color:red");
      },
    );

    it(
      "rejects an empty URL as invalid_input without any network call",
      async () => {
        let lookupCalled = false;

        const result =
          await fetchWebPage(
            "",
            makeDeps({
              lookupHost: async () => {
                lookupCalled = true;
                return [];
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[invalid_input]");
        expect(lookupCalled).toBe(false);
      },
    );

    it(
      "rejects a URL over the maximum length as invalid_input",
      async () => {
        const longUrl =
          `https://example.com/${"a".repeat(2100)}`;

        const result =
          await fetchWebPage(
            longUrl,
            makeDeps(),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[invalid_input]");
      },
    );

    it.each([
      "http://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com/file",
      "data:text/html,<script>1</script>",
    ])(
      "blocks disallowed scheme in %s before any DNS lookup",
      async (url) => {
        let lookupCalled = false;

        const result =
          await fetchWebPage(
            url,
            makeDeps({
              lookupHost: async () => {
                lookupCalled = true;
                return [
                  { address: "93.184.216.34", family: 4 },
                ];
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[blocked_url]");
        expect(lookupCalled).toBe(false);
      },
    );

    it(
      "blocks a URL with embedded credentials",
      async () => {
        const result =
          await fetchWebPage(
            "https://user:pass@example.com/",
            makeDeps(),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[blocked_url]");
      },
    );

    it(
      "blocks a hostname that resolves to a loopback address",
      async () => {
        let requestCalled = false;

        const result =
          await fetchWebPage(
            "https://internal.example.com/",
            makeDeps({
              lookupHost: async () => [
                { address: "127.0.0.1", family: 4 },
              ],
              performRequest: async () => {
                requestCalled = true;
                return htmlResponse("<html></html>");
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[blocked_url]");
        expect(requestCalled).toBe(false);
      },
    );

    it(
      "blocks a hostname when any one of several resolved addresses is unsafe",
      async () => {
        const result =
          await fetchWebPage(
            "https://multi.example.com/",
            makeDeps({
              lookupHost: async () => [
                { address: "93.184.216.34", family: 4 },
                { address: "169.254.169.254", family: 4 },
              ],
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[blocked_url]");
      },
    );

    it(
      "reports network_unavailable when DNS resolution fails",
      async () => {
        const result =
          await fetchWebPage(
            "https://nowhere.example.com/",
            makeDeps({
              lookupHost: async () => {
                throw new Error("getaddrinfo ENOTFOUND");
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[network_unavailable]");
      },
    );

    it(
      "follows a redirect to a safe URL and reports the final URL",
      async () => {
        let callCount = 0;

        const result =
          await fetchWebPage(
            "https://example.com/old",
            makeDeps({
              performRequest: async () => {
                callCount += 1;

                if (callCount === 1) {
                  return {
                    statusCode: 302,
                    headers: {
                      location: "https://example.com/new",
                    },
                    body: Buffer.alloc(0),
                    truncated: false,
                  };
                }

                return htmlResponse(
                  "<html><head><title>New page</title></head><body>Moved content.</body></html>",
                );
              },
            }),
          );

        expect(result.success).toBe(true);
        expect(result.output).toContain(
          "Final URL: https://example.com/new",
        );
        expect(result.output).toContain("Moved content.");
      },
    );

    it(
      "revalidates a redirect target and blocks it if unsafe",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/old",
            makeDeps({
              lookupHost: async (hostname) =>
                hostname === "internal.example.com"
                  ? [{ address: "10.0.0.5", family: 4 }]
                  : [{ address: "93.184.216.34", family: 4 }],
              performRequest: async (
                options: PerformRequestOptions,
              ) => {
                if (options.servername === "example.com") {
                  return {
                    statusCode: 302,
                    headers: {
                      location: "https://internal.example.com/",
                    },
                    body: Buffer.alloc(0),
                    truncated: false,
                  };
                }

                throw new Error(
                  "should not reach the redirect target",
                );
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[blocked_url]");
      },
    );

    it(
      "gives up after too many redirects",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/loop",
            makeDeps({
              performRequest: async () => ({
                statusCode: 302,
                headers: { location: "https://example.com/loop" },
                body: Buffer.alloc(0),
                truncated: false,
              }),
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[http_error]");
        expect(result.output.toLowerCase()).toContain("redirect");
      },
    );

    it(
      "reports http_error for a non-2xx, non-redirect status",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/missing",
            makeDeps({
              performRequest: async () => ({
                statusCode: 404,
                headers: { "content-type": "text/html" },
                body: Buffer.from("<html>Not found</html>"),
                truncated: false,
              }),
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[http_error]");
        expect(result.output).toContain("404");
      },
    );

    it(
      "reports unsupported_content_type for a PDF response",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/file.pdf",
            makeDeps({
              performRequest: async () => ({
                statusCode: 200,
                headers: { "content-type": "application/pdf" },
                body: Buffer.from("%PDF-1.4"),
                truncated: false,
              }),
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[unsupported_content_type]");
        expect(result.output.toLowerCase()).toContain("pdf");
      },
    );

    it(
      "reports empty_page when the extracted text is empty",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/blank",
            makeDeps({
              performRequest: async () =>
                htmlResponse(
                  "<html><head><style>.x{}</style></head><body>   </body></html>",
                ),
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[empty_page]");
      },
    );

    it(
      "flags truncation when the response body was byte-capped",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/big",
            makeDeps({
              performRequest: async () =>
                htmlResponse(
                  "<html><body>Some content.</body></html>",
                  { truncated: true },
                ),
            }),
          );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Truncated: yes");
      },
    );

    it(
      "flags truncation when extracted text exceeds the character budget",
      async () => {
        const longText =
          "word ".repeat(3000);

        const result =
          await fetchWebPage(
            "https://example.com/long",
            makeDeps({
              performRequest: async () =>
                htmlResponse(
                  `<html><body>${longText}</body></html>`,
                ),
            }),
          );

        expect(result.success).toBe(true);
        expect(result.output).toContain("Truncated: yes");
      },
    );

    it(
      "reports timeout distinctly from a generic network failure",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/slow",
            makeDeps({
              performRequest: async () => {
                throw new WebFetchNetworkError(
                  "The request timed out.",
                  "timeout",
                );
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[timeout]");
      },
    );

    it(
      "reports a connection failure as network_unavailable",
      async () => {
        const result =
          await fetchWebPage(
            "https://example.com/unreachable",
            makeDeps({
              performRequest: async () => {
                throw new WebFetchNetworkError(
                  "connect ECONNREFUSED",
                  "network",
                );
              },
            }),
          );

        expect(result.success).toBe(false);
        expect(result.output).toContain("[network_unavailable]");
      },
    );
  },
);
