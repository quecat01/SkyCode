# Sky Code

Sky Code is an interactive command-line AI coding assistant for Linux, designed for developers who want AI-assisted coding directly in the terminal.

Sky Code requires Node.js 20 or newer and works with LiteLLM or any OpenAI-compatible API endpoint, including self-hosted LiteLLM, Ollama, OpenAI directly, and OpenRouter.

It supports:

- Interactive first-time setup wizard
- Streamed AI conversations
- Live model selection
- File reading, writing, and editing
- Shell command execution
- MCP servers using stdio, SSE, and Streamable HTTP
- Project, global, and configured plugins
- Plugin skills and slash commands
- Lifecycle hooks
- Sub-agent worker processes
- Four permission modes
- Configurable manual and automatic context compaction
- Background tasks with terminal progress tracking
- Custom command and skill catalog management
- Current-session history search
- Directory-specific session resume
- Startup LiteLLM health checks
- Cleaner plain-language error messages
- Private append-only JSONL session logs
- No WebSocket MCP connections

The normal terminal command is:

```bash
sky
```

The internal package, repository, and project-folder name is `sky-code`.

## Requirements and Tested Platforms

Sky Code requires:

- Linux
- Node.js 20 or newer
- npm
- LiteLLM or another OpenAI-compatible API endpoint
- An API key when required by the configured endpoint

Sky Code has been tested on DietPi, a Debian-based Linux distribution.

## Install Prerequisites on Linux

On Debian and Debian-based Linux distributions, install the required system packages:

```bash
sudo apt update
sudo apt install -y build-essential git curl
```

Install Node.js 20 or newer using a supported method for your Linux distribution.

### Optional DietPi Note

On DietPi, Node.js can also be installed through DietPi Software:

```bash
sudo dietpi-software
```

Use its search function to find and install Node.js.

### Alternative Node.js Installation with NVM

