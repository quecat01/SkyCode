/**
 * Plugin discovery, manifest validation, and runtime skill integration for Sky
 * Code.
 *
 * Plugins can come from the current project, the user's global Sky Code plugin
 * directory, or explicitly configured directories. This module discovers those
 * plugin folders, validates plugin.json manifests, prevents naming and command
 * conflicts, merges plugin-provided MCP servers, and converts slash-command
 * skill invocations into conversation input for the model.
 *
 * Filesystem discovery uses canonical real paths to avoid loading the same
 * plugin directory more than once through aliases or symbolic links.
 */
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

/**
 * Location category from which a plugin was discovered.
 *
 * `project` is the current project's .sky-code-plugin directory, `global` is
 * under ~/.sky-code/plugins, and `configured` comes from pluginDirs.
 */
export type PluginSource =
  | "project"
  | "global"
  | "configured";

/**
 * One model-facing skill declared by a plugin manifest.
 *
 * prompt contains the instructions injected when the skill is invoked, while
 * command is the slash command exposed to the interactive user.
 */
export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
  command: string;
}

/**
 * Validated contents of a plugin.json manifest.
 *
 * Skills and MCP server definitions are validated here. Agent and hook entries
 * are retained as raw arrays for the subsystems that interpret them later.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  skills: PluginSkill[];
  agents: unknown[];
  hooks: unknown[];
  mcpServers: McpServerConfig[];
}

/**
 * Fully validated plugin plus discovery metadata.
 *
 * directory is the canonical plugin directory, manifestPath identifies its
 * plugin.json file, and source records how Sky Code discovered it.
 */
export interface LoadedPlugin
  extends PluginManifest {
  directory: string;
  manifestPath: string;
  source: PluginSource;
}

/**
 * Plugin skill enriched with the identity and location of its owning plugin.
 *
 * This is the runtime representation used after skills from all loaded plugins
 * have been merged and checked for conflicts.
 */
export interface ActivePluginSkill
  extends PluginSkill {
  pluginName: string;
  pluginDirectory: string;
  source: PluginSource;
}

/**
 * Result of matching interactive input to an active plugin skill command.
 *
 * commandArguments contains only text after the slash command. conversationInput
 * is the complete synthesized model input containing the skill instructions and
 * the user's request.
 */
export interface ResolvedPluginSkillCommand {
  skill: ActivePluginSkill;
  commandArguments: string;
  conversationInput: string;
}

/**
 * Filesystem locations used during plugin discovery.
 *
 * Relative pluginDirs entries are resolved against projectDirectory.
 */
export interface LoadPluginsOptions {
  projectDirectory: string;
  homeDirectory: string;
  pluginDirs?: readonly string[];
}

/**
 * Internal plugin-directory candidate paired with its discovery source.
 *
 * The directory is canonicalized later before duplicate locations are removed.
 */
interface DiscoveredPluginDirectory {
  directory: string;
  source: PluginSource;
}

/**
 * Checks whether an unknown value is a non-null, non-array object.
 *
 * @param {unknown} value - Runtime value to inspect.
 * @returns {boolean} True when the value can be treated as an object record.
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validates and normalizes a required string manifest field.
 *
 * Leading and trailing whitespace are removed before the value is returned.
 *
 * @param {unknown} value - Raw manifest field value.
 * @param {string} fieldName - Field name used in validation diagnostics.
 * @param {string} manifestPath - Manifest path included in error messages.
 * @returns {string} Trimmed non-empty string.
 * @throws {Error} If the value is not a string or becomes empty after trimming.
 */
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

/**
 * Validates that a required plugin manifest field is an array.
 *
 * @param {unknown} value - Raw manifest field value.
 * @param {string} fieldName - Field name used in validation diagnostics.
 * @param {string} manifestPath - Manifest path included in error messages.
 * @returns {unknown[]} Validated array value.
 * @throws {Error} If the value is not an array.
 */
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

/**
 * Validates a plugin skill name.
 *
 * Skill names must start with a lowercase letter or number and may otherwise
 * contain lowercase letters, numbers, hyphens, and underscores.
 *
 * @param {unknown} value - Raw skill-name value.
 * @param {string} fieldName - Manifest field path used in diagnostics.
 * @param {string} manifestPath - Manifest file being validated.
 * @returns {string} Validated normalized skill name.
 * @throws {Error} If the value is empty or violates the allowed name syntax.
 */
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

/**
 * Validates or derives the slash command for a plugin skill.
 *
 * When command is omitted, `/<skillName>` is used automatically. Explicit and
 * derived commands must begin with "/" and otherwise use the same restricted
 * lowercase character set as skill names.
 *
 * @param {unknown} value - Optional raw command value.
 * @param {string} skillName - Validated skill name used for the default command.
 * @param {string} fieldName - Manifest field path used in diagnostics.
 * @param {string} manifestPath - Manifest file being validated.
 * @returns {string} Validated slash command.
 * @throws {Error} If an explicit command is empty or has invalid syntax.
 */
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

