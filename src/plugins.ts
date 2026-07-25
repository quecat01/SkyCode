import {
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";

import {
  basename,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import {
  validateMcpServerConfigs,
  type McpServerConfig,
} from "./config.js";

export type PluginSource =
  | "project"
  | "global"
  | "configured";

export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
  command: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  skills: PluginSkill[];
  agents: unknown[];
  hooks: unknown[];
  mcpServers: McpServerConfig[];
}

export interface LoadedPlugin
  extends PluginManifest {
  directory: string;
  manifestPath: string;
  source: PluginSource;
}

export interface ActivePluginSkill
  extends PluginSkill {
  pluginName: string;
  pluginDirectory: string;
  source: PluginSource;
}

export interface ResolvedPluginSkillCommand {
  skill: ActivePluginSkill;
  commandArguments: string;
  conversationInput: string;
}

export interface LoadPluginsOptions {
  projectDirectory: string;
  homeDirectory: string;
  pluginDirs?: readonly string[];
}

interface DiscoveredPluginDirectory {
  directory: string;
  source: PluginSource;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

function requireArray(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must be an array`,
    );
  }

  return value;
}

function validateSkillName(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): string {
  const name =
    requireNonEmptyString(
      value,
      fieldName,
      manifestPath,
    );

  if (
    !/^[a-z0-9][a-z0-9_-]*$/.test(
      name,
    )
  ) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  return name;
}

function validateSkillCommand(
  value: unknown,
  skillName: string,
  fieldName: string,
  manifestPath: string,
): string {
  const command =
    value === undefined
      ? `/${skillName}`
      : requireNonEmptyString(
          value,
          fieldName,
          manifestPath,
        );

  if (
    !/^\/[a-z0-9][a-z0-9_-]*$/.test(
      command,
    )
  ) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must begin with "/" and use only lowercase letters, numbers, hyphens, and underscores`,
    );
  }

  return command;
}

function parsePluginSkills(
  value: unknown,
  manifestPath: string,
): PluginSkill[] {
  const entries =
    requireArray(
      value,
      "skills",
      manifestPath,
    );

  const skillNames =
    new Set<string>();

  const commands =
    new Set<string>();

  return entries.map(
    (
      entry: unknown,
      index: number,
    ): PluginSkill => {
      const fieldName =
        `skills[${index}]`;

      if (!isRecord(entry)) {
        throw new Error(
          `Plugin manifest ${manifestPath}: ${fieldName} must be a JSON object`,
        );
      }

      const name =
        validateSkillName(
          entry.name,
          `${fieldName}.name`,
          manifestPath,
        );

      const description =
        requireNonEmptyString(
          entry.description,
          `${fieldName}.description`,
          manifestPath,
        );

      const prompt =
        requireNonEmptyString(
          entry.prompt,
          `${fieldName}.prompt`,
          manifestPath,
        );

      const command =
        validateSkillCommand(
          entry.command,
          name,
          `${fieldName}.command`,
          manifestPath,
        );

      if (
        skillNames.has(name)
      ) {
        throw new Error(
          `Plugin manifest ${manifestPath}: duplicate skill name "${name}"`,
        );
      }

      if (
        commands.has(command)
      ) {
        throw new Error(
          `Plugin manifest ${manifestPath}: duplicate skill command "${command}"`,
        );
      }

      skillNames.add(name);
      commands.add(command);

      return {
        name,
        description,
        prompt,
        command,
      };
    },
  );
}

