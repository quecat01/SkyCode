import { constants } from "node:fs";

import {
  copyFile,
  readFile,
  rm,
} from "node:fs/promises";

import {
  basename,
  extname,
  join,
  resolve,
} from "node:path";

import {
  loadCatalog,
  parseCatalogItem,
  type CatalogItem,
  type CatalogSkill,
  type CatalogSnapshot,
} from "./catalog.js";

import {
  selectEnabledCatalogSkills,
  validateCatalogPluginConflicts,
} from "./catalog-runtime.js";

import type {
  ActivePluginSkill,
} from "./plugins.js";

export type CatalogManagementCommand =
  | {
      action:
        "list";
    }
  | {
      action:
        "add";

      file:
        string;
    }
  | {
      action:
        "remove";

      name:
        string;
    }
  | {
      action:
        "enable";

      name:
        string;
    }
  | {
      action:
        "disable";

      name:
        string;
    };

export interface CatalogManagementResult {
  message:
    string;

  catalog:
    CatalogSnapshot;

  activeSkills:
    CatalogSkill[];
}

export interface CatalogManagerOptions {
  catalog:
    CatalogSnapshot;

  pluginSkills?:
    readonly ActivePluginSkill[];

  workingDirectory?:
    string;
}

function requireArgument(
  value:
    string,

  usage:
    string,
): string {
  const trimmedValue =
    value.trim();

  if (
    trimmedValue ===
      ""
  ) {
    throw new Error(
      `Missing catalog command argument. Usage: ${usage}`,
    );
  }

  return trimmedValue;
}

export function parseCatalogManagementCommand(
  userInput:
    string,
): CatalogManagementCommand | null {
  const trimmedInput =
    userInput.trim();

  if (
    trimmedInput ===
      "/catalog"
  ) {
    throw new Error(
      "Usage: /catalog list | add <file> | remove <name> | enable <name> | disable <name>",
    );
  }

  if (
    !trimmedInput.startsWith(
      "/catalog ",
    )
  ) {
    return null;
  }

  const remainder =
    trimmedInput
      .slice(
        "/catalog ".length,
      )
      .trim();

  const firstSpace =
    remainder.indexOf(
      " ",
    );

  const action =
    (
      firstSpace ===
        -1
        ? remainder
        : remainder.slice(
            0,
            firstSpace,
          )
    ).trim();

  const argument =
    firstSpace ===
      -1
      ? ""
      : remainder
          .slice(
            firstSpace +
              1,
          )
          .trim();

  switch (
    action
  ) {
    case "list":
      if (
        argument !==
          ""
      ) {
        throw new Error(
          "Usage: /catalog list",
        );
      }

      return {
        action:
          "list",
      };

    case "add":
      return {
        action:
          "add",

        file:
          requireArgument(
            argument,
            "/catalog add <file>",
          ),
      };

    case "remove":
      return {
        action:
          "remove",

        name:
          requireArgument(
            argument,
            "/catalog remove <name>",
          ),
      };

    case "enable":
      return {
        action:
          "enable",

        name:
          requireArgument(
            argument,
            "/catalog enable <name>",
          ),
      };

    case "disable":
      return {
        action:
          "disable",

        name:
          requireArgument(
            argument,
            "/catalog disable <name>",
          ),
      };

    default:
      throw new Error(
        `Unknown catalog action "${action}". Usage: /catalog list | add <file> | remove <name> | enable <name> | disable <name>`,
      );
  }
}

function formatCatalogList(
  catalog:
    CatalogSnapshot,

  enabledSkillNames:
    ReadonlySet<string>,
): string {
  const lines = [
    "Custom catalog:",
  ];

  if (
    catalog.commands.length ===
      0
  ) {
    lines.push(
      "Commands: none",
    );
  } else {
    lines.push(
      "Commands:",
    );

    for (
      const command of
      catalog.commands
    ) {
      lines.push(
        `- ${command.name}: ${command.description}`,
      );
    }
  }

  if (
    catalog.skills.length ===
      0
  ) {
    lines.push(
      "Skills: none",
    );
  } else {
    lines.push(
      "Skills:",
    );

    for (
      const skill of
      catalog.skills
    ) {
      const status =
        enabledSkillNames.has(
          skill.name,
        )
          ? "enabled"
          : "disabled";

      lines.push(
        `- ${skill.name} (${status}): ${skill.description}`,
      );
    }
  }

  return lines.join(
    "\n",
  );
}

