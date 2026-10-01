import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  tmpdir,
} from "node:os";

import {
  join,
} from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type {
  PermissionMode,
} from "../src/config.ts";

import {
  createPhase1ToolHandlers,
} from "../src/toolhandlers.ts";

// Root bypasses file permission checks entirely, so a real EACCES failure
// cannot be exercised when the suite runs as root (as it does in some
// containers/CI, though not on the sky user this ships for). Matches the
// same convention used in tests/sky-md.test.ts.
const runningAsRoot =
  typeof process.getuid ===
    "function" &&
  process.getuid() === 0;

describe(
  "toolhandlers.ts document-generation handlers",
  () => {
    let testDirectory:
      string;

    let activeMode:
      PermissionMode;

    let promptCount:
      number;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-toolhandlers-",
            ),
          );

        activeMode =
          "default";

        promptCount = 0;
      },
    );

    afterEach(
      async () => {
        await rm(
          testDirectory,
          {
            recursive:
              true,
            force:
              true,
          },
        );
      },
    );

    function createHandlers(
      approvalResult:
        boolean = false,
    ) {
      return createPhase1ToolHandlers(
        testDirectory,
        {
          getMode:
            () =>
              activeMode,

          approvalPrompt:
            async () => {
              promptCount += 1;

              return approvalResult;
            },
        },
      );
    }

    describe(
      "permission modes",
      () => {
        it(
          "prompts before creating a document in default mode and does nothing when denied",
          async () => {
            const handlers =
              createHandlers(
                false,
              );

            const result =
              await handlers.create_docx(
                {
                  path:
                    "default.docx",
                  content:
                    "# Title",
                },
              );

            expect(
              promptCount,
            ).toBe(
              1,
            );

            expect(
              result.success,
            ).toBe(
              false,
            );

            await expect(
              access(
                join(
                  testDirectory,
                  "default.docx",
                ),
              ),
            ).rejects.toThrow();
          },
        );

        it(
          "creates the document in default mode once approval is granted",
          async () => {
            const handlers =
              createHandlers(
                true,
              );

            const result =
              await handlers.create_docx(
                {
                  path:
                    "approved.docx",
                  content:
                    "# Title",
                },
              );

            expect(
              promptCount,
            ).toBe(
              1,
            );

            expect(
              result.success,
            ).toBe(
              true,
            );

            await expect(
              access(
                join(
                  testDirectory,
                  "approved.docx",
                ),
              ),
            ).resolves.toBeUndefined();
          },
        );

        it(
          "auto-accepts document creation in auto-accept-edits mode without prompting",
          async () => {
            activeMode =
              "auto-accept-edits";

            const handlers =
              createHandlers(
                false,
              );

            const result =
              await handlers.create_xlsx(
                {
                  path:
                    "auto.xlsx",
                  sheets: [
                    {
                      name: "Sheet1",
                      rows: [
                        [
                          "x",
                        ],
                      ],
                    },
                  ],
                },
              );

            expect(
              promptCount,
            ).toBe(
              0,
            );

            expect(
              result.success,
            ).toBe(
              true,
            );

            await expect(
              access(
                join(
                  testDirectory,
                  "auto.xlsx",
                ),
              ),
            ).resolves.toBeUndefined();
          },
        );

        it(
          "describes every document tool without creating a file in plan mode",
          async () => {
            activeMode =
              "plan";

            const handlers =
              createHandlers();

            const results =
              await Promise.all([
                handlers.create_docx({
                  path:
                    "plan.docx",
                  content:
                    "# Title",
                }),

                handlers.create_xlsx({
                  path:
                    "plan.xlsx",
                  sheets: [
                    {
                      name: "Sheet1",
                      rows: [
                        [
                          "x",
                        ],
                      ],
                    },
                  ],
                }),

                handlers.create_pdf({
                  path:
                    "plan.pdf",
                  content:
                    "# Title",
                }),

                handlers.create_pptx({
                  path:
                    "plan.pptx",
                  slides: [
                    {
                      type: "title",
                      title:
                        "Plan Deck",
                    },
                  ],
                }),
              ]);

            expect(
              promptCount,
            ).toBe(
              0,
            );

            for (
              const result of
              results
            ) {
              expect(
                result.success,
              ).toBe(
                true,
              );

              expect(
                result.output,
              ).toContain(
                "Plan mode:",
              );
            }

            for (
              const fileName of
              [
                "plan.docx",
                "plan.xlsx",
                "plan.pdf",
                "plan.pptx",
              ]
            ) {
              await expect(
                access(
                  join(
                    testDirectory,
                    fileName,
                  ),
                ),
              ).rejects.toThrow();
            }
          },
        );

        it(
          "creates every document tool's output without prompting in bypass mode",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const results =
              await Promise.all([
                handlers.create_docx({
                  path:
                    "bypass.docx",
                  content:
                    "# Title",
                }),

                handlers.create_xlsx({
                  path:
                    "bypass.xlsx",
                  sheets: [
                    {
                      name: "Sheet1",
                      rows: [
                        [
                          "x",
                        ],
                      ],
                    },
                  ],
                }),

                handlers.create_pdf({
                  path:
                    "bypass.pdf",
                  content:
                    "# Title",
                }),

                handlers.create_pptx({
                  path:
                    "bypass.pptx",
                  slides: [
                    {
                      type: "title",
                      title:
                        "Bypass Deck",
                    },
                  ],
                }),
              ]);

            expect(
              promptCount,
            ).toBe(
              0,
            );

            for (
              const result of
              results
            ) {
              expect(
                result.success,
              ).toBe(
                true,
              );
            }

            for (
              const fileName of
              [
                "bypass.docx",
                "bypass.xlsx",
                "bypass.pdf",
                "bypass.pptx",
              ]
            ) {
              await expect(
                access(
                  join(
                    testDirectory,
                    fileName,
                  ),
                ),
              ).resolves.toBeUndefined();
            }
          },
        );
      },
    );

    describe(
      "result reporting",
      () => {
        it(
          "reports the resolved path and a human-readable size on success",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.create_docx(
                {
                  path:
                    "report.docx",
                  content:
                    "# Title",
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.output,
            ).toContain(
              join(
                testDirectory,
                "report.docx",
              ),
            );

            expect(
              result.output,
            ).toMatch(
              /\d+(\.\d+)? (bytes|KB)/,
            );
          },
        );

        it(
          "reports a clear failure when the destination already exists, without prompting again",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            await writeFile(
              join(
                testDirectory,
                "taken.pdf",
              ),
              "already here",
            );

            const result =
              await handlers.create_pdf(
                {
                  path:
                    "taken.pdf",
                  content:
                    "# New",
                },
              );

            expect(
              result.success,
            ).toBe(
              false,
            );

            expect(
              result.output,
            ).toContain(
              "already exists",
            );

            expect(
              result.output,
            ).toContain(
              "never overwrite",
            );
          },
        );

        it.skipIf(
          runningAsRoot,
        )(
          "reports a clear failure when the destination directory is not writable",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const readOnlyDirectory =
              join(
                testDirectory,
                "read-only",
              );

            await mkdir(
              readOnlyDirectory,
            );

            await chmod(
              readOnlyDirectory,
              0o500,
            );

            try {
              const result =
                await handlers.create_docx(
                  {
                    path:
                      "read-only/blocked.docx",
                    content:
                      "# Title",
                  },
                );

              expect(
                result.success,
              ).toBe(
                false,
              );

              expect(
                result.output,
              ).toBeTruthy();
            } finally {
              await chmod(
                readOnlyDirectory,
                0o700,
              );
            }
          },
        );
      },
    );

    describe(
      "verified result plumbing",
      () => {
        it(
          "reports verified: true for a successful create_docx, since it only resolves after its own structural validation passes",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.create_docx(
                {
                  path:
                    "verified.docx",
                  content:
                    "# Title",
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.verified,
            ).toBe(
              true,
            );
          },
        );

        it(
          "reports verified: true for a successful create_xlsx",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.create_xlsx(
                {
                  path:
                    "verified.xlsx",
                  sheets: [
                    {
                      name:
                        "Sheet1",
                      rows: [
                        [
                          "a",
                        ],
                      ],
                    },
                  ],
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.verified,
            ).toBe(
              true,
            );
          },
        );

        it(
          "reports verified: true for a successful create_pdf",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.create_pdf(
                {
                  path:
                    "verified.pdf",
                  content:
                    "# Title",
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.verified,
            ).toBe(
              true,
            );
          },
        );

        it(
          "reports verified: true for a successful create_pptx",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.create_pptx(
                {
                  path:
                    "verified.pptx",
                  slides: [
                    {
                      type:
                        "title",
                      title:
                        "Title",
                    },
                  ],
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.verified,
            ).toBe(
              true,
            );
          },
        );

        it(
          "never reports verified: true for a failed create_docx (permission denied)",
          async () => {
            activeMode =
              "default";

            const handlers =
              createHandlers(
                false,
              );

            const result =
              await handlers.create_docx(
                {
                  path:
                    "denied.docx",
                  content:
                    "# Title",
                },
              );

            expect(
              result.success,
            ).toBe(
              false,
            );

            expect(
              result.verified,
            ).not.toBe(
              true,
            );
          },
        );

        it(
          "never reports verified: true for write_file, which performs no independent post-condition check",
          async () => {
            activeMode =
              "bypass";

            const handlers =
              createHandlers();

            const result =
              await handlers.write_file(
                {
                  path:
                    "plain.txt",
                  content:
                    "hello",
                },
              );

            expect(
              result.success,
            ).toBe(
              true,
            );

            expect(
              result.verified,
            ).not.toBe(
              true,
            );
          },
        );
      },
    );
  },
);