/**
 * Validates all skills declared by a plugin manifest.
 *
 * Each entry must be an object containing a valid name, description, prompt,
 * and optional command. Duplicate skill names and duplicate commands within the
 * same manifest are rejected.
 *
 * @param {unknown} value - Raw skills manifest field.
 * @param {string} manifestPath - Manifest file being validated.
 * @returns {PluginSkill[]} Validated skills in manifest order.
 * @throws {Error} If the skills field or any skill entry is invalid or
 * duplicated.
 */
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

/**
 * Validates MCP server definitions embedded in a plugin manifest.
 *
 * The shared configuration validator is reused so plugin MCP definitions obey
 * the same schema as Sky Code's normal MCP configuration. Errors are wrapped
 * with the plugin manifest path for clearer diagnostics.
 *
 * @param {unknown} value - Raw mcpServers manifest field.
 * @param {string} manifestPath - Manifest file being validated.
 * @returns {McpServerConfig[]} Validated MCP server configurations.
 * @throws {Error} If the MCP configuration is invalid.
 */
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

/**
 * Checks whether a filesystem path exists and is a directory.
 *
 * A missing path is treated as a normal false result. Other filesystem errors
 * are surfaced because they may indicate permissions or storage problems.
 *
 * @param {string} path - Filesystem path to inspect.
 * @returns {Promise<boolean>} True only when the path exists as a directory.
 * @throws {Error} If stat fails for a reason other than ENOENT.
 *
 * Side effect: reads filesystem metadata.
 */
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

/**
 * Recursively finds directories named `.sky-code-plugin` below a root.
 *
 * A root that is itself named `.sky-code-plugin` is returned directly. During
 * recursion, entries are sorted by name for deterministic discovery. Once a
 * `.sky-code-plugin` directory is found it is recorded and not traversed
 * further, preventing nested content inside a plugin from being rediscovered as
 * separate plugins.
 *
 * Missing roots produce an empty result.
 *
 * @param {string} rootDirectory - Root directory to inspect.
 * @returns {Promise<string[]>} Discovered plugin directories.
 * @throws {Error} If directory scanning fails for a reason other than ENOENT.
 *
 * Side effect: recursively reads directory entries from disk.
 */
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

  // A directly configured plugin directory does not need recursive scanning.
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

  /**
   * Recursively scans one directory beneath the discovery root.
   *
   * @param {string} directory - Directory whose immediate children are scanned.
   * @returns {Promise<void>} Resolves after all eligible descendants are scanned.
   * @throws {Error} If a directory cannot be read for a reason other than
   * ENOENT.
   *
   * Side effect: reads directory entries and appends discovered plugin paths to
   * the enclosing discovered array.
   */
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

      // Treat a plugin directory as a discovery boundary; do not recurse into
      // its own internal directory tree looking for more plugins.
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

/**
 * Reads and validates plugin.json for one discovered plugin directory.
 *
 * Required string fields, skills, raw agent/hook arrays, and MCP servers are
 * validated before discovery metadata is attached to the returned plugin.
 *
 * @param {string} directory - Plugin directory containing plugin.json.
 * @param {PluginSource} source - Discovery source assigned to this plugin.
 * @returns {Promise<LoadedPlugin>} Fully validated plugin.
 * @throws {Error} If plugin.json is missing, unreadable, invalid JSON, not an
 * object, or contains invalid manifest fields.
 *
 * Side effect: reads plugin.json from disk.
 */
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

/**
 * Canonicalizes and deduplicates discovered plugin directories.
 *
 * realpath() collapses symbolic links and alternate path spellings. When the
 * same canonical directory was discovered from multiple sources, the first
 * discovery wins. The final list is sorted by canonical directory path to make
 * loading deterministic.
 *
 * @param {readonly DiscoveredPluginDirectory[]} discovered - Raw discovered
 * directory candidates.
 * @returns {Promise<DiscoveredPluginDirectory[]>} Canonical unique directories.
 * @throws {Error} If a discovered path cannot be resolved with realpath().
 *
 * Side effect: resolves filesystem paths.
 */
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

  // Sort only after deduplication so equivalent paths cannot affect loading
  // order through different aliases.
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

/**
 * Discovers all plugin directories available to the current Sky Code session.
 *
 * Discovery checks the project's `.sky-code-plugin`, recursively searches
 * `~/.sky-code/plugins`, and then searches each configured pluginDirs location.
 * Relative configured paths are resolved from projectDirectory.
 *
 * Duplicate physical directories are removed by canonical real path before the
 * result is returned.
 *
 * @param {LoadPluginsOptions} options - Project, home, and configured plugin
 * locations.
 * @returns {Promise<DiscoveredPluginDirectory[]>} Canonical unique plugin
 * directories.
 * @throws {Error} If plugin discovery encounters an unexpected filesystem
 * failure.
 *
 * Side effect: inspects project, home, and configured filesystem locations.
 */
