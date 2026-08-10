/**
 * Lifecycle hook registration, execution, and plugin-hook loading for Sky Code.
 *
 * Hooks let built-in code and plugins observe or influence specific runtime
 * events such as tool execution, conversation compaction, and notifications.
 * HookRegistry provides ordered registration and dispatch, while plugin helpers
 * validate hook manifest entries, confine imported modules to the plugin
 * directory, dynamically load handlers, and roll back partial registration if
 * plugin-hook loading fails.
 */
import {
  realpath,
} from "node:fs/promises";

import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  pathToFileURL,
} from "node:url";

import type {
  LoadedPlugin,
} from "./plugins.js";

import {
  executeSkyToolRequest,
  type SkyToolRequest,
  type ToolExecutionResult,
  type ToolHandlers,
} from "./tools.js";

/**
 * Hook event names currently supported by Sky Code.
 *
 * The readonly tuple is also the runtime source used by isHookName(), keeping
 * the runtime validation list aligned with the HookName TypeScript union.
 */
export const HOOK_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const;

/**
 * Union of every supported Sky Code hook name.
 */
export type HookName =
  (typeof HOOK_NAMES)[number];

/**
 * Mutable cross-hook metadata associated with one lifecycle operation.
 *
 * Hooks may attach arbitrary values so later hooks in the same operation can
 * share contextual information without changing the primary event fields.
 */
export type HookMetadata =
  Record<string, unknown>;

/**
 * Event supplied before a Sky Code tool request is executed.
 *
 * A handler may set cancelled to true and optionally provide
 * cancellationReason to prevent the underlying tool from running.
 */
export interface PreToolUseHookEvent {
  request: SkyToolRequest;
  cancelled: boolean;
  cancellationReason?: string;
  metadata: HookMetadata;
}

/**
 * Event supplied after a Sky Code tool request finishes.
 *
 * The same metadata object created for PreToolUse is reused here.
 */
export interface PostToolUseHookEvent {
  request: SkyToolRequest;
  result: ToolExecutionResult;
  metadata: HookMetadata;
}

/**
 * Event emitted before conversation compaction begins.
 *
 * estimatedTokens is optional because a token estimate may not be available for
 * every compaction path.
 */
export interface PreCompactHookEvent {
  messageCount: number;
  reason: string;
  estimatedTokens?: number;
  metadata: HookMetadata;
}

/**
 * Event emitted after conversation compaction completes.
 *
 * summary is optional because not every compaction implementation necessarily
 * exposes its generated summary text.
 */
export interface PostCompactHookEvent {
  beforeMessageCount: number;
  afterMessageCount: number;
  summary?: string;
  metadata: HookMetadata;
}

/**
 * Severity assigned to a Notification hook event.
 */
export type NotificationLevel =
  | "info"
  | "warning"
  | "error";

/**
 * Event emitted when Sky Code exposes a notification to hook consumers.
 */
export interface NotificationHookEvent {
  level: NotificationLevel;
  message: string;
  metadata: HookMetadata;
}

/**
 * Type mapping from each HookName to the event object delivered to handlers.
 *
 * This map allows HookHandler and HookRegistry.run() to remain strongly typed
 * for the specific event being registered or dispatched.
 */
export interface HookEventMap {
  PreToolUse:
    PreToolUseHookEvent;

  PostToolUse:
    PostToolUseHookEvent;

  PreCompact:
    PreCompactHookEvent;

  PostCompact:
    PostCompactHookEvent;

  Notification:
    NotificationHookEvent;
}

/**
 * Synchronous or asynchronous handler for one typed Sky Code hook event.
 *
 * @template Name - Hook name whose corresponding event type is accepted.
 */
export type HookHandler<
  Name extends HookName,
> = (
  event: HookEventMap[Name],
) => void | Promise<void>;

/**
 * Optional metadata supplied when registering a hook handler.
 *
 * source is used only for diagnostics and listing; blank values fall back to
 * "anonymous".
 */
export interface HookRegistrationOptions {
  source?: string;
}

/**
 * Public summary of one hook registration.
 *
 * Handler functions are intentionally omitted from this inspection shape.
 */
export interface RegisteredHook {
  name: HookName;
  source: string;
}

/**
 * Fully validated plugin hook ready for dynamic import and registration.
 *
 * moduleSpecifier preserves the manifest value, modulePath is its canonical
 * filesystem target, exportName identifies the exported handler, and source is
 * the human-readable diagnostic label used by HookRegistry.
 */
export interface ResolvedPluginHook {
  name: HookName;
  moduleSpecifier: string;
  modulePath: string;
  exportName: string;
  pluginName: string;
  pluginDirectory: string;
  source: string;
}