Install NVM:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
```

Load NVM:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

Install the current Node.js LTS release:

```bash
nvm install --lts
nvm alias default 'lts/*'
```

Verify the installation:

```bash
node -v
npm -v
command -v node
```

## Install Sky Code

Clone the repository:

```bash
git clone https://github.com/quecat01/SkyCode ~/sky-code
cd ~/sky-code
```

Install the npm packages:

```bash
npm install
```

Build the TypeScript source:

```bash
npm run build
```

Expose the global `sky` command:

```bash
npm link
```

Run the setup wizard to configure your endpoint, API key, default model, and permission mode:

```bash
sky setup
```

The wizard will guide you through each step, test the connection to your AI endpoint, and write your configuration automatically. When setup is complete, start Sky Code with:

```bash
sky
```

### Manual Configuration (Alternative to `sky setup`)

If you prefer to configure Sky Code manually instead of using the wizard, create the environment file:

```bash
cp .env.example .env
chmod 600 .env
nano ~/sky-code/.env
```

It must contain:

```dotenv
LITELLM_API_URL=http://YOUR_LITELLM_HOST:4000/v1
LITELLM_API_KEY=your_api_key_here
```

Then create the global configuration file:

```bash
mkdir -p ~/.sky-code
nano ~/.sky-code/config.json
```

See the Configuration Files section for the full schema.

Never commit `.env` to version control.

## Environment Variables

Sky Code uses these client-side environment-variable names:

```text
LITELLM_API_URL
LITELLM_API_KEY
```

`LITELLM_API_URL` is the base URL ending in `/v1`.

`LITELLM_API_KEY` is the API key sent to the configured endpoint.

The LiteLLM server may store the same key under the server-side name `LITELLM_MASTER_KEY`. Do not use that variable name on the Sky Code client.

Environment variables are loaded from these locations, checked in order:

```text
~/sky-code/.env          (project directory, takes priority)
~/.sky-code/.env         (written by sky setup, used as fallback)
```

`sky setup` writes credentials to `~/.sky-code/.env`. If you set environment variables in a shell profile or pass them directly, those take the highest priority.

The API key is not read from `config.json`.

## Configuration Files

Built-in defaults are stored at:

```text
~/sky-code/config/defaults.json
```

Optional global configuration:

```text
~/.sky-code/config.json
```

Optional project configuration:

```text
.sky-code/config.json
```

Configuration priority is:

1. `LITELLM_API_URL` and `LITELLM_API_KEY` environment variables
2. Project `.sky-code/config.json`
3. Global `~/.sky-code/config.json`
4. Built-in `config/defaults.json`

When the same configuration key appears in multiple JSON files, the higher-priority file replaces the lower-priority value.

### Complete Configuration Example

```json
{
  "apiUrl": "http://YOUR_LITELLM_HOST:4000/v1",
  "defaultModel": "chatgpt-gpt-5.5",
  "defaultPermissionMode": "default",
  "compactionThreshold": 6000,
  "compactionStrategy": "summarise",
  "compactionWindowSize": 20,
  "mcpServers": [
    {
      "name": "local-example",
      "transport": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/server.mjs"
      ],
      "cwd": "/absolute/path/to",
      "env": {
        "EXAMPLE_SETTING": "enabled"
      }
    },
    {
      "name": "network-sse-example",
      "transport": "sse",
      "url": "http://127.0.0.1:3000/sse",
      "headers": {
        "Authorization": "Bearer example-token"
      }
    },
    {
      "name": "network-http-example",
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer example-token"
      }
    }
  ],
  "pluginDirs": [
    "/opt/sky-code/plugins",
    "./local-plugins"
  ]
}
```

### Configuration Fields

#### `apiUrl`

The LiteLLM base URL.

Example:

```json
"apiUrl": "http://YOUR_LITELLM_HOST:4000/v1"
```

`LITELLM_API_URL` overrides this field.

#### `defaultModel`

The model selected when Sky Code starts.

Example:

```json
"defaultModel": "chatgpt-gpt-5.5"
```

#### `defaultPermissionMode`

The permission mode selected when Sky Code starts.

Allowed values are:

```text
default
auto-accept-edits
plan
bypass
```

#### `mcpServers`

An array of MCP server definitions.

Every server requires:

- `name`: A non-empty name unique within the active configuration
- `transport`: `stdio`, `sse`, or `http`

Configured server names must also be unique when combined with plugin-provided MCP servers.

#### `pluginDirs`

An array of additional directories to scan for `.sky-code-plugin` folders.

An absolute path is used directly.

A relative path is resolved from the project directory where Sky Code was started.

Every entry must be a non-empty string.

#### `compactionThreshold`

The estimated active-conversation token count that triggers automatic compaction.

Default:

```json
"compactionThreshold": 6000
```

A lower value triggers compaction more frequently. A higher value allows a larger active conversation before compaction.

#### `compactionStrategy`

Controls how Sky Code reduces older conversation material.

Allowed values are:

```text
summarise
sliding-window
```

Default:

```json
"compactionStrategy": "summarise"
```

The `summarise` strategy compresses older turns into a summary and drops stale tool output.

The `sliding-window` strategy removes older turns and keeps only the most recent configured number.

#### `compactionWindowSize`

The number of recent turns retained when `compactionStrategy` is `sliding-window`.

Default:

```json
"compactionWindowSize": 20
```

This setting is used only by the `sliding-window` strategy.

## MCP Server Configuration

### stdio MCP Server

A stdio server is a local process started by Sky Code.

Required fields:

- `name`
- `transport`
- `command`
- `args`

Optional fields:

- `cwd`
- `env`

Example:

```json
{
  "name": "local-files",
  "transport": "stdio",
  "command": "node",
  "args": [
    "~/mcp/local-files-server.mjs"
  ],
  "cwd": "~/mcp",
  "env": {
    "SERVER_MODE": "read-only"
  }
}
```

`args` must be an array of strings.

Every value in `env` must be a string.

### SSE MCP Server

An SSE server is an HTTP service using the legacy MCP Server-Sent Events transport.

Required fields:

- `name`
- `transport`
- `url`

Optional field:

- `headers`

Example:

```json
{
  "name": "legacy-network-service",
  "transport": "sse",
  "url": "http://YOUR_MCP_SERVER_HOST:3000/sse",
  "headers": {
    "Authorization": "Bearer example-token"
  }
}
```

The URL must begin with `http://` or `https://`.

