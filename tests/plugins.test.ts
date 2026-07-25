import {
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

import {
  formatPluginSkillsForPrompt,
  loadPlugins,
  mergePluginMcpServers,
  mergePluginSkills,
  resolvePluginSkillCommand,
} from "../src/plugins.ts";

describe(
  "plugin loading",
  () => {
    let rootDirectory:
      string;

    let projectDirectory:
      string;

    let homeDirectory:
      string;

    beforeEach(
      async () => {
        rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-plugins-",
            ),
          );

        projectDirectory =
          join(
            rootDirectory,
            "project",
          );

        homeDirectory =
          join(
            rootDirectory,
            "home",
          );

        await mkdir(
          projectDirectory,
          {
            recursive:
              true,
          },
        );

        await mkdir(
          homeDirectory,
          {
            recursive:
              true,
          },
        );
      },
    );

    afterEach(
      async () => {
        await rm(
          rootDirectory,
          {
            recursive:
              true,
            force:
              true,
          },
        );
      },
    );

    async function createPlugin(
      pluginDirectory:
        string,
      manifest:
        unknown,
    ): Promise<void> {
      await mkdir(
        pluginDirectory,
        {
          recursive:
            true,
        },
      );

      await writeFile(
        join(
          pluginDirectory,
          "plugin.json",
        ),
        JSON.stringify(
          manifest,
          null,
          2,
        ),
        "utf8",
      );
    }

    function createManifest(
      name: string,
    ) {
      return {
        name,
        version:
          "1.0.0",
        description:
          `${name} description`,
        skills: [
          {
            name:
              `${name}-skill`,
            description:
              `${name} skill description`,
            prompt:
              `Follow the ${name} skill instructions.`,
          },
        ],
        agents: [],
        hooks: [],
        mcpServers: [],
      };
    }

    it(
      "loads the current project's direct plugin",
      async () => {
        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          createManifest(
            "project-plugin",
          ),
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          plugins,
        ).toHaveLength(1);

        expect(
          plugins[0],
        ).toMatchObject({
          name:
            "project-plugin",
          source:
            "project",
          skills: [
            {
              name:
                "project-plugin-skill",
              command:
                "/project-plugin-skill",
            },
          ],
        });
      },
    );

    it(
      "loads nested global plugins",
      async () => {
        await createPlugin(
          join(
            homeDirectory,
            ".sky-code",
            "plugins",
            "example",
            ".sky-code-plugin",
          ),
          createManifest(
            "global-plugin",
          ),
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          plugins.map(
            (
              plugin,
            ) =>
              [
                plugin.name,
                plugin.source,
              ],
          ),
        ).toEqual([
          [
            "global-plugin",
            "global",
          ],
        ]);
      },
    );

    it(
      "loads plugins from a relative configured directory",
      async () => {
        await createPlugin(
          join(
            projectDirectory,
            "extra-plugins",
            "example",
            ".sky-code-plugin",
          ),
          createManifest(
            "configured-plugin",
          ),
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
            pluginDirs: [
              "./extra-plugins",
            ],
          });

        expect(
          plugins.map(
            (
              plugin,
            ) =>
              [
                plugin.name,
                plugin.source,
              ],
          ),
        ).toEqual([
          [
            "configured-plugin",
            "configured",
          ],
        ]);
      },
    );

    it(
      "uses the skill name as the default command",
      async () => {
        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          createManifest(
            "default-command",
          ),
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          plugins[0]?.skills[0],
        ).toMatchObject({
          name:
            "default-command-skill",
          command:
            "/default-command-skill",
        });
      },
    );

    it(
      "accepts and merges a custom skill command",
      async () => {
        const manifest =
          createManifest(
            "review-plugin",
          );

        manifest.skills[0] = {
          name:
            "review-code",
          description:
            "Review code",
          prompt:
            "Review the supplied code.",
          command:
            "/review",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const skills =
          mergePluginSkills(
            plugins,
          );

        expect(
          skills,
        ).toEqual([
          expect.objectContaining({
            name:
              "review-code",
            command:
              "/review",
            pluginName:
              "review-plugin",
            source:
              "project",
          }),
        ]);
      },
    );

    it(
      "rejects invalid skill commands",
      async () => {
        const manifest =
          createManifest(
            "invalid-command-plugin",
          );

        manifest.skills[0] = {
          name:
            "invalid-command",
          description:
            "Invalid command",
          prompt:
            "This command is invalid.",
          command:
            "missing-slash",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        await expect(
          loadPlugins({
            projectDirectory,
            homeDirectory,
          }),
        ).rejects.toThrow(
          'must begin with "/"',
        );
      },
    );

    it(
      "rejects manifests missing a required array",
      async () => {
        const invalidManifest =
          createManifest(
            "invalid-plugin",
          );

        delete (
          invalidManifest as {
            hooks?: unknown;
          }
        ).hooks;

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          invalidManifest,
        );

        await expect(
          loadPlugins({
            projectDirectory,
            homeDirectory,
          }),
        ).rejects.toThrow(
          "hooks must be an array",
        );
      },
    );

    it(
      "rejects duplicate plugin names",
      async () => {
        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          createManifest(
            "duplicate-plugin",
          ),
        );

        await createPlugin(
          join(
            homeDirectory,
            ".sky-code",
            "plugins",
            "duplicate",
            ".sky-code-plugin",
          ),
          createManifest(
            "duplicate-plugin",
          ),
        );

        await expect(
          loadPlugins({
            projectDirectory,
            homeDirectory,
          }),
        ).rejects.toThrow(
          'Duplicate plugin name "duplicate-plugin"',
        );
      },
    );

    it(
      "rejects plugin skills that use a built-in command",
      async () => {
        const manifest =
          createManifest(
            "reserved-command-plugin",
          );

        manifest.skills[0] = {
          name:
            "change-model",
          description:
            "Change the model",
          prompt:
            "Change the selected model.",
          command:
            "/model",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          () =>
            mergePluginSkills(
              plugins,
            ),
        ).toThrow(
          'conflicts with a built-in Sky Code command',
        );
      },
    );

    it(
      "rejects plugin skills that use the permissions command",
      async () => {
        const manifest =
          createManifest(
            "permissions-command-plugin",
          );

        manifest.skills[0] = {
          name:
            "change-permissions",
          description:
            "Change permissions",
          prompt:
            "Change the permission mode.",
          command:
            "/permissions",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          () =>
            mergePluginSkills(
              plugins,
            ),
        ).toThrow(
          'Plugin skill command "/permissions" conflicts with a built-in Sky Code command',
        );
      },
    );

    it(
      "formats active plugin skills for the system prompt",
      async () => {
        const manifest =
          createManifest(
            "prompt-plugin",
          );

        manifest.skills[0] = {
          name:
            "review-code",
          description:
            "Review supplied code",
          prompt:
            "Identify concrete correctness problems.",
          command:
            "/review",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const skills =
          mergePluginSkills(
            plugins,
          );

        expect(
          formatPluginSkillsForPrompt(
            skills,
          ),
        ).toEqual([
          "",
          "Active plugin skills:",
          '- /review from plugin "prompt-plugin": Review supplied code',
          "  Instructions: Identify concrete correctness problems.",
        ]);
      },
    );

    it(
      "resolves a plugin command with user arguments",
      async () => {
        const manifest =
          createManifest(
            "command-plugin",
          );

        manifest.skills[0] = {
          name:
            "review-code",
          description:
            "Review supplied code",
          prompt:
            "Identify concrete correctness problems.",
          command:
            "/review",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const skills =
          mergePluginSkills(
            plugins,
          );

        const resolved =
          resolvePluginSkillCommand(
            "/review src/index.ts",
            skills,
          );

        expect(
          resolved,
        ).not.toBeNull();

        expect(
          resolved?.commandArguments,
        ).toBe(
          "src/index.ts",
        );

        expect(
          resolved?.conversationInput,
        ).toBe(
          [
            'Use the active plugin skill "review-code" from plugin "command-plugin".',
            "",
            "Skill instructions:",
            "Identify concrete correctness problems.",
            "",
            "User request:",
            "src/index.ts",
          ].join("\n"),
        );
      },
    );

    it(
      "resolves an exact plugin command without arguments",
      async () => {
        const manifest =
          createManifest(
            "no-argument-plugin",
          );

        manifest.skills[0] = {
          name:
            "summarize",
          description:
            "Summarize the current context",
          prompt:
            "Provide a concise summary.",
          command:
            "/summarize",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const skills =
          mergePluginSkills(
            plugins,
          );

        const resolved =
          resolvePluginSkillCommand(
            "/summarize",
            skills,
          );

        expect(
          resolved?.commandArguments,
        ).toBe("");

        expect(
          resolved?.conversationInput,
        ).toContain(
          "Apply this skill now.",
        );
      },
    );

    it(
      "does not match a command prefix without a separating space",
      async () => {
        const manifest =
          createManifest(
            "prefix-plugin",
          );

        manifest.skills[0] = {
          name:
            "review",
          description:
            "Review content",
          prompt:
            "Review the content.",
          command:
            "/review",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const skills =
          mergePluginSkills(
            plugins,
          );

        expect(
          resolvePluginSkillCommand(
            "/reviewer",
            skills,
          ),
        ).toBeNull();
      },
    );

    it(
      "loads and validates plugin MCP servers",
      async () => {
        const manifest = {
          ...createManifest(
            "mcp-plugin",
          ),
          mcpServers: [
            {
              name:
                "plugin-http-server",
              transport:
                "http",
              url:
                "http://127.0.0.1:3000/mcp",
              headers: {
                Authorization:
                  "Bearer test-token",
              },
            },
          ],
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          plugins[0]?.mcpServers,
        ).toEqual([
          {
            name:
              "plugin-http-server",
            transport:
              "http",
            url:
              "http://127.0.0.1:3000/mcp",
            headers: {
              Authorization:
                "Bearer test-token",
            },
          },
        ]);
      },
    );

    it(
      "rejects invalid plugin MCP server definitions",
      async () => {
        const manifest = {
          ...createManifest(
            "invalid-mcp-plugin",
          ),
          mcpServers: [
            {
              name:
                "invalid-server",
              transport:
                "websocket",
              url:
                "ws://127.0.0.1:3000/mcp",
            },
          ],
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        await expect(
          loadPlugins({
            projectDirectory,
            homeDirectory,
          }),
        ).rejects.toThrow(
          'transport must be "stdio", "sse", or "http"',
        );
      },
    );

    it(
      "merges configured and plugin MCP servers",
      async () => {
        const manifest = {
          ...createManifest(
            "merge-mcp-plugin",
          ),
          mcpServers: [
            {
              name:
                "plugin-server",
              transport:
                "sse",
              url:
                "http://127.0.0.1:3000/sse",
            },
          ],
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        const servers =
          mergePluginMcpServers(
            [
              {
                name:
                  "configured-server",
                transport:
                  "stdio",
                command:
                  process.execPath,
                args: [],
              },
            ],
            plugins,
          );

        expect(
          servers.map(
            (
              server,
            ) =>
              [
                server.name,
                server.transport,
              ],
          ),
        ).toEqual([
          [
            "configured-server",
            "stdio",
          ],
          [
            "plugin-server",
            "sse",
          ],
        ]);
      },
    );

    it(
      "rejects duplicate MCP server names during merging",
      async () => {
        const manifest = {
          ...createManifest(
            "duplicate-mcp-plugin",
          ),
          mcpServers: [
            {
              name:
                "shared-server",
              transport:
                "http",
              url:
                "http://127.0.0.1:3000/mcp",
            },
          ],
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          manifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          () =>
            mergePluginMcpServers(
              [
                {
                  name:
                    "shared-server",
                  transport:
                    "stdio",
                  command:
                    process.execPath,
                  args: [],
                },
              ],
              plugins,
            ),
        ).toThrow(
          'Duplicate MCP server name "shared-server"',
        );
      },
    );

    it(
      "rejects duplicate commands across plugins",
      async () => {
        const projectManifest =
          createManifest(
            "project-review",
          );

        projectManifest.skills[0] = {
          name:
            "project-review-skill",
          description:
            "Project review",
          prompt:
            "Review the project.",
          command:
            "/review",
        };

        const globalManifest =
          createManifest(
            "global-review",
          );

        globalManifest.skills[0] = {
          name:
            "global-review-skill",
          description:
            "Global review",
          prompt:
            "Review globally.",
          command:
            "/review",
        };

        await createPlugin(
          join(
            projectDirectory,
            ".sky-code-plugin",
          ),
          projectManifest,
        );

        await createPlugin(
          join(
            homeDirectory,
            ".sky-code",
            "plugins",
            "global-review",
            ".sky-code-plugin",
          ),
          globalManifest,
        );

        const plugins =
          await loadPlugins({
            projectDirectory,
            homeDirectory,
          });

        expect(
          () =>
            mergePluginSkills(
              plugins,
            ),
        ).toThrow(
          'Duplicate plugin skill command "/review"',
        );
      },
    );
  },
);