export async function discoverPluginDirectories(
  options: LoadPluginsOptions,
): Promise<DiscoveredPluginDirectory[]> {
  const discovered:
    DiscoveredPluginDirectory[] = [];

  // The project-local plugin has the most direct relationship to the active
  // project and is checked before global or explicitly configured roots.
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

  // Global plugins live under the Sky Code directory in the user's home.
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

  // Configured roots may be absolute or project-relative and can themselves
  // contain one or more nested .sky-code-plugin directories.
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

/**
 * Discovers, parses, validates, and returns all active plugins.
 *
 * Manifest parsing runs concurrently after deterministic directory discovery.
 * Plugin names must be unique across all loaded manifests. The final result is
 * sorted by plugin name.
 *
 * @param {LoadPluginsOptions} options - Plugin discovery locations.
 * @returns {Promise<LoadedPlugin[]>} Validated plugins sorted by name.
 * @throws {Error} If discovery or manifest validation fails, or two plugins
 * declare the same plugin name.
 *
 * Side effects: scans plugin directories and reads plugin manifests.
 */
export async function loadPlugins(
  options: LoadPluginsOptions,
): Promise<LoadedPlugin[]> {
  const directories =
    await discoverPluginDirectories(
      options,
    );

  // Manifest reads are independent, so they can be validated concurrently.
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

  // Plugin names form a global namespace for the active session even when
  // their directories and discovery sources differ.
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

/**
 * Built-in slash commands that plugins are not allowed to replace.
 *
 * Keeping these commands reserved prevents plugin loading from changing the
 * meaning of core Sky Code controls.
 */
const RESERVED_SKILL_COMMANDS =
  new Set<string>([
    "/model",
    "/permissions",
    "/compact",
  ]);

/**
 * Merges plugin skills into one conflict-free runtime skill list.
 *
 * Skill names must be unique across plugins. Commands may not collide with the
 * reserved built-in commands or with another plugin skill command. Each skill
 * is enriched with its owning plugin metadata and the result is sorted by slash
 * command for deterministic presentation and matching.
 *
 * @param {readonly LoadedPlugin[]} plugins - Loaded plugins whose skills should
 * become active.
 * @returns {ActivePluginSkill[]} Merged skills sorted by command.
 * @throws {Error} If skill names or commands collide, or a command conflicts
 * with a reserved built-in command.
 */
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

      // Core commands take precedence permanently; a plugin cannot shadow
      // these controls even when no other plugin uses the same command.
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

  // Stable command ordering keeps prompt output and command matching
  // deterministic regardless of manifest skill order.
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


/**
 * Combines Sky Code's configured MCP servers with MCP servers supplied by
 * plugins.
 *
 * Configured servers remain first in the result. Every MCP server name must be
 * globally unique across normal configuration and all loaded plugins so later
 * connection and tool routing can identify servers unambiguously.
 *
 * @param {readonly McpServerConfig[]} configuredServers - MCP servers from Sky
 * Code configuration.
 * @param {readonly LoadedPlugin[]} plugins - Loaded plugins contributing MCP
 * servers.
 * @returns {McpServerConfig[]} Combined server list.
 * @throws {Error} If any plugin MCP server name duplicates a configured or
 * previously merged plugin server name.
 */
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

  // Seed origin tracking with normal configuration so collision errors can
  // identify where an existing server name came from.
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


/**
 * Formats active plugin skills for inclusion in the model-facing prompt.
 *
 * The returned lines begin with a blank separator. When no skills are active a
 * short status line is emitted; otherwise every skill includes its slash
 * command, owning plugin, description, and model instructions.
 *
 * @param {readonly ActivePluginSkill[]} skills - Active plugin skills.
 * @returns {string[]} Prompt lines describing available plugin skills.
 */
export function formatPluginSkillsForPrompt(
  skills:
    readonly ActivePluginSkill[],
): string[] {
  // Explicitly tell the model when there are no skills rather than silently
  // omitting the plugin-skills section.
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

/**
 * Resolves interactive user input against the active plugin skill commands.
 *
 * A command matches either exactly or when followed by a space and arguments;
 * this prevents a command such as `/test` from accidentally matching
 * `/testing`. The matched skill's instructions and user-supplied arguments are
 * then assembled into conversation input for the model.
 *
 * Invoking a skill with no arguments supplies the neutral request
 * "Apply this skill now." so the model still receives an explicit task.
 *
 * @param {string} userInput - Raw interactive input to inspect.
 * @param {readonly ActivePluginSkill[]} skills - Skills eligible for matching.
 * @returns {ResolvedPluginSkillCommand | null} Resolved skill invocation, or
 * null when no active command matches.
 */
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

    // A bare skill command still needs a concrete user-request section in the
    // synthesized conversation input.
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