### Streamable HTTP MCP Server

The `http` transport uses MCP Streamable HTTP.

Required fields:

- `name`
- `transport`
- `url`

Optional field:

- `headers`

Example:

```json
{
  "name": "network-service",
  "transport": "http",
  "url": "http://YOUR_MCP_SERVER_HOST:3000/mcp",
  "headers": {
    "Authorization": "Bearer example-token"
  }
}
```

The URL must begin with `http://` or `https://`.

WebSocket URLs beginning with `ws://` or `wss://` are rejected for both SSE and Streamable HTTP.

Every header value must be a string.

## Run Sky Code

### First-Time Setup

If Sky Code has not been configured yet, run the setup wizard first:

```bash
sky setup
```

The wizard will ask for your API endpoint URL, API key, default model, and permission mode, test the connection, and write your configuration automatically.

If you run `sky` before completing setup, Sky Code will display:

```text
Sky Code is not configured yet.
Run 'sky setup' to get started.
```

### Starting Sky Code

Start Sky Code from any directory:

```bash
sky
```

Before displaying the normal chat prompt, Sky Code performs a silent startup health check.

It verifies:

- `LITELLM_API_URL` is configured
- `LITELLM_API_KEY` is configured
- The configured LiteLLM server is reachable

When all checks pass, startup continues normally without an extra success message.

If a check fails, Sky Code displays a plain-language explanation before the chat prompt appears. The message identifies the failed startup operation and explains what configuration or service should be checked.

### Session Resume on Startup

Sky Code associates session history with the directory where it was started.

When a previous session exists for that directory, Sky Code asks whether to:

1. Resume the previous conversation
2. Start with a fresh conversation

Choosing resume restores the reconstructed conversation messages into the active context.

Choosing fresh starts with an empty active conversation.

The startup display reports:

- LiteLLM address
- Active model
- Permission mode
- Session-log path
- Plugin count
- Plugin-skill count
- Sub-agent count
- Plugin commands
- Hook count
- MCP-server count
- MCP-tool count

Close Sky Code with:

```text
Ctrl+C
```

Sky Code writes a final `session_end` record before closing.

## Built-in Commands

### `sky setup`

Runs the interactive first-time configuration wizard.

```bash
sky setup
```

The wizard guides you through:

- API endpoint URL
- API key (hidden input)
- Connection test against the configured endpoint
- Default model selection from the live model list
- Default permission mode selection

Configuration is written to `~/.sky-code/config.json` and `~/.sky-code/.env`.

If Sky Code is already configured, the wizard asks before overwriting existing settings.

### `/model`

Displays the live model list from:

```text
GET /v1/models
```

Select a model number to change the model for the current session.

The selection is not written permanently to configuration.

### `/permissions`

Displays the current permission mode and allows you to select one of the four modes.

The change takes effect immediately for the current session.

### `/compact`

Runs manual context compaction using the configured compaction strategy.

Example:

```text
/compact
```

After compaction, Sky Code displays a one-line report showing how many turns were compacted and the estimated token reduction.

If the conversation does not contain enough older material to compact, Sky Code reports that compaction was not needed and leaves the active history unchanged.

### `/tasks`

Lists currently running background tasks.

Example:

```text
/tasks
```

Each listed task includes an ID that can be used to cancel it.

### `/tasks cancel <id>`

Cancels a running background task by its ID.

Example:

```text
/tasks cancel 7f9a2c
```

Replace `7f9a2c` with the ID displayed by `/tasks`.

### `/catalog list`

Displays all custom commands and skills. It also shows whether each skill is enabled or disabled for the current session.

Example:

```text
/catalog list
```

### `/catalog add <file>`

Imports one command or skill from a JSON file.

Example:

```text
/catalog add ./review-command.json
```

The imported definition is stored under:

```text
~/.sky-code/catalog/
```

### `/catalog remove <name>`