/**
 * Internal registry entry retaining the strongly typed handler function.
 *
 * @template Name - Hook name associated with this registration.
 */
interface StoredHookRegistration<
  Name extends HookName =
    HookName,
> {
  name: Name;
  source: string;
  handler: HookHandler<Name>;
}

/**
 * Checks whether an unknown value is one of Sky Code's supported hook names.
 *
 * @param {unknown} value - Runtime value to validate.
 * @returns {boolean} True when value is a supported HookName.
 */
export function isHookName(
  value: unknown,
): value is HookName {
  return (
    typeof value ===
      "string" &&
    HOOK_NAMES.includes(
      value as HookName,
    )
  );
}

/**
 * Ordered in-memory registry for Sky Code lifecycle hooks.
 *
 * Registrations execute in insertion order for a given hook name. Handlers are
 * awaited sequentially so later handlers observe mutations made by earlier
 * handlers to the shared event object.
 */
export class HookRegistry {
  private readonly registrations:
    StoredHookRegistration[] = [];

  /**
   * Registers one hook handler and returns an idempotent unregister callback.
   *
   * Blank or omitted source labels become "anonymous". Calling the returned
   * callback more than once has no additional effect.
   *
   * @template Name - Hook name being registered.
   * @param {Name} name - Hook event to subscribe to.
   * @param {HookHandler<Name>} handler - Handler invoked for that event.
   * @param {HookRegistrationOptions} options - Optional diagnostic source label.
   * @returns {() => void} Callback that removes this registration.
   *
   * Side effect: appends a registration to this registry.
   */
  public register<
    Name extends HookName,
  >(
    name: Name,
    handler: HookHandler<Name>,
    options:
      HookRegistrationOptions = {},
  ): () => void {
    const source =
      options.source?.trim() ||
      "anonymous";

    const registration:
      StoredHookRegistration<Name> = {
        name,
        source,
        handler,
      };

    this.registrations.push(
      registration as
        unknown as
        StoredHookRegistration,
    );

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;

      const index =
        this.registrations
          .indexOf(
            registration as
              unknown as
              StoredHookRegistration,
          );

      if (index >= 0) {
        this.registrations.splice(
          index,
          1,
        );
      }
    };
  }

  /**
   * Executes all handlers currently registered for one hook name.
   *
   * Matching registrations are snapshotted before execution, so registrations
   * added or removed while a run is in progress do not alter the current
   * dispatch set. Handlers run sequentially and may mutate the shared event.
   *
   * @template Name - Hook name being dispatched.
   * @param {Name} name - Hook event to run.
   * @param {HookEventMap[Name]} event - Shared event object for all handlers.
   * @returns {Promise<void>} Resolves after every matching handler succeeds.
   * @throws {Error} If a handler fails; the error identifies the hook and its
   * registration source.
   *
   * Side effect: invokes registered hook handlers in registration order.
   */
  public async run<
    Name extends HookName,
  >(
    name: Name,
    event: HookEventMap[Name],
  ): Promise<void> {
    // Snapshot matching registrations so mutations to the registry during a
    // handler affect future runs rather than this in-progress dispatch.
    const matchingRegistrations =
      this.registrations.filter(
        (
          registration,
        ) =>
          registration.name ===
          name,
      );

    for (
      const registration of
      matchingRegistrations
    ) {
      try {
        const handler =
          registration.handler as
            HookHandler<Name>;

        await handler(event);
      } catch (error) {
        throw new Error(
          `Hook ${name} from ${registration.source} failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Counts registrations in the registry.
   *
   * @param {HookName} name - Optional hook name to filter by.
   * @returns {number} Total registrations, or registrations for name when given.
   */
  public count(
    name?: HookName,
  ): number {
    if (name === undefined) {
      return this.registrations
        .length;
    }

    return this.registrations.filter(
      (
        registration,
      ) =>
        registration.name ===
        name,
    ).length;
  }

  /**
   * Returns public metadata for all registrations in insertion order.
   *
   * @returns {RegisteredHook[]} Hook names and source labels without handlers.
   */
  public list():
    RegisteredHook[] {
    return this.registrations.map(
      (
        registration,
      ) => ({
        name:
          registration.name,
        source:
          registration.source,
      }),
    );
  }

  /**
   * Removes every hook registration.
   *
   * @returns {void}
   *
   * Side effect: empties this registry immediately.
   */
  public clear():
    void {
    this.registrations.splice(
      0,
      this.registrations.length,
    );
  }
}


/**
 * Executes a Sky Code tool request through the PreToolUse/PostToolUse lifecycle.
 *
 * One metadata object is shared between the pre- and post-tool events. Pre-tool
 * handlers may cancel execution by setting event.cancelled. A cancelled request
 * returns a failed ToolExecutionResult immediately, so the actual tool and
 * PostToolUse hooks are not run.
 *
 * When execution proceeds, PostToolUse receives the tool result before it is
 * returned to the caller.
 *
 * @param {SkyToolRequest} request - Tool request to execute.
 * @param {ToolHandlers} handlers - Tool handler implementation used for the
 * actual request.
 * @param {HookRegistry} registry - Registry providing pre/post tool hooks.
 * @returns {Promise<ToolExecutionResult>} Cancellation result or executed tool
 * result after post-tool hooks complete.
 * @throws {Error} If a hook fails or executeSkyToolRequest() throws.
 *
 * Side effects: executes registered hooks and may execute the requested tool.
 */
export async function executeSkyToolRequestWithHooks(
  request: SkyToolRequest,
  handlers: ToolHandlers,
  registry: HookRegistry,
): Promise<ToolExecutionResult> {
  // PreToolUse and PostToolUse intentionally share the same metadata object
  // so hooks can pass contextual information across the tool lifecycle.
  const metadata:
    HookMetadata = {};

  const preToolEvent:
    PreToolUseHookEvent = {
      request,
      cancelled:
        false,
      metadata,
    };

  // PreToolUse runs before any handler dispatch, allowing hooks to veto the
  // request without producing tool side effects.
  await registry.run(
    "PreToolUse",
    preToolEvent,
  );

  if (
    preToolEvent.cancelled
  ) {
    const cancellationReason =
      preToolEvent
        .cancellationReason
        ?.trim();

    return {
      success:
        false,
      output:
        cancellationReason
          ? `Tool ${request.tool} cancelled by PreToolUse hook: ${cancellationReason}`
          : `Tool ${request.tool} cancelled by PreToolUse hook.`,
    };
  }

  // Only requests that survived pre-hook cancellation reach the actual tool.
  const result =
    await executeSkyToolRequest(
      request,
      handlers,
    );

  const postToolEvent:
    PostToolUseHookEvent = {
      request,
      result,
      metadata,
    };

  await registry.run(
    "PostToolUse",
    postToolEvent,
  );

  return postToolEvent.result;
}


/**
 * Checks whether an unknown plugin hook entry is a non-null, non-array object.
 *
 * @param {unknown} value - Manifest value to inspect.
 * @returns {boolean} True when the value can be treated as an object record.
 */
function isPluginHookRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validates and trims a required text field from a plugin hook manifest entry.
 *
 * @param {unknown} value - Raw manifest field value.
 * @param {string} fieldName - Field path shown in validation diagnostics.
 * @param {string} manifestPath - Plugin manifest containing the field.
 * @returns {string} Trimmed non-empty text.
 * @throws {Error} If the value is not a string or is empty after trimming.
 */
function requirePluginHookText(
  value: unknown,
  fieldName: string,
  manifestPath: string,
): string {
  if (
    typeof value !==
      "string" ||
    value.trim() ===
      ""
  ) {
    throw new Error(
      `Plugin manifest ${manifestPath}: ${fieldName} must be a non-empty string`,
    );
  }

  return value.trim();
}

/**
 * Validates and resolves one raw plugin hook manifest entry.
 *
 * Hook names must be supported, module paths must be relative, and export
 * defaults to "default". Both the plugin directory and target module are
 * canonicalized with realpath(). The resulting canonical module must remain
 * inside the canonical plugin directory, which prevents `..` paths and symlink
 * targets from escaping the plugin boundary.
 *
 * @param {LoadedPlugin} plugin - Plugin owning the hook declaration.
 * @param {unknown} entry - Raw hooks[index] manifest value.
 * @param {number} index - Zero-based manifest hook index used in diagnostics.
 * @returns {Promise<ResolvedPluginHook>} Validated canonical hook definition.
 * @throws {Error} If the entry is malformed, uses an unsupported hook name,
 * specifies an absolute module, cannot resolve paths, or resolves outside the
 * plugin directory.
 *
 * Side effects: resolves plugin and module paths through the filesystem.
 */
async function resolvePluginHook(
  plugin: LoadedPlugin,
  entry: unknown,
  index: number,
): Promise<ResolvedPluginHook> {
  const fieldName =
    `hooks[${index}]`;

  if (
    !isPluginHookRecord(
      entry,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName} must be a JSON object`,
    );
  }

  const hookNameValue =
    requirePluginHookText(
      entry.name,
      `${fieldName}.name`,
      plugin.manifestPath,
    );

  if (
    !isHookName(
      hookNameValue,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.name must be one of ${HOOK_NAMES.join(", ")}`,
    );
  }

  const moduleSpecifier =
    requirePluginHookText(
      entry.module,
      `${fieldName}.module`,
      plugin.manifestPath,
    );

  if (
    isAbsolute(
      moduleSpecifier,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.module must be a relative path inside the plugin directory`,
    );
  }

  const exportName =
    entry.export ===
      undefined
      ? "default"
      : requirePluginHookText(
          entry.export,
          `${fieldName}.export`,
          plugin.manifestPath,
        );

  let pluginDirectory:
    string;

  try {
    pluginDirectory =
      await realpath(
        plugin.directory,
      );
  } catch (error) {
    throw new Error(
      `Unable to resolve plugin directory ${plugin.directory}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  // Resolve the manifest-relative module only after canonicalizing the plugin
  // root used as the security boundary.
  const requestedModulePath =
    resolve(
      pluginDirectory,
      moduleSpecifier,
    );

  let modulePath:
    string;

  try {
    modulePath =
      await realpath(
        requestedModulePath,
      );
  } catch (error) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: unable to resolve hook module ${moduleSpecifier}: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }

  // Compare canonical paths so a symlink inside the plugin cannot silently
  // point to executable code outside the plugin directory.
  const relativeModulePath =
    relative(
      pluginDirectory,
      modulePath,
    );

  if (
    relativeModulePath ===
      ".." ||
    relativeModulePath.startsWith(
      `..${sep}`,
    ) ||
    isAbsolute(
      relativeModulePath,
    )
  ) {
    throw new Error(
      `Plugin manifest ${plugin.manifestPath}: ${fieldName}.module resolves outside the plugin directory`,
    );
  }

  return {
    name:
      hookNameValue,
    moduleSpecifier,
    modulePath,
    exportName,
    pluginName:
      plugin.name,
    pluginDirectory,
    source:
      `plugin "${plugin.name}" hook ${hookNameValue} (${moduleSpecifier}#${exportName})`,
  };
}

/**
 * Resolves, imports, and registers every hook declared by loaded plugins.
 *
 * Hook modules are dynamically imported from their validated canonical paths.
 * The requested export must be a function. Registration is transactional for
 * this call: if any later hook fails to resolve, import, or validate, all hooks
 * registered earlier by this call are unregistered in reverse order before the
 * original error is rethrown.
 *
 * @param {readonly LoadedPlugin[]} plugins - Loaded plugins containing raw hook
 * manifest entries.
 * @param {HookRegistry} registry - Registry receiving validated hook handlers.
 * @returns {Promise<ResolvedPluginHook[]>} Registered hooks in processing order.
 * @throws {Error} If hook resolution, dynamic import, export validation, or
 * registration processing fails.
 *
 * Side effects: resolves filesystem paths, dynamically imports plugin modules,
 * and mutates the supplied HookRegistry.
 */
export async function registerPluginHooks(
  plugins:
    readonly LoadedPlugin[],
  registry:
    HookRegistry,
): Promise<ResolvedPluginHook[]> {
  const resolvedHooks:
    ResolvedPluginHook[] = [];

  const unregisterCallbacks:
    Array<() => void> = [];

  try {
    for (
      const plugin of plugins
    ) {
      for (
        let index = 0;
        index <
        plugin.hooks.length;
        index += 1
      ) {
        const resolvedHook =
          await resolvePluginHook(
            plugin,
            plugin.hooks[index],
            index,
          );

        let moduleNamespace:
          Record<string, unknown>;

        // Convert the canonical filesystem path to a file URL before dynamic
        // import so Node handles platform-specific path syntax correctly.
        try {
          moduleNamespace =
            await import(
              pathToFileURL(
                resolvedHook
                  .modulePath,
              ).href
            ) as
              Record<string, unknown>;
        } catch (error) {
          throw new Error(
            `Unable to import ${resolvedHook.source}: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          );
        }

        const exportedHandler =
          moduleNamespace[
            resolvedHook
              .exportName
          ];

        if (
          typeof exportedHandler !==
            "function"
        ) {
          throw new Error(
            `${resolvedHook.source} must export a function`,
          );
        }

        const unregister =
          registry.register(
            resolvedHook.name,
            exportedHandler as
              unknown as
              HookHandler<
                typeof resolvedHook.name
              >,
            {
              source:
                resolvedHook.source,
            },
          );

        unregisterCallbacks.push(
          unregister,
        );

        resolvedHooks.push(
          resolvedHook,
        );
      }
    }
  // Registration is all-or-nothing for this load operation. Undo successful
  // earlier registrations in reverse order if a later plugin hook fails.
  } catch (error) {
    for (
      const unregister of
      unregisterCallbacks
        .reverse()
    ) {
      unregister();
    }

    throw error;
  }

  return resolvedHooks;
}
