import {
  access,
  mkdtemp,
  readFile,
  rm,
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
  vi,
} from "vitest";

import {
  executeCatalogShellCommand,
  formatCatalogSkillsForPrompt,
  renderCatalogPromptTemplate,
  resolveCatalogCommand,
  selectEnabledCatalogSkills,
  validateCatalogPluginConflicts,
} from "../src/catalog-runtime.ts";

import type {
  CatalogSnapshot,
} from "../src/catalog.ts";

import type {
  ActivePluginSkill,
} from "../src/plugins.ts";

describe(
  "catalog command and skill runtime",
  () => {
    let testDirectory:
      string;

    beforeEach(
      async () => {
        testDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-catalog-runtime-",
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

    it(
      "renders the roadmap file placeholder using command arguments",
      () => {
        expect(
          renderCatalogPromptTemplate(
            "Please summarise {{file}} in plain language.",
            "src/index.ts",
          ),
        ).toBe(
          "Please summarise src/index.ts in plain language.",
        );
      },
    );

    it(
      "replaces every prompt placeholder with the supplied argument text",
      () => {
        expect(
          renderCatalogPromptTemplate(
            "Review {{file}} and explain {{target}}.",
            "src/catalog.ts",
          ),
        ).toBe(
          "Review src/catalog.ts and explain src/catalog.ts.",
        );
      },
    );

    it(
      "appends arguments as the user request when no placeholder exists",
      () => {
        expect(
          renderCatalogPromptTemplate(
            "Review the supplied code carefully.",
            "src/index.ts",
          ),
        ).toBe(
          [
            "Review the supplied code carefully.",
            "",
            "User request:",
            "src/index.ts",
          ].join(
            "\n",
          ),
        );
      },
    );

    it(
      "resolves a prompt catalog command without matching longer prefixes",
      () => {
        const commands = [
          {
            type:
              "command" as const,

            name:
              "/summarise",

            description:
              "Summarise a file",

            prompt:
              "Summarise {{file}}.",

            source:
              "catalog" as const,

            filePath:
              "/tmp/summarise.json",
          },
        ];

        expect(
          resolveCatalogCommand(
            "/summarise src/index.ts",
            commands,
          ),
        ).toMatchObject({
          kind:
            "prompt",

          commandArguments:
            "src/index.ts",

          conversationInput:
            "Summarise src/index.ts.",
        });

        expect(
          resolveCatalogCommand(
            "/summariser src/index.ts",
            commands,
          ),
        ).toBeNull();
      },
    );

    it(
      "runs a shell catalog command through plan mode without executing it",
      async () => {
        const markerPath =
          join(
            testDirectory,
            "marker.txt",
          );

        const resolved =
          resolveCatalogCommand(
            "/test-project",
            [
              {
                type:
                  "command",

                name:
                  "/test-project",

                description:
                  "Test the project",

                shell:
                  `touch ${JSON.stringify(
                    markerPath,
                  )}`,

                source:
                  "catalog",

                filePath:
                  "/tmp/test-project.json",
              },
            ],
          );

        expect(
          resolved?.kind,
        ).toBe(
          "shell",
        );

        if (
          !resolved ||
          resolved.kind !==
            "shell"
        ) {
          throw new Error(
            "Expected a resolved shell catalog command.",
          );
        }

        const result =
          await executeCatalogShellCommand(
            resolved,
            "plan",
            testDirectory,
            async () => {
              throw new Error(
                "Plan mode must not request approval.",
              );
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
          "but no command was executed",
        );

        await expect(
          access(
            markerPath,
          ),
        ).rejects.toThrow();
      },
    );

    it(
      "runs a shell catalog command through normal permission approval",
      async () => {
        const markerPath =
          join(
            testDirectory,
            "approved.txt",
          );

        const resolved =
          resolveCatalogCommand(
            "/create-marker",
            [
              {
                type:
                  "command",

                name:
                  "/create-marker",

                description:
                  "Create a marker",

                shell:
                  `printf approved > ${JSON.stringify(
                    markerPath,
                  )}`,

                source:
                  "catalog",

                filePath:
                  "/tmp/create-marker.json",
              },
            ],
          );

        if (
          !resolved ||
          resolved.kind !==
            "shell"
        ) {
          throw new Error(
            "Expected a resolved shell catalog command.",
          );
        }

        const approvalPrompt =
          vi.fn(
            async () =>
              true,
          );

        const result =
          await executeCatalogShellCommand(
            resolved,
            "default",
            testDirectory,
            approvalPrompt,
          );

        expect(
          approvalPrompt,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          result.success,
        ).toBe(
          true,
        );

        expect(
          await readFile(
            markerPath,
            "utf8",
          ),
        ).toBe(
          "approved",
        );
      },
    );

    it(
      "rejects additional arguments for a static shell command",
      () => {
        expect(
          () =>
            resolveCatalogCommand(
              "/test-project extra",
              [
                {
                  type:
                    "command",

                  name:
                    "/test-project",

                  description:
                    "Test the project",

                  shell:
                    "npm test",

                  source:
                    "catalog",

                  filePath:
                    "/tmp/test-project.json",
                },
              ],
            ),
        ).toThrow(
          'Catalog shell command "/test-project" does not accept additional arguments',
        );
      },
    );

    it(
      "selects enabled skills and formats their system-prompt additions",
      () => {
        const skills = [
          {
            type:
              "skill" as const,

            name:
              "python-style",

            description:
              "Apply Python style",

            systemPromptAddition:
              "Always follow PEP 8.",

            source:
              "catalog" as const,

            filePath:
              "/tmp/python-style.json",
          },
          {
            type:
              "skill" as const,

            name:
              "typescript-style",

            description:
              "Apply TypeScript style",

            systemPromptAddition:
              "Use strict TypeScript.",

            source:
              "catalog" as const,

            filePath:
              "/tmp/typescript-style.json",
          },
        ];

        const activeSkills =
          selectEnabledCatalogSkills(
            skills,
            new Set([
              "python-style",
            ]),
          );

        expect(
          activeSkills.map(
            (
              skill,
            ) =>
              skill.name,
          ),
        ).toEqual([
          "python-style",
        ]);

        expect(
          formatCatalogSkillsForPrompt(
            activeSkills,
          ),
        ).toEqual([
          "",
          "Active custom catalog skills:",
          "- python-style: Apply Python style",
          "  Instructions: Always follow PEP 8.",
        ]);

        expect(
          () =>
            selectEnabledCatalogSkills(
              skills,
              new Set([
                "missing-skill",
              ]),
            ),
        ).toThrow(
          'Unknown catalog skill "missing-skill"',
        );
      },
    );

    it(
      "rejects command and skill conflicts with plugin skills",
      () => {
        const catalog:
          CatalogSnapshot = {
          directory:
            "/tmp/catalog",

          commands: [
            {
              type:
                "command",

              name:
                "/review",

              description:
                "Catalog review",

              prompt:
                "Review the code.",

              source:
                "catalog",

              filePath:
                "/tmp/catalog/review.json",
            },
          ],

          skills: [
            {
              type:
                "skill",

              name:
                "python-style",

              description:
                "Python style",

              systemPromptAddition:
                "Follow PEP 8.",

              source:
                "catalog",

              filePath:
                "/tmp/catalog/python-style.json",
            },
          ],

          items: [],
        };

        const pluginSkill:
          ActivePluginSkill = {
          name:
            "plugin-review",

          description:
            "Plugin review",

          prompt:
            "Review code.",

          command:
            "/review",

          pluginName:
            "review-plugin",

          pluginDirectory:
            "/tmp/review-plugin",

          source:
            "project",
        };

        expect(
          () =>
            validateCatalogPluginConflicts(
              catalog,
              [
                pluginSkill,
              ],
            ),
        ).toThrow(
          'Catalog command "/review" conflicts with plugin "review-plugin"',
        );

        expect(
          () =>
            validateCatalogPluginConflicts(
              {
                ...catalog,

                commands: [],

                skills: [
                  {
                    ...catalog
                      .skills[0],

                    name:
                      "plugin-review",
                  },
                ],
              },
              [
                pluginSkill,
              ],
            ),
        ).toThrow(
          'Catalog skill "plugin-review" conflicts with plugin "review-plugin"',
        );
      },
    );
  },
);