function parsePluginMcpServers(
  value: unknown,
  manifestPath: string,
): McpServerConfig[] {
  try {
    return validateMcpServerConfigs(
      value,
    );
  } catch (error) {
    throw new Error(
      `Plugin manifest ${manifestPath}: invalid mcpServers configuration: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

async function isDirectory(
  path: string,
): Promise<boolean> {
  try {
    const details =
      await stat(path);

    return details.isDirectory();
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code ===
      "ENOENT"
    ) {
      return false;
    }

    throw new Error(
      `Unable to inspect plugin path ${path}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

async function findNamedPluginDirectories(
  rootDirectory: string,
): Promise<string[]> {
  if (
    !(await isDirectory(
      rootDirectory,
    ))
  ) {
    return [];
  }

  if (
    basename(rootDirectory) ===
    ".sky-code-plugin"
  ) {
    return [
      rootDirectory,
    ];
  }

  const discovered:
    string[] = [];

  async function walk(
    directory: string,
  ): Promise<void> {
    let entries;

    try {
      entries =
        await readdir(
          directory,
          {
            withFileTypes:
              true,
          },
        );
    } catch (error) {
      const nodeError =
        error as NodeJS.ErrnoException;

      if (
        nodeError.code ===
        "ENOENT"
      ) {
        return;
      }

      throw new Error(
        `Unable to scan plugin directory ${directory}: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    entries.sort(
      (
        left,
        right,
      ) =>
        left.name.localeCompare(
          right.name,
        ),
    );

    for (
      const entry of entries
    ) {
      if (
        !entry.isDirectory()
      ) {
        continue;
      }

      const childPath =
        join(
          directory,
          entry.name,
        );

      if (
        entry.name ===
        ".sky-code-plugin"
      ) {
        discovered.push(
          childPath,
        );

        continue;
      }

      await walk(
        childPath,
      );
    }
  }

  await walk(
    rootDirectory,
  );

  return discovered;
}

async function parsePluginManifest(
  directory: string,
  source: PluginSource,
): Promise<LoadedPlugin> {
  const manifestPath =
    join(
      directory,
      "plugin.json",
    );

  let fileContents:
    string;

  try {
    fileContents =
      await readFile(
        manifestPath,
        "utf8",
      );
  } catch (error) {
    const nodeError =
      error as NodeJS.ErrnoException;

    if (
      nodeError.code ===
      "ENOENT"
    ) {
      throw new Error(
        `Plugin directory ${directory} does not contain plugin.json`,
      );
    }

    throw new Error(
      `Unable to read plugin manifest ${manifestPath}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  let parsed:
    unknown;

  try {
    parsed =
      JSON.parse(
        fileContents,
      );
  } catch (error) {
    throw new Error(
      `Plugin manifest ${manifestPath} contains invalid JSON: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Plugin manifest ${manifestPath} must contain a JSON object`,
    );
  }

  return {
    name:
      requireNonEmptyString(
        parsed.name,
        "name",
        manifestPath,
      ),
    version:
      requireNonEmptyString(
        parsed.version,
        "version",
        manifestPath,
      ),
    description:
      requireNonEmptyString(
        parsed.description,
        "description",
        manifestPath,
      ),
    skills:
      parsePluginSkills(
        parsed.skills,
        manifestPath,
      ),
    agents:
      requireArray(
        parsed.agents,
        "agents",
        manifestPath,
      ),
    hooks:
      requireArray(
        parsed.hooks,
        "hooks",
        manifestPath,
      ),
    mcpServers:
      parsePluginMcpServers(
        parsed.mcpServers,
        manifestPath,
      ),
    directory,
    manifestPath,
    source,
  };
}

async function deduplicatePluginDirectories(
  discovered:
    readonly DiscoveredPluginDirectory[],
): Promise<DiscoveredPluginDirectory[]> {
  const uniqueDirectories =
    new Map<
      string,
      DiscoveredPluginDirectory
    >();

  for (
    const item of discovered
  ) {
    const canonicalPath =
      await realpath(
        item.directory,
      );

    if (
      !uniqueDirectories.has(
        canonicalPath,
      )
    ) {
      uniqueDirectories.set(
        canonicalPath,
        {
          directory:
            canonicalPath,
          source:
            item.source,
        },
      );
    }
  }

  return [
    ...uniqueDirectories.values(),
  ].sort(
    (
      left,
      right,
    ) =>
      left.directory.localeCompare(
        right.directory,
      ),
  );
}

export async function discoverPluginDirectories(
  options: LoadPluginsOptions,
): Promise<DiscoveredPluginDirectory[]> {
  const discovered:
    DiscoveredPluginDirectory[] = [];

  const projectPluginDirectory =
    join(
      options.projectDirectory,
      ".sky-code-plugin",
    );

  if (
    await isDirectory(
      projectPluginDirectory,
    )
  ) {
    discovered.push({
      directory:
        projectPluginDirectory,
      source:
        "project",
    });
  }

  const globalPluginRoot =
    join(
      options.homeDirectory,
      ".sky-code",
      "plugins",
    );

  for (
    const directory of
    await findNamedPluginDirectories(
      globalPluginRoot,
    )
  ) {
    discovered.push({
      directory,
      source:
        "global",
    });
  }

  for (
    const configuredDirectory of
    options.pluginDirs ?? []
  ) {
    const resolvedDirectory =
      isAbsolute(
        configuredDirectory,
      )
        ? configuredDirectory
        : resolve(
            options.projectDirectory,
            configuredDirectory,
          );

    for (
      const directory of
      await findNamedPluginDirectories(
        resolvedDirectory,
      )
    ) {
      discovered.push({
        directory,
        source:
          "configured",
      });
    }
  }

  return deduplicatePluginDirectories(
    discovered,
  );
}

export async function loadPlugins(
  options: LoadPluginsOptions,
): Promise<LoadedPlugin[]> {
  const directories =
    await discoverPluginDirectories(
      options,
    );

  const plugins =
    await Promise.all(
      directories.map(
        (
          item,
        ) =>
          parsePluginManifest(
            item.directory,
            item.source,
          ),
      ),
    );

  const names =
    new Map<
      string,
      string
    >();

  for (
    const plugin of plugins
  ) {
    const existingManifest =
      names.get(
        plugin.name,
      );

    if (
      existingManifest !==
      undefined
    ) {
      throw new Error(
        `Duplicate plugin name "${plugin.name}" in ${existingManifest} and ${plugin.manifestPath}`,
      );
    }

    names.set(
      plugin.name,
      plugin.manifestPath,
    );
  }

  return plugins.sort(
    (
      left,
      right,
    ) =>
      left.name.localeCompare(
        right.name,
      ),
  );
}

const RESERVED_SKILL_COMMANDS =
  new Set<string>([
    "/model",
    "/permissions",
    "/compact",
  ]);

export function mergePluginSkills(
  plugins:
    readonly LoadedPlugin[],
): ActivePluginSkill[] {
  const mergedSkills:
    ActivePluginSkill[] = [];

  const skillNames =
    new Map<
      string,
      string
    >();

  const commands =
    new Map<
      string,
      string
    >();

  for (
    const plugin of plugins
  ) {
    for (
      const skill of
      plugin.skills
    ) {
      const existingSkillPlugin =
        skillNames.get(
          skill.name,
        );

      if (
        existingSkillPlugin !==
        undefined
      ) {
        throw new Error(
          `Duplicate plugin skill name "${skill.name}" in plugins "${existingSkillPlugin}" and "${plugin.name}"`,
        );
      }

      if (
        RESERVED_SKILL_COMMANDS.has(
          skill.command,
        )
      ) {
        throw new Error(
          `Plugin skill command "${skill.command}" conflicts with a built-in Sky Code command`,
        );
      }

      const existingCommandPlugin =
        commands.get(
          skill.command,
        );

      if (
        existingCommandPlugin !==
        undefined
      ) {
        throw new Error(
          `Duplicate plugin skill command "${skill.command}" in plugins "${existingCommandPlugin}" and "${plugin.name}"`,
        );
      }

      skillNames.set(
        skill.name,
        plugin.name,
      );

      commands.set(
        skill.command,
        plugin.name,
      );

      mergedSkills.push({
        ...skill,
        pluginName:
          plugin.name,
        pluginDirectory:
          plugin.directory,
        source:
          plugin.source,
      });
    }
  }

  return mergedSkills.sort(
    (
      left,
      right,
    ) =>
      left.command.localeCompare(
        right.command,
      ),
  );
}


export function mergePluginMcpServers(
  configuredServers:
    readonly McpServerConfig[],
  plugins:
    readonly LoadedPlugin[],
): McpServerConfig[] {
  const mergedServers:
    McpServerConfig[] = [
      ...configuredServers,
    ];

  const serverOrigins =
    new Map<
      string,
      string
    >();

  for (
    const server of
    configuredServers
  ) {
    serverOrigins.set(
      server.name,
      "Sky Code configuration",
    );
  }

  for (
    const plugin of plugins
  ) {
    for (
      const server of
      plugin.mcpServers
    ) {
      const existingOrigin =
        serverOrigins.get(
          server.name,
        );

      if (
        existingOrigin !==
        undefined
      ) {
        throw new Error(
          `Duplicate MCP server name "${server.name}" in ${existingOrigin} and plugin "${plugin.name}"`,
        );
      }

      serverOrigins.set(
        server.name,
        `plugin "${plugin.name}"`,
      );

      mergedServers.push(
        server,
      );
    }
  }

  return mergedServers;
}


export function formatPluginSkillsForPrompt(
  skills:
    readonly ActivePluginSkill[],
): string[] {
  if (
    skills.length === 0
  ) {
    return [
      "",
      "No plugin skills are active in this session.",
    ];
  }

  const lines = [
    "",
    "Active plugin skills:",
  ];

  for (
    const skill of skills
  ) {
    lines.push(
      `- ${skill.command} from plugin "${skill.pluginName}": ${skill.description}`,
    );

    lines.push(
      `  Instructions: ${skill.prompt}`,
    );
  }

  return lines;
}

export function resolvePluginSkillCommand(
  userInput: string,
  skills:
    readonly ActivePluginSkill[],
): ResolvedPluginSkillCommand | null {
  const trimmedInput =
    userInput.trim();

  for (
    const skill of skills
  ) {
    if (
      trimmedInput !==
        skill.command &&
      !trimmedInput.startsWith(
        `${skill.command} `,
      )
    ) {
      continue;
    }

    const commandArguments =
      trimmedInput
        .slice(
          skill.command.length,
        )
        .trim();

    const userRequest =
      commandArguments === ""
        ? "Apply this skill now."
        : commandArguments;

    const conversationInput = [
      `Use the active plugin skill "${skill.name}" from plugin "${skill.pluginName}".`,
      "",
      "Skill instructions:",
      skill.prompt,
      "",
      "User request:",
      userRequest,
    ].join("\n");

    return {
      skill,
      commandArguments,
      conversationInput,
    };
  }

  return null;
}
