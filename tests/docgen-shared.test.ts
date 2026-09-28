import {
  mkdir,
  mkdtemp,
  readFile,
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

import {
  DestinationExistsError,
  createDocumentFile,
  describeCreateDocumentPlan,
  formatFileSize,
  resolveNewDocumentPath,
} from "../src/docgen/shared.ts";

describe(
  "docgen/shared.ts",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-docgen-shared-",
            ),
          );
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

    describe(
      "resolveNewDocumentPath",
      () => {
        it(
          "resolves a relative path against the working directory",
          async () => {
            const resolved =
              await resolveNewDocumentPath(
                "report.docx",
                testDirectory,
              );

            expect(
              resolved,
            ).toBe(
              join(
                testDirectory,
                "report.docx",
              ),
            );
          },
        );

        it(
          "throws DestinationExistsError when a file already exists at the path",
          async () => {
            const existingPath =
              join(
                testDirectory,
                "existing.docx",
              );

            await writeFile(
              existingPath,
              "already here",
            );

            await expect(
              resolveNewDocumentPath(
                "existing.docx",
                testDirectory,
              ),
            ).rejects.toThrow(
              DestinationExistsError,
            );
          },
        );

        it(
          "throws DestinationExistsError when a directory already exists at the path",
          async () => {
            const existingDir =
              join(
                testDirectory,
                "existing-dir",
              );

            await mkdir(
              existingDir,
            );

            await expect(
              resolveNewDocumentPath(
                "existing-dir",
                testDirectory,
              ),
            ).rejects.toThrow(
              DestinationExistsError,
            );
          },
        );

        it(
          "does not reject a path whose parent directory does not exist yet",
          async () => {
            const resolved =
              await resolveNewDocumentPath(
                "nested/new-report.docx",
                testDirectory,
              );

            expect(
              resolved,
            ).toBe(
              join(
                testDirectory,
                "nested/new-report.docx",
              ),
            );
          },
        );
      },
    );

    describe(
      "createDocumentFile",
      () => {
        it(
          "writes the built buffer, verifies it, and returns its resolved path and size",
          async () => {
            const result =
              await createDocumentFile(
                {
                  inputPath:
                    "out.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () =>
                      Buffer.from(
                        "hello document",
                      ),
                },
              );

            expect(
              result.resolvedPath,
            ).toBe(
              join(
                testDirectory,
                "out.bin",
              ),
            );

            expect(
              result.sizeBytes,
            ).toBe(
              Buffer.byteLength(
                "hello document",
              ),
            );

            expect(
              (
                await readFile(
                  result.resolvedPath,
                  "utf8",
                )
              ),
            ).toBe(
              "hello document",
            );
          },
        );

        it(
          "creates missing parent directories",
          async () => {
            const result =
              await createDocumentFile(
                {
                  inputPath:
                    "a/b/c/out.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () =>
                      Buffer.from(
                        "nested",
                      ),
                },
              );

            expect(
              await readFile(
                result.resolvedPath,
                "utf8",
              ),
            ).toBe(
              "nested",
            );
          },
        );

        it(
          "rejects when the destination already exists and does not call build",
          async () => {
            await writeFile(
              join(
                testDirectory,
                "taken.bin",
              ),
              "original",
            );

            let buildCalled =
              false;

            await expect(
              createDocumentFile(
                {
                  inputPath:
                    "taken.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () => {
                      buildCalled =
                        true;

                      return Buffer.from(
                        "new",
                      );
                    },
                },
              ),
            ).rejects.toThrow(
              DestinationExistsError,
            );

            expect(
              buildCalled,
            ).toBe(
              false,
            );

            expect(
              await readFile(
                join(
                  testDirectory,
                  "taken.bin",
                ),
                "utf8",
              ),
            ).toBe(
              "original",
            );
          },
        );

        it(
          "propagates a build failure without writing any file",
          async () => {
            await expect(
              createDocumentFile(
                {
                  inputPath:
                    "never-written.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () => {
                      throw new Error(
                        "build blew up",
                      );
                    },
                },
              ),
            ).rejects.toThrow(
              "build blew up",
            );

            await expect(
              readFile(
                join(
                  testDirectory,
                  "never-written.bin",
                ),
              ),
            ).rejects.toThrow();
          },
        );

        it(
          "removes the file and propagates the error when validation fails",
          async () => {
            const targetPath =
              join(
                testDirectory,
                "invalid.bin",
              );

            await expect(
              createDocumentFile(
                {
                  inputPath:
                    "invalid.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () =>
                      Buffer.from(
                        "looks fine",
                      ),
                  validate:
                    async () => {
                      throw new Error(
                        "structural check failed",
                      );
                    },
                },
              ),
            ).rejects.toThrow(
              "structural check failed",
            );

            await expect(
              readFile(
                targetPath,
              ),
            ).rejects.toThrow();
          },
        );

        it(
          "rejects a buffer that builds to zero bytes",
          async () => {
            await expect(
              createDocumentFile(
                {
                  inputPath:
                    "empty.bin",
                  workingDirectory:
                    testDirectory,
                  build:
                    async () =>
                      Buffer.alloc(
                        0,
                      ),
                },
              ),
            ).rejects.toThrow(
              "empty",
            );
          },
        );
      },
    );

    describe(
      "formatFileSize",
      () => {
        it(
          "renders sizes under 1024 bytes as a plain byte count",
          () => {
            expect(
              formatFileSize(
                842,
              ),
            ).toBe(
              "842 bytes",
            );
          },
        );

        it(
          "renders sizes at or above 1024 bytes in kilobytes with one decimal",
          () => {
            expect(
              formatFileSize(
                1024,
              ),
            ).toBe(
              "1.0 KB",
            );

            expect(
              formatFileSize(
                14540,
              ),
            ).toBe(
              "14.2 KB",
            );
          },
        );
      },
    );

    describe(
      "describeCreateDocumentPlan",
      () => {
        it(
          "describes the destination without mentioning an existing file when none exists",
          () => {
            const description =
              describeCreateDocumentPlan(
                "new-report.pdf",
                testDirectory,
                "PDF",
              );

            expect(
              description,
            ).toBe(
              `Plan mode: Sky Code would create a PDF file at ${join(
                testDirectory,
                "new-report.pdf",
              )}, but no file was written.`,
            );
          },
        );

        it(
          "notes that an existing destination would fail outside plan mode",
          async () => {
            await writeFile(
              join(
                testDirectory,
                "taken.pdf",
              ),
              "already here",
            );

            const description =
              describeCreateDocumentPlan(
                "taken.pdf",
                testDirectory,
                "PDF",
              );

            expect(
              description,
            ).toContain(
              "A file already exists at that path",
            );

            expect(
              description,
            ).toContain(
              "never overwrite an existing file",
            );
          },
        );

        it(
          "is synchronous and returns a plain string, not a Promise",
          () => {
            const result =
              describeCreateDocumentPlan(
                "sync-check.xlsx",
                testDirectory,
                "XLSX",
              );

            expect(
              result,
            ).not.toBeInstanceOf(
              Promise,
            );

            expect(
              typeof result,
            ).toBe(
              "string",
            );
          },
        );
      },
    );
  },
);