Removes a custom command or skill by name.

Examples:

```text
/catalog remove /review-file
/catalog remove careful-review
```

### `/catalog enable <name>`

Enables a custom skill for the current session.

Example:

```text
/catalog enable careful-review
```

The active system prompt is updated immediately. Sky Code does not need to restart.

### `/catalog disable <name>`

Disables a custom skill for the current session.

Example:

```text
/catalog disable careful-review
```

The active system prompt is updated immediately.

### `/history search <term>`

Searches the current session JSONL log for matching turns.

Example:

```text
/history search connection refused
```

Matching entries are displayed with timestamps in session order.

## Background Tasks

Long-running tasks can run without blocking the main chat prompt.

While a background task is running:

- The `You:` prompt remains available
- Progress updates appear in the terminal
- The task can complete, fail, or be cancelled
- Started, progress, completed, failed, and cancelled events are recorded in the JSONL session log
- The `Notification` hook fires when a task starts, completes, or fails

If Sky Code closes while a background task is running, the task is cancelled cleanly and the cancellation is recorded.

Use:

```text
/tasks
```

to list running tasks.

Use:

```text
/tasks cancel <id>
```

to cancel one.

## Configurable Context Compaction

Sky Code can reduce a growing active conversation automatically or when `/compact` is entered.

The compaction settings are stored in global or project `config.json`:

```json
{
  "compactionThreshold": 6000,
  "compactionStrategy": "summarise",
  "compactionWindowSize": 20
}
```

### `summarise` Strategy

This is the default strategy.

It:

- Summarises older conversation turns
- Keeps recent conversation material active
- Drops stale older tool output
- Preserves useful older context in compressed form

This strategy is useful when earlier decisions and discussion may still matter.

The trade-off is that it uses a model call to create the summary.

### `sliding-window` Strategy

This strategy keeps only the most recent configured number of turns.

The number retained is controlled by:

```json
"compactionWindowSize": 20
```

This strategy is simple and predictable and does not need a model-generated summary.

The trade-off is that turns outside the window are removed rather than preserved in summary form.

### Automatic Compaction

Automatic compaction is triggered when the estimated active conversation size exceeds:

```json
"compactionThreshold": 6000
```

The value is an estimated token count used as the trigger.

Automatic and manual compaction:

- Use the configured compaction strategy
- Fire `PreCompact` before compaction
- Fire `PostCompact` after successful compaction
- Write a `compaction` event to the session JSONL file
- Leave the original active history unchanged if compaction fails
- Display a one-line report showing how many turns were compacted and the estimated token reduction

## Custom Command and Skill Catalog

Custom commands and skills are stored as individual JSON files under:

```text
~/.sky-code/catalog/
```

Catalog changes take effect immediately in the current session. Sky Code does not need to restart.

Catalog commands and skills are also available through the plugin system so plugins can bundle them.

### Custom Prompt Command

A prompt command defines a slash command, a description, and a prompt template.

Example:

```json
{
  "type": "command",
  "name": "/summarise",
  "description": "Ask the AI to summarise the current file",
  "prompt": "Please summarise the contents of {{file}} in plain language."
}
```

Example use:

```text
/summarise ~/project/example.ts
```

### Custom Shell Command

A shell command defines a slash command, a description, and a shell command to run.

Example:

```json
{
  "type": "command",
  "name": "/project-status",
  "description": "Show the current Git working-tree status",
  "shell": "git status --short --branch"
}
```

Catalog shell commands follow the active permission mode.

### Custom Skill

A skill adds reusable instructions to the system prompt when it is enabled.

Example:

```json
{
  "type": "skill",
  "name": "python-style",
  "description": "Apply Python style guidelines to all code suggestions",
  "systemPromptAddition": "Always follow PEP 8 style guidelines when writing or editing Python code."
}
```

Enable it for the current session:

```text
/catalog enable python-style
```

Disable it:

```text
/catalog disable python-style
```

Remove it from the catalog:

```text
/catalog remove python-style
```

## Session History Search

Every user and assistant turn is written to the current private JSONL session log.

