/**
 * Runtime resolution and execution helpers for Sky Code custom catalog items.
 *
 * This module turns catalog slash commands into prompt or shell operations,
 * renders prompt templates with user arguments, selects session-enabled skills,
 * formats those skills for the model system prompt, and prevents catalog names
 * from colliding with active plugin commands or skills.
 */
import type {
  PermissionMode,
} from "./config.js";

import type {
  ActivePluginSkill,
} from "./plugins.js";

import {
  runShellCommandForPermissionMode,
  type ApprovalPrompt,
} from "./shell.js";

import type {
  ToolExecutionResult,
} from "./tools.js";

import type {
  CatalogCommand,
  CatalogPromptCommand,
  CatalogShellCommand,
  CatalogSkill,
  CatalogSnapshot,
} from "./catalog.js";

/**
 * Resolved prompt-backed catalog command ready for conversational processing.
 *
 * The original validated command is retained alongside the extracted arguments
 * and the final conversation input produced from its prompt template.
 */
export interface ResolvedCatalogPromptCommand {
  kind:
    "prompt";

  command:
    CatalogPromptCommand;

  commandArguments:
    string;

  conversationInput:
    string;
}

/**
 * Resolved shell-backed catalog command ready for permission-aware execution.
 *
 * Shell catalog commands currently accept no additional user arguments, so the
 * resolved shellCommand is the validated shell text stored in the catalog.
 */
export interface ResolvedCatalogShellCommand {
  kind:
    "shell";

  command:
    CatalogShellCommand;

  commandArguments:
    string;

  shellCommand:
    string;
}

/**
 * Runtime result of resolving a matching catalog command.
 */
export type ResolvedCatalogCommand =
  | ResolvedCatalogPromptCommand
  | ResolvedCatalogShellCommand;

/**
 * Narrows a catalog command to the prompt-backed variant.
 *
 * @param {CatalogCommand} command - Catalog command to inspect.
 * @returns {boolean} True when the command exposes a string prompt.
 *
 * Side effects: none.
 */
export function isCatalogPromptCommand(
  command:
    CatalogCommand,
): command is CatalogPromptCommand {
  return (
    "prompt" in
      command &&
    typeof command.prompt ===
      "string"
  );
}

/**
 * Narrows a catalog command to the shell-backed variant.
 *
 * @param {CatalogCommand} command - Catalog command to inspect.
 * @returns {boolean} True when the command exposes a string shell command.
 *
 * Side effects: none.
 */
export function isCatalogShellCommand(
  command:
    CatalogCommand,
): command is CatalogShellCommand {
  return (
    "shell" in
      command &&
    typeof command.shell ===
      "string"
  );
}

/**
 * Checks whether user input invokes one exact catalog command name.
 *
 * A command matches either exactly or when followed by a space, preventing a
 * shorter command name from matching the prefix of an unrelated slash command.
 *
 * @param {string} userInput - Trimmed user input to test.
 * @param {string} commandName - Catalog slash-command name.
 * @returns {boolean} True when the input invokes this command.
 *
 * Side effects: none.
 */
function commandMatchesInput(
  userInput:
    string,

  commandName:
    string,
): boolean {
  return (
    userInput ===
      commandName ||
    userInput.startsWith(
      `${commandName} `,
    )
  );
}

/**
 * Renders a prompt-command template using the command's trailing arguments.
 *
 * Every `{{name}}`-style placeholder (letters, numbers, underscores, or
 * hyphens, with optional inner whitespace) is replaced with the same trimmed
 * command-argument string. If no placeholder exists and arguments were supplied,
 * they are appended under a `User request:` section so user input is not lost.
 *
 * @param {string} template - Prompt template stored in the catalog command.
 * @param {string} commandArguments - User text following the command name.
 * @returns {string} Trimmed and rendered conversation input.
 *
 * Side effects: none.
 */
