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
  HookRegistry,
  registerPluginHooks,
} from "../src/hooks.ts";

import type {
  LoadedPlugin,
} from "../src/plugins.ts";

describe(
  "plugin hook loading",
  () => {
    let rootDirectory:
      string;

    let pluginDirectory:
      string;

    beforeEach(
      async () => {
        rootDirectory =
          await mkdtemp(
            join(
              tmpdir(),
              "sky-code-plugin-hooks-",
            ),
          );

        pluginDirectory =
          join(
            rootDirectory,
            ".sky-code-plugin",
          );

        await mkdir(
          pluginDirectory,
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

    function createPlugin(
      hooks: unknown[],
    ): LoadedPlugin {
      return {
        name:
          "test-hook-plugin",
        version:
          "1.0.0",
        description:
          "Plugin hook test",
        skills: [],
        agents: [],
        hooks,
        mcpServers: [],
        directory:
          pluginDirectory,
        manifestPath:
          join(
            pluginDirectory,
            "plugin.json",
          ),
        source:
          "project",
      };
    }

    it(
      "registers default and named hook exports",
      async () => {
        await writeFile(
          join(
            pluginDirectory,
            "hooks.mjs",
          ),
          [
            "export default function preToolUse(event) {",
            "  event.metadata.preHook = true;",
            "}",
            "",
            "export function postToolUse(event) {",
            '  event.result.output += " Post hook fired.";',
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const registry =
          new HookRegistry();

        const resolvedHooks =
          await registerPluginHooks(
            [
              createPlugin([
                {
                  name:
                    "PreToolUse",
                  module:
                    "./hooks.mjs",
                },
                {
                  name:
                    "PostToolUse",
                  module:
                    "./hooks.mjs",
                  export:
                    "postToolUse",
                },
              ]),
            ],
            registry,
          );

        expect(
          resolvedHooks,
        ).toHaveLength(2);

        expect(
          registry.count(),
        ).toBe(2);

        const metadata:
          Record<string, unknown> = {};

        await registry.run(
          "PreToolUse",
          {
            request: {
              tool:
                "read_file",
              args: {
                path:
                  "/tmp/example.txt",
              },
            },
            cancelled:
              false,
            metadata,
          },
        );

        const postEvent = {
          request: {
            tool:
              "read_file" as const,
            args: {
              path:
                "/tmp/example.txt",
            },
          },
          result: {
            success:
              true,
            output:
              "Tool completed.",
          },
          metadata,
        };

        await registry.run(
          "PostToolUse",
          postEvent,
        );

        expect(
          metadata,
        ).toEqual({
          preHook:
            true,
        });

        expect(
          postEvent.result.output,
        ).toBe(
          "Tool completed. Post hook fired.",
        );
      },
    );

    it(
      "rejects unsupported hook names",
      async () => {
        const registry =
          new HookRegistry();

        await expect(
          registerPluginHooks(
            [
              createPlugin([
                {
                  name:
                    "BeforeTool",
                  module:
                    "./missing.mjs",
                },
              ]),
            ],
            registry,
          ),
        ).rejects.toThrow(
          "must be one of PreToolUse, PostToolUse, PreCompact, PostCompact, Notification",
        );

        expect(
          registry.count(),
        ).toBe(0);
      },
    );

    it(
      "rejects hook modules outside the plugin directory",
      async () => {
        await writeFile(
          join(
            rootDirectory,
            "outside.mjs",
          ),
          "export default function outside() {}\n",
          "utf8",
        );

        const registry =
          new HookRegistry();

        await expect(
          registerPluginHooks(
            [
              createPlugin([
                {
                  name:
                    "PreToolUse",
                  module:
                    "../outside.mjs",
                },
              ]),
            ],
            registry,
          ),
        ).rejects.toThrow(
          "resolves outside the plugin directory",
        );

        expect(
          registry.count(),
        ).toBe(0);
      },
    );

    it(
      "rejects exports that are not functions",
      async () => {
        await writeFile(
          join(
            pluginDirectory,
            "invalid.mjs",
          ),
          "export const value = 42;\n",
          "utf8",
        );

        const registry =
          new HookRegistry();

        await expect(
          registerPluginHooks(
            [
              createPlugin([
                {
                  name:
                    "PreToolUse",
                  module:
                    "./invalid.mjs",
                  export:
                    "value",
                },
              ]),
            ],
            registry,
          ),
        ).rejects.toThrow(
          "must export a function",
        );

        expect(
          registry.count(),
        ).toBe(0);
      },
    );

    it(
      "removes earlier registrations when a later hook fails",
      async () => {
        await writeFile(
          join(
            pluginDirectory,
            "partial.mjs",
          ),
          [
            "export function validHook() {}",
            "export const invalidHook = 42;",
            "",
          ].join("\n"),
          "utf8",
        );

        const registry =
          new HookRegistry();

        await expect(
          registerPluginHooks(
            [
              createPlugin([
                {
                  name:
                    "PreToolUse",
                  module:
                    "./partial.mjs",
                  export:
                    "validHook",
                },
                {
                  name:
                    "PostToolUse",
                  module:
                    "./partial.mjs",
                  export:
                    "invalidHook",
                },
              ]),
            ],
            registry,
          ),
        ).rejects.toThrow(
          "must export a function",
        );

        expect(
          registry.count(),
        ).toBe(0);

        expect(
          registry.list(),
        ).toEqual([]);
      },
    );
  },
);