Search the current session without opening the JSONL file manually:

```text
/history search <term>
```

Example:

```text
/history search build failed
```

Sky Code returns matching turns with their timestamps.

## Cleaner Error Messages

Sky Code reports startup, model, catalog, history, compaction, background-task, and shutdown failures in plain language.

Instead of exposing raw internal error objects or full stack traces during normal CLI use, it reports:

- Which operation failed
- The safely extracted reason
- A practical next step when one is available

Credential-like values are removed from formatted error output.

## Local and Extended Tools

Sky Code supports these tool names:

```text
read_file
write_file
edit_file
run_shell_command
mcp_call
delegate_to_agent
```

### `read_file`

Reads a text file.

Argument:

```text
path
```

### `write_file`

Creates or replaces a text file.

Arguments:

```text
path
content
```

### `edit_file`

Replaces one exact occurrence of text in a file.

Arguments:

```text
path
old_str
new_str
```

The edit is rejected when the old text is missing or appears more than once.

### `run_shell_command`

Runs a command through `/bin/bash` in Sky Code's current working directory.

Argument:

```text
command
```

### `mcp_call`

Calls a tool exposed by a connected MCP server.

Arguments:

```text
server
name
arguments
```

### `delegate_to_agent`

Runs a delegated task in a separate Node.js worker process.

Arguments:

```text
agent
task
context
```

`context` is optional.

## Tool-Calling Protocol

The model requests a tool using a fenced `sky-tool` block:

````text
```sky-tool
{"tool":"read_file","args":{"path":"~/example.txt"}}
```
````

Sky Code parses the JSON, executes the appropriate permission-aware handler, returns the result to the model, and lets the model continue.

The protocol works even when the selected model does not support native function calling.

## Permission Modes

### `default`

Approval is required before:

- Writing a file
- Editing a file
- Running a shell command

File reads, MCP calls, and sub-agent delegation do not prompt for approval in this mode.

### `auto-accept-edits`

File writes and edits run without approval.

Shell commands still require approval.

### `plan`

No tool performs its real action.

Sky Code returns a description of the operation it would have performed.

This includes file operations, shell commands, MCP calls, and sub-agent delegation.

### `bypass`

All tools run without approval prompts.

**WARNING: Bypass mode is high risk. File changes, shell commands, MCP calls, and delegated tasks can execute immediately. Use it only when you trust the current request, active model, project, plugins, and MCP servers.**

## Plugin System

A plugin is a folder named:

```text
.sky-code-plugin
```

The folder must contain:

```text
plugin.json
```

### Plugin Discovery Locations

Sky Code checks these locations when it starts.

#### Current project plugin

```text
CURRENT_PROJECT/.sky-code-plugin/
```

#### Global plugins

Sky Code recursively searches under:

```text
~/.sky-code/plugins/
```

A global plugin may therefore be stored at:

```text
~/.sky-code/plugins/example/.sky-code-plugin/
```

#### Configured plugin directories

Sky Code recursively searches every path in `pluginDirs`.

Duplicate physical paths are removed after resolving their real paths.

Duplicate plugin names are rejected.