async function readAndValidateImportFile(
  filePath:
    string,
): Promise<CatalogItem> {
  let contents:
    string;

  try {
    contents =
      await readFile(
        filePath,
        "utf8",
      );
  } catch (error) {
    throw new Error(
      `Unable to read catalog import file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  let parsed:
    unknown;

  try {
    parsed =
      JSON.parse(
        contents,
      );
  } catch (error) {
    throw new Error(
      `Unable to parse catalog import file ${filePath}: ${
        error instanceof
          Error
          ? error.message
          : String(
              error,
            )
      }`,
    );
  }

  return parseCatalogItem(
    parsed,
    filePath,
  );
}

export class CatalogManager {
  private catalog:
    CatalogSnapshot;

  private readonly pluginSkills:
    readonly ActivePluginSkill[];

  private readonly workingDirectory:
    string;

  private readonly enabledSkillNames =
    new Set<string>();

  constructor(
    options:
      CatalogManagerOptions,
  ) {
    this.catalog =
      options.catalog;

    this.pluginSkills =
      options.pluginSkills ??
      [];

    this.workingDirectory =
      options.workingDirectory ??
      process.cwd();

    validateCatalogPluginConflicts(
      this.catalog,
      this.pluginSkills,
    );
  }

  getSnapshot():
    CatalogSnapshot {
    return this.catalog;
  }

  getEnabledSkillNames():
    ReadonlySet<string> {
    return new Set(
      this.enabledSkillNames,
    );
  }

  getActiveSkills():
    CatalogSkill[] {
    return selectEnabledCatalogSkills(
      this.catalog.skills,
      this.enabledSkillNames,
    );
  }

  private createResult(
    message:
      string,
  ): CatalogManagementResult {
    return {
      message,

      catalog:
        this.catalog,

      activeSkills:
        this.getActiveSkills(),
    };
  }

  private async reload():
    Promise<void> {
    this.catalog =
      await loadCatalog({
        catalogDirectory:
          this.catalog.directory,
      });

    validateCatalogPluginConflicts(
      this.catalog,
      this.pluginSkills,
    );

    const availableSkillNames =
      new Set(
        this.catalog.skills.map(
          (
            skill,
          ) =>
            skill.name,
        ),
      );

    for (
      const enabledName of
      this.enabledSkillNames
    ) {
      if (
        !availableSkillNames.has(
          enabledName,
        )
      ) {
        this.enabledSkillNames.delete(
          enabledName,
        );
      }
    }
  }

  async execute(
    command:
      CatalogManagementCommand,
  ): Promise<CatalogManagementResult> {
    switch (
      command.action
    ) {
      case "list":
        return this.createResult(
          formatCatalogList(
            this.catalog,
            this.enabledSkillNames,
          ),
        );

      case "add":
        return this.add(
          command.file,
        );

      case "remove":
        return this.remove(
          command.name,
        );

      case "enable":
        return this.enable(
          command.name,
        );

      case "disable":
        return this.disable(
          command.name,
        );
    }
  }

  private async add(
    requestedPath:
      string,
  ): Promise<CatalogManagementResult> {
    const sourcePath =
      resolve(
        this.workingDirectory,
        requestedPath,
      );

    if (
      extname(
        sourcePath,
      ).toLowerCase() !==
        ".json"
    ) {
      throw new Error(
        "Catalog import files must use the .json extension.",
      );
    }

    const item =
      await readAndValidateImportFile(
        sourcePath,
      );

    const destinationPath =
      join(
        this.catalog.directory,
        basename(
          sourcePath,
        ),
      );

    if (
      sourcePath ===
        destinationPath
    ) {
      throw new Error(
        `Catalog item is already stored at ${destinationPath}`,
      );
    }

    try {
      await copyFile(
        sourcePath,
        destinationPath,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      const nodeError =
        error as
          NodeJS.ErrnoException;

      if (
        nodeError.code ===
          "EEXIST"
      ) {
        throw new Error(
          [
            `Catalog file "${basename(sourcePath)}" already exists in ${this.catalog.directory}.`,
            "Rename or remove the existing catalog file before adding another file with the same name.",
          ].join(
            " ",
          ),
        );
      }

      throw error;
    }

    try {
      await this.reload();
    } catch (error) {
      await rm(
        destinationPath,
        {
          force:
            true,
        },
      );

      await this.reload();

      throw error;
    }

    return this.createResult(
      `Added catalog ${item.type} "${item.name}".`,
    );
  }

  private async remove(
    name:
      string,
  ): Promise<CatalogManagementResult> {
    const item =
      this.catalog.items.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      item ===
        undefined
    ) {
      throw new Error(
        `Catalog item "${name}" was not found.`,
      );
    }

    await rm(
      item.filePath,
    );

    this.enabledSkillNames.delete(
      item.name,
    );

    await this.reload();

    return this.createResult(
      `Removed catalog ${item.type} "${item.name}".`,
    );
  }

  private enable(
    name:
      string,
  ): CatalogManagementResult {
    const skill =
      this.catalog.skills.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      skill ===
        undefined
    ) {
      throw new Error(
        `Catalog skill "${name}" was not found.`,
      );
    }

    this.enabledSkillNames.add(
      skill.name,
    );

    return this.createResult(
      `Enabled catalog skill "${skill.name}" for this session.`,
    );
  }

  private disable(
    name:
      string,
  ): CatalogManagementResult {
    const skill =
      this.catalog.skills.find(
        (
          candidate,
        ) =>
          candidate.name ===
            name,
      );

    if (
      skill ===
        undefined
    ) {
      throw new Error(
        `Catalog skill "${name}" was not found.`,
      );
    }

    this.enabledSkillNames.delete(
      skill.name,
    );

    return this.createResult(
      `Disabled catalog skill "${skill.name}" for this session.`,
    );
  }
}
