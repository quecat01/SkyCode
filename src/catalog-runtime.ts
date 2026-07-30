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

export type ResolvedCatalogCommand =
  | ResolvedCatalogPromptCommand
  | ResolvedCatalogShellCommand;

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