## Complete `plugin.json` Example

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "description": "Adds an example skill, agent, hook, and MCP server.",
  "skills": [
    {
      "name": "review-code",
      "description": "Review supplied code for concrete problems.",
      "prompt": "Review the supplied code and report concrete correctness problems.",
      "command": "/review"
    }
  ],
  "agents": [
    {
      "name": "focused-reviewer",
      "description": "Reviews one delegated coding task.",
      "systemPrompt": "Review the delegated task carefully and return verified findings.",
      "model": "chatgpt-gpt-5.5"
    }
  ],
  "hooks": [
    {
      "name": "PostToolUse",
      "module": "./hooks.mjs",
      "export": "afterTool"
    }
  ],
  "mcpServers": [
    {
      "name": "example-plugin-server",
      "transport": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/example-server.mjs"
      ]
    }
  ]
}
```

All seven top-level fields are required:

```text
name
version
description
skills
agents
hooks
mcpServers
```

Use an empty array when a plugin does not provide a particular feature.

Example:

```json
{
  "name": "skill-only-plugin",
  "version": "1.0.0",
  "description": "Provides one skill.",
  "skills": [
    {
      "name": "summarize-file",
      "description": "Summarize a file.",
      "prompt": "Read the requested file and provide a concise factual summary."
    }
  ],
  "agents": [],
  "hooks": [],
  "mcpServers": []
}
```

## `plugin.json` Field Reference

### `name`

Required non-empty plugin name.

Plugin names must be unique across project, global, and configured plugins.

### `version`

Required non-empty version text.

Example:

```json
"version": "1.0.0"
```

### `description`

Required non-empty description of the plugin.

### `skills`

Required array of skill objects.

Each skill supports:

- `name`
- `description`
- `prompt`
- `command`

#### Skill `name`

Required.

It may use only:

- Lowercase letters
- Numbers
- Hyphens
- Underscores

It must begin with a lowercase letter or number.

#### Skill `description`

Required plain-language description shown to the model.

#### Skill `prompt`

Required instructions added to the model conversation when the skill command is used.

#### Skill `command`

Optional slash command.

When omitted, Sky Code uses:

```text
/<skill-name>
```

A command must begin with `/` and may contain only lowercase letters, numbers, hyphens, and underscores.

These built-in commands are reserved:

```text
/model
/permissions
/compact
/tasks
/catalog
/history
```

Duplicate skill names or commands are rejected.

A command can include user arguments.

Example:

```text
/review ~/project/example.ts
```

Sky Code combines the plugin instructions with the text after the command.

### `agents`

Required array of sub-agent objects.

Each agent supports:

- `name`
- `description`
- `systemPrompt`
- `model`

#### Agent `name`

Required.

It follows the same lowercase-letter, number, hyphen, and underscore rules as a skill name.

Agent names must be unique across all loaded plugins.

#### Agent `description`

Required plain-language description.

#### Agent `systemPrompt`

Required instructions for the delegated worker.

#### Agent `model`

Optional model override.

When omitted, the sub-agent uses the active Sky Code model.

Sub-agents run in separate Node.js child processes and communicate with the main process using Node.js IPC messages.

The `Notification` hook fires when a delegated worker starts, completes, or fails.

### `hooks`

Required array of hook objects.

Each hook supports:

- `name`
- `module`
- `export`

#### Hook `name`

Required.

Allowed values are exactly:

```text
PreToolUse
PostToolUse
PreCompact
PostCompact
Notification
```

#### Hook `module`

Required relative module path inside the plugin directory.

Example:

```json
"module": "./hooks.mjs"
```

Absolute module paths are rejected.

A path that resolves outside the plugin directory is rejected.

#### Hook `export`

Optional exported function name.

When omitted, Sky Code loads the module's default export.

Example manifest entry:

```json
{
  "name": "PostToolUse",
  "module": "./hooks.mjs",
  "export": "afterTool"
}
```

Matching hook module:

```javascript
export function afterTool(event) {
  event.metadata.examplePluginObservedTool = true;
}
```

Plugin hooks run sequentially in registration order.

A hook failure is reported with the hook name and source.

### `mcpServers`

Required array using the same stdio, SSE, and Streamable HTTP schema as `config.json`.

Plugin MCP server names must not conflict with:

- Another plugin MCP server
- A server in Sky Code configuration

## Hook Lifecycle

### `PreToolUse`

Fires immediately before a local tool, MCP call, or delegated-agent handler runs.

It may cancel a tool by setting:

```javascript
event.cancelled = true;
event.cancellationReason = "Reason for cancellation";
```

### `PostToolUse`

Fires after the permission-aware tool handler completes.

It receives the tool request, result, and shared metadata.

### `PreCompact`

Fires before manual or automatic compaction.

It receives the message count, reason, estimated tokens, and metadata.

### `PostCompact`

Fires after compaction succeeds.

It receives the before count, after count, summary, and metadata.

### `Notification`

Fires for sub-agent lifecycle notifications.

Notification levels are:

```text
info
warning
error
```

## Session Logs

Session files are stored at:

```text
~/.sky-code/sessions/
```

Each session uses one append-only `.jsonl` file.

Each line is one complete JSON object.

Recorded event types include:

```text
session_start
message
tool_result
compaction
session_end
```

Background-task started, progress, completed, failed, and cancelled events are also recorded in the active session log.

A compaction record may include:

```text
reason
beforeMessageCount
afterMessageCount
estimatedTokens
droppedToolOutputCount
summary
model
```

Session files are created with permissions:

```text
600
```

Only the owning user can read or modify them.

List recent sessions:

```bash
ls -lt ~/.sky-code/sessions
```

Display a session:

```bash
cat ~/.sky-code/sessions/SESSION_FILENAME.jsonl
```

Search the current session from inside Sky Code:

```text
/history search <term>
```

If Sky Code finds a previous session for the directory where it starts, it offers to reconstruct and resume that conversation or begin a fresh one.

Session logs may contain prompts, model responses, file contents, command output, MCP output, summaries, background-task progress, and errors. Treat them as private data.

## Automated Tests

Run the complete suite:

```bash
cd ~/sky-code
npm test
```

The verified test result is:

```text
Test Files  50 passed
Tests       296 passed
```

The suite includes:

- Unit tests
- Configuration tests
- Permission tests
- Hook tests
- Plugin tests
- Background-task tests
- Advanced compaction tests
- Catalog loading and management tests
- History-search tests
- Session-resume tests
- Startup-health tests
- Setup-wizard tests
- Error-reporting tests
- Sub-agent worker tests
- Integration tests
- Live source-wiring tests
- Local MCP stdio, SSE, and Streamable HTTP fixtures

LiteLLM responses are mocked in automated tests. The tests do not expose or use the real LiteLLM API key.

## Development Commands

Build:

```bash
npm run build
```

Run from the repository:

```bash
npm start
```

Run globally:

```bash
sky
```

Run the setup wizard:

```bash
sky setup
```

Run tests once:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Run the development auto-reloader:

```bash
npm run dev
```

## Project Structure

```text
~/sky-code/
├── src/
│   ├── index.ts
│   ├── setup.ts
│   ├── chat.ts
│   ├── config.ts
│   ├── fileops.ts
│   ├── shell.ts
│   ├── session.ts
│   ├── session-resume.ts
│   ├── session-resume-prompt.ts
│   ├── history.ts
│   ├── tools.ts
│   ├── toolhandlers.ts
│   ├── mcp.ts
│   ├── plugins.ts
│   ├── hooks.ts
│   ├── agents.ts
│   ├── agent-worker.ts
│   ├── permissions.ts
│   ├── compact.ts
│   ├── compact-model.ts
│   ├── compact-runtime.ts
│   ├── background.ts
│   ├── background-commands.ts
│   ├── background-session.ts
│   ├── background-terminal.ts
│   ├── background-turn.ts
│   ├── catalog.ts
│   ├── catalog-management.ts
│   ├── catalog-runtime.ts
│   ├── startup-health.ts
│   ├── error-reporting.ts
│   └── utils.ts
├── config/
│   └── defaults.json
├── tests/
│   ├── fixtures/
│   ├── basic.test.ts
│   ├── integration.test.ts
│   ├── setup.test.ts
│   └── additional test files
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Security

