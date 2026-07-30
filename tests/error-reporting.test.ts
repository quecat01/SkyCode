import {
  describe,
  expect,
  it,
} from "vitest";

import {
  formatCliErrorReport,
} from "../src/error-reporting.ts";

describe(
  "clean CLI error reporting",
  () => {
    it(
      "formats every error with a consistent operation and reason",
      () => {
        expect(
          formatCliErrorReport(
            new Error(
              "Example failure",
            ),
            {
              operation:
                "History search",
            },
          ),
        ).toEqual([
          "History search failed.",
          "Reason: Example failure",
        ]);
      },
    );

    it(
      "explains permission failures",
      () => {
        expect(
          formatCliErrorReport(
            new Error(
              "EACCES: permission denied, open '/root/config.json'",
            ),
            {
              operation:
                "Configuration loading",
            },
          ),
        ).toEqual([
          "Configuration loading failed.",
          "Reason: EACCES: permission denied, open '/root/config.json'",
          "Next step: Check the file or directory ownership and permissions, then try again.",
        ]);
      },
    );

    it(
      "explains missing files and commands",
      () => {
        const report =
          formatCliErrorReport(
            new Error(
              "ENOENT: no such file or directory",
            ),
            {
              operation:
                "Catalog import",
            },
          );

        expect(
          report[2],
        ).toBe(
          "Next step: Check that the referenced file, directory, command, or catalog item exists.",
        );
      },
    );

    it(
      "explains connection and authentication failures",
      () => {
        expect(
          formatCliErrorReport(
            new TypeError(
              "fetch failed: ECONNREFUSED",
            ),
            {
              operation:
                "LiteLLM request",
            },
          )[2],
        ).toBe(
          "Next step: Check that the service is running, reachable, and configured with the correct address.",
        );

        expect(
          formatCliErrorReport(
            new Error(
              "HTTP 401: Unauthorized",
            ),
            {
              operation:
                "LiteLLM request",
            },
          )[2],
        ).toBe(
          "Next step: Check the configured credentials and confirm they are valid for this service.",
        );
      },
    );

    it(
      "explains malformed JSON and command usage errors",
      () => {
        expect(
          formatCliErrorReport(
            new Error(
              "Unable to parse catalog import file: Unexpected token",
            ),
            {
              operation:
                "Catalog import",
            },
          )[2],
        ).toBe(
          "Next step: Correct the referenced JSON or configuration file, then try again.",
        );

        expect(
          formatCliErrorReport(
            new Error(
              "Missing history search term. Usage: /history search <term>",
            ),
            {
              operation:
                "History command",
            },
          )[2],
        ).toBe(
          "Next step: Correct the command or configuration using the requirement shown above.",
        );
      },
    );

    it(
      "redacts credentials and normalizes multiline errors",
      () => {
        const report =
          formatCliErrorReport(
            new Error(
              [
                "Request failed",
                "Authorization: Bearer secret-token",
                "LITELLM_API_KEY=very-secret-key",
                "api_key: another-secret",
              ].join(
                "\n",
              ),
            ),
            {
              operation:
                "Model request",
            },
          );

        expect(
          report[1],
        ).toBe(
          "Reason: Request failed Authorization: Bearer [redacted] LITELLM_API_KEY=[redacted] api_key=[redacted]",
        );

        expect(
          report.join(
            "\n",
          ),
        ).not.toContain(
          "very-secret-key",
        );

        expect(
          report.join(
            "\n",
          ),
        ).not.toContain(
          "another-secret",
        );
      },
    );

    it(
      "uses an explicit next step when supplied",
      () => {
        expect(
          formatCliErrorReport(
            new Error(
              "Unclassified failure",
            ),
            {
              operation:
                "Plugin loading",

              nextStep:
                "Review the plugin manifest named in the error.",
            },
          ),
        ).toEqual([
          "Plugin loading failed.",
          "Reason: Unclassified failure",
          "Next step: Review the plugin manifest named in the error.",
        ]);
      },
    );

    it(
      "handles blank operations and empty error messages safely",
      () => {
        expect(
          formatCliErrorReport(
            new Error(
              "   ",
            ),
            {
              operation:
                "   ",
            },
          ),
        ).toEqual([
          "Operation failed.",
          "Reason: No error details were provided.",
        ]);
      },
    );
  },
);