export function renderCatalogPromptTemplate(
  template:
    string,

  commandArguments:
    string,
): string {
  const trimmedTemplate =
    template.trim();

  const trimmedArguments =
    commandArguments.trim();

  let placeholderCount =
    0;

  const rendered =
    trimmedTemplate.replace(
      /\{\{\s*[a-zA-Z0-9_-]+\s*\}\}/g,
      () => {
        placeholderCount +=
          1;

        return trimmedArguments;
      },
    );

  if (
    placeholderCount >
      0 ||
    trimmedArguments ===
      ""
  ) {
    return rendered;
  }

  return [
    rendered,
    "",
    "User request:",
    trimmedArguments,
  ].join(
    "\n",
  );
}

/**
 * Resolves user input against the available catalog commands in array order.
 *
 * The first exact/prefix match wins. Prompt commands may accept trailing text,
 * which is rendered into conversationInput. Shell commands reject trailing
 * arguments and otherwise expose their configured shell text unchanged.
 *
 * @param {string} userInput - Raw user input to resolve.
 * @param {readonly CatalogCommand[]} commands - Catalog commands to search.
 * @returns {ResolvedCatalogCommand | null} First resolved command, or null when
 * no catalog command matches.
 * @throws {Error} If a matched shell command receives additional arguments.
 *
 * Side effects: none.
 */
export function resolveCatalogCommand(
  userInput:
    string,

  commands:
    readonly CatalogCommand[],
): ResolvedCatalogCommand | null {
  const trimmedInput =
    userInput.trim();

  for (
    const command of
    commands
  ) {
    if (
      !commandMatchesInput(
        trimmedInput,
        command.name,
      )
    ) {
      continue;
    }

    const commandArguments =
      trimmedInput
        .slice(
          command.name.length,
        )
        .trim();

    if (
      isCatalogPromptCommand(
        command,
      )
    ) {
      return {
        kind:
          "prompt",

        command,

        commandArguments,

        conversationInput:
          renderCatalogPromptTemplate(
            command.prompt,
            commandArguments,
          ),
      };
    }

    if (
      commandArguments !==
        ""
    ) {
      throw new Error(
        `Catalog shell command "${command.name}" does not accept additional arguments`,
      );
    }

    return {
      kind:
        "shell",

      command,

      commandArguments,

      shellCommand:
        command.shell,
    };
  }

  return null;
}

/**
 * Executes a resolved catalog shell command through Sky Code's permission layer.
 *
 * The helper deliberately delegates to runShellCommandForPermissionMode so
 * catalog shell commands receive the same permission-mode and approval behavior
 * as other shell execution.
 *
 * @param {ResolvedCatalogShellCommand} resolvedCommand - Resolved shell command.
 * @param {PermissionMode} permissionMode - Active shell permission policy.
 * @param {string} workingDirectory - Directory in which the shell command runs.
 * @param {ApprovalPrompt} approvalPrompt - Optional interactive approval callback.
 * @returns {Promise<ToolExecutionResult>} Shell tool execution result.
 * @throws {Error} If delegated permission handling or shell execution throws.
 *
 * Side effects: may prompt for approval and execute a shell command.
 */
export async function executeCatalogShellCommand(
  resolvedCommand:
    ResolvedCatalogShellCommand,

  permissionMode:
    PermissionMode,

  workingDirectory:
    string,

  approvalPrompt?:
    ApprovalPrompt,
): Promise<ToolExecutionResult> {
  return runShellCommandForPermissionMode(
    resolvedCommand.shellCommand,
    permissionMode,
    workingDirectory,
    approvalPrompt,
  );
}