### Protect the API Key

The real API key belongs only in your environment files:

```text
~/.sky-code/.env     (written by sky setup)
~/sky-code/.env      (manual configuration)
```

Verify permissions on either file:

```bash
stat -c "%a %U %n" ~/.sky-code/.env
stat -c "%a %U %n" ~/sky-code/.env
```

Expected permissions:

```text
600
```

Never include the key in source code, plugin manifests, screenshots, messages, or Git commits.

A scoped LiteLLM virtual key is safer than a master key because it can have narrower permissions and limits.

### Plugin Trust

Plugins execute local JavaScript hook modules and may introduce MCP servers and sub-agents.

Only install plugins you trust.

Review the following before starting Sky Code:

- `plugin.json`
- Hook modules
- MCP commands and URLs
- Environment variables
- Agent prompts

### Shell Risk

Shell commands run with the permissions of the current Linux user.

Avoid running Sky Code as `root`.

Read every command before approving it.

Bypass mode removes the approval protection.

### Network Risk

If your configured LiteLLM or MCP endpoint uses plain HTTP, use it only on a trusted private network.

For connections over an untrusted network, use TLS (`https://`) directly on the endpoint or through a trusted reverse proxy.

Do not expose LiteLLM or MCP ports directly to an untrusted network.

Additional controls can include:

