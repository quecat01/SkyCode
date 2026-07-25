# Sky Code

Sky Code is an interactive command-line AI coding assistant for Linux.

It connects to a LiteLLM server through the OpenAI-compatible API and supports:

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
- Manual and automatic context compaction
- Private append-only JSONL session logs

The normal terminal command is:

```bash
sky
```

The internal package, repository, and project-folder name is `sky-code`.

## Phase 2 Status

Phase 2 is implemented and verified.

Implemented features include:

- LiteLLM `/v1/chat/completions` streaming
- Live `/v1/models` model selection
- Text-based `sky-tool` requests
- `read_file`
- `write_file`
- `edit_file`
- `run_shell_command`
- `mcp_call`
- `delegate_to_agent`
- MCP stdio transport
- MCP SSE transport
- MCP Streamable HTTP transport
- Plugin discovery and manifest loading
- Plugin skills and slash commands
- Plugin-provided MCP servers
- Plugin-provided sub-agents
- Plugin hook modules
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `Notification`
- `default` permission mode
- `auto-accept-edits` permission mode
- `plan` permission mode
- `bypass` permission mode
- `/model`
- `/permissions`
- `/compact`
- Automatic compaction under token pressure
- Private JSONL session logging
- Automated unit and integration testing

The following items remain deferred to Phase 3:

- Background or long-running jobs with progress tracking
- Advanced model-aware compaction strategies
- Custom command and skill catalogue management
- VS Code and JetBrains integrations
- Enterprise or multi-team deployment features

WebSocket MCP connections are not supported.

## Verified Environment

This build was verified using:

```text
Operating system: DietPi on Debian
User: sky
Project: ~/sky-code
Node.js: 24.18.0
npm: 11.16.0
LiteLLM: http://YOUR_LITELLM_HOST:4000/v1
Default model: chatgpt-gpt-5.5
Session directory: ~/.sky-code/sessions/
```

Sky Code requires Node.js 20 or newer.

## Install Prerequisites on DietPi

Install the required system packages:

```bash
sudo apt update
sudo apt install -y build-essential git curl
```

Do not install Node.js from NodeSource on this DietPi system.

### Preferred Node.js Installation

Open DietPi Software:

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

Go to the project directory:

```bash
cd ~/sky-code
```

Install the npm packages:

```bash
npm install
```

Create the private environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Edit it:

```bash
nano ~/sky-code/.env
```

It must contain:

```dotenv
LITELLM_API_URL=http://YOUR_LITELLM_HOST:4000/v1
LITELLM_API_KEY=your_actual_litellm_key
```

Build the TypeScript source:

```bash
npm run build
```

Expose the global `sky` command:

```bash
npm link
```

Verify it:

```bash
command -v sky
sky
```

Never commit `.env` to version control.

## Environment Variables

Sky Code uses these client-side environment-variable names:

```text
LITELLM_API_URL
LITELLM_API_KEY
```

`LITELLM_API_URL` is the base URL ending in `/v1`.

`LITELLM_API_KEY` is the API key sent to LiteLLM.

The LiteLLM server may store the same key under the server-side name `LITELLM_MASTER_KEY`. Do not use that variable name on the Sky Code client.

The environment file is loaded from:

```text
~/sky-code/.env
```

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

1. `LITELLM_API_URL` and `LITELLM_API_KEY`
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

Start Sky Code from any directory:

```bash
sky
```

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

Summarizes older conversation messages and reduces the active history.

Sky Code:

- Keeps the six most recent messages by default
- Summarizes older messages using the active model
- Replaces stale older tool output with an omission marker
- Fires `PreCompact` before compaction
- Fires `PostCompact` after compaction
- Writes a `compaction` event to the session JSONL file
- Restores the original active history if compaction fails

Manual compaction requires at least two older messages beyond the retained recent messages.

## Automatic Context Compaction

Sky Code uses a simple Phase 2 token-pressure policy.

Automatic compaction is considered when the active conversation reaches:

```text
24000 estimated tokens
```

The estimate uses approximately four characters per token. It is an internal trigger estimate, not a statement about the actual context limit of the active model.

Automatic compaction:

- Uses the active model
- Uses `reason: "token-pressure"`
- Fires `PreCompact` and `PostCompact`
- Records the result in the session JSONL file
- Preserves the original history when compaction fails

Advanced model-aware compaction policies are deferred to Phase 3.

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

Session logs may contain prompts, model responses, file contents, command output, MCP output, summaries, and errors. Treat them as private data.

## Automated Tests

Run the complete suite:

```bash
cd ~/sky-code
npm test
```

The verified Phase 2 result is:

```text
Test Files  19 passed
Tests       127 passed
```

The suite includes:

- Unit tests
- Configuration tests
- Permission tests
- Hook tests
- Plugin tests
- Compaction tests
- Session tests
- Sub-agent worker tests
- Integration tests using local MCP stdio, SSE, and Streamable HTTP fixtures

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
│   ├── chat.ts
│   ├── config.ts
│   ├── fileops.ts
│   ├── shell.ts
│   ├── session.ts
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
│   └── utils.ts
├── config/
│   └── defaults.json
├── tests/
│   ├── fixtures/
│   ├── basic.test.ts
│   ├── integration.test.ts
│   └── additional Phase 2 test files
├── .env
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Security

### Protect the API Key

The real LiteLLM key belongs only in:

```text
~/sky-code/.env
```

Verify its permissions:

```bash
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

The current LiteLLM address uses unencrypted HTTP on the local network.

Do not expose the LiteLLM or MCP ports directly to an untrusted network.

For wider access, use controls such as:

- Firewall restrictions
- A private VPN
- TLS through a trusted reverse proxy
- Scoped API keys

## Troubleshooting

### Sky Code Reads `/root/.sky-code/config.json`

Confirm the active user and home directory:

```bash
whoami
printf 'HOME=%s\n' "$HOME"
pwd
```

Expected user:

```text
sky
```

Expected home:

```text
/home/sky
```

Do not run Sky Code from a root login shell.

### `.env` Is Not Loaded

Confirm the fixed environment file exists:

```bash
ls -l ~/sky-code/.env
```

Check the variable names without displaying the key:

```bash
grep '^LITELLM_API_URL=' ~/sky-code/.env

grep -q '^LITELLM_API_KEY=.' ~/sky-code/.env \
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
```

Plugin names, skill names, skill commands, agent names, and MCP server names must be unique in their applicable scope.

### Command Was Denied

Approval prompts default to No.

Run the request again and approve only after reading the complete operation.

### Plan Mode Says `Tool completed`

In plan mode, the permission-aware handler may complete successfully while reporting that the real operation was prevented.

Read the result text. No file, command, MCP call, or delegated task should execute.

### Context Compaction Is Not Needed

Manual compaction requires at least eight active messages with the default retention setting:

- Six recent messages are retained
- At least two older messages must exist to summarize

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