/**
 * Validates and selects the catalog skills enabled for the current session.
 *
 * Every requested enabled name must exist in the supplied skill collection.
 * Selected skills are returned alphabetically by name. filter() creates a new
 * array before sort(), so the original catalog skill array is not reordered.
 *
 * @param {readonly CatalogSkill[]} skills - Available catalog skills.
 * @param {ReadonlySet<string>} enabledSkillNames - Names requested as enabled.
 * @returns {CatalogSkill[]} Enabled skills sorted by name.
 * @throws {Error} If enabledSkillNames contains a skill absent from `skills`.
 *
 * Side effects: none.
 */
export function selectEnabledCatalogSkills(
  skills:
    readonly CatalogSkill[],

  enabledSkillNames:
    ReadonlySet<string>,
): CatalogSkill[] {
  const knownSkillNames =
    new Set(
      skills.map(
        (
          skill,
        ) =>
          skill.name,
      ),
    );

  for (
    const enabledName of
    enabledSkillNames
  ) {
    if (
      !knownSkillNames.has(
        enabledName,
      )
    ) {
      throw new Error(
        `Unknown catalog skill "${enabledName}"`,
      );
    }
  }

  return skills
    .filter(
      (
        skill,
      ) =>
        enabledSkillNames.has(
          skill.name,
        ),
    )
    .sort(
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
 * Formats active catalog skills as system-prompt lines.
 *
 * An empty active-skill list contributes nothing. Otherwise the returned block
 * begins with a blank separator and heading, followed by each skill description
 * and its system-prompt instructions in the supplied order.
 *
 * @param {readonly CatalogSkill[]} activeSkills - Enabled skills to describe.
 * @returns {string[]} Lines ready to append to a system prompt.
 *
 * Side effects: none.
 */
export function formatCatalogSkillsForPrompt(
  activeSkills:
    readonly CatalogSkill[],
): string[] {
  if (
    activeSkills.length ===
      0
  ) {
    return [];
  }

  const lines = [
    "",
    "Active custom catalog skills:",
  ];

  for (
    const skill of
    activeSkills
  ) {
    lines.push(
      `- ${skill.name}: ${skill.description}`,
    );

    lines.push(
      `  Instructions: ${skill.systemPromptAddition}`,
    );
  }

  return lines;
}

/**
 * Rejects catalog command or skill names that collide with active plugin skills.
 *
 * Plugin command names and plugin skill names are tracked separately. Catalog
 * commands are compared only with plugin commands, and catalog skills only with
 * plugin skill names; errors identify the plugin responsible for the collision.
 *
 * @param {CatalogSnapshot} catalog - Catalog snapshot to validate.
 * @param {readonly ActivePluginSkill[]} pluginSkills - Active plugin skills whose
 * command and skill names are reserved.
 * @returns {void}
 * @throws {Error} If a catalog command conflicts with a plugin command or a
 * catalog skill conflicts with a plugin skill name.
 *
 * Side effects: none.
 */
export function validateCatalogPluginConflicts(
  catalog:
    CatalogSnapshot,

  pluginSkills:
    readonly ActivePluginSkill[],
): void {
  const pluginCommands =
    new Map<
      string,
      string
    >();

  const pluginSkillNames =
    new Map<
      string,
      string
    >();

  for (
    const pluginSkill of
    pluginSkills
  ) {
    pluginCommands.set(
      pluginSkill.command,
      pluginSkill.pluginName,
    );

    pluginSkillNames.set(
      pluginSkill.name,
      pluginSkill.pluginName,
    );
  }

  for (
    const command of
    catalog.commands
  ) {
    const pluginName =
      pluginCommands.get(
        command.name,
      );

    if (
      pluginName !==
        undefined
    ) {
      throw new Error(
        `Catalog command "${command.name}" conflicts with plugin "${pluginName}"`,
      );
    }
  }

  for (
    const skill of
    catalog.skills
  ) {
    const pluginName =
      pluginSkillNames.get(
        skill.name,
      );

    if (
      pluginName !==
        undefined
    ) {
      throw new Error(
        `Catalog skill "${skill.name}" conflicts with plugin "${pluginName}"`,
      );
    }
  }
}