- Firewall restrictions
- A private VPN
- Scoped API keys

## Troubleshooting

### Sky Code Is Not Configured Yet

If you see:

```text
Sky Code is not configured yet.
Run 'sky setup' to get started.
```

Run the setup wizard:

```bash
sky setup
```

### Sky Code Reads Configuration from the Wrong Home Directory

Confirm the active user and home directory:

```bash
whoami
printf 'USER=%s\n' "$USER"
printf 'HOME=%s\n' "$HOME"
pwd
```

Sky Code should run under the non-root Linux account that owns the installation. For example:

```text
USER=your-username
HOME=/home/your-username
```

Do not run Sky Code from a root login shell.

### `.env` Is Not Loaded

Confirm the environment file exists in one of the expected locations:

```bash
ls -l ~/.sky-code/.env
ls -l ~/sky-code/.env
```

Check the variable names without displaying the key:

```bash
grep '^LITELLM_API_URL=' ~/.sky-code/.env
grep -q '^LITELLM_API_KEY=.' ~/.sky-code/.env \
  && echo "API key is present" \
  || echo "API key is missing"
```

### LiteLLM Returns 401

Confirm the client variable is:

```dotenv
LITELLM_API_KEY=
```

Do not use `LITELLM_MASTER_KEY` as the client-side variable name.

### LiteLLM Connection Is Refused

Test the model endpoint:

```bash
curl http://YOUR_LITELLM_HOST:4000/v1/models \
  -H "Authorization: Bearer YOUR_LITELLM_API_KEY"
```

### MCP Server Cannot Connect

Check:

- The transport name
- The command or URL
- Required headers
- Required environment variables
- File permissions
- Server logs
- Whether the URL uses `http://` or `https://`

WebSocket URLs are unsupported.

### Plugin Does Not Load

Confirm the directory name and manifest:

```bash
find ~/sky-code \
  -type f \
  -path '*/.sky-code-plugin/plugin.json' \
  -print
```

Every manifest must contain all required top-level fields, including empty arrays.

### Plugin Command Conflicts

Plugins cannot use:

```text
/model
/permissions
/compact
/tasks
/catalog
/history
```

Plugin names, skill names, skill commands, agent names, and MCP server names must be unique in their applicable scope.

### Command Was Denied

Approval prompts default to No.

Run the request again and approve only after reading the complete operation.

### Plan Mode Says `Tool completed`

In plan mode, the permission-aware handler may complete successfully while reporting that the real operation was prevented.

Read the result text. No file, command, MCP call, or delegated task should execute.

### Context Compaction Is Not Needed

Manual `/compact` may report that compaction is not needed.

This can happen when:

- The active conversation is still small
- There are not enough older turns for the `summarise` strategy
- The active history does not exceed `compactionWindowSize` when using `sliding-window`

This is normal. Sky Code leaves the active conversation unchanged.

Review the active global configuration:

```bash
cat ~/.sky-code/config.json
```

Also check for a project-specific configuration in the directory where Sky Code was started:

```bash
cat .sky-code/config.json
```

The relevant settings are:

```json
{
  "compactionThreshold": 6000,
  "compactionStrategy": "summarise",
  "compactionWindowSize": 20
}
```

### TypeScript Build Fails

Run:

```bash
cd ~/sky-code
npm install
npm run build
```

### Tests Fail

Run the failing test alone, then run the full suite.

Example:

```bash
npx vitest run ~/sky-code/tests/integration.test.ts
npm test
```
