# Pkax - Modding API

Version: `1.0.0` (`modApiVersion` in manifest)

## Installation

1. Create `mods/<mod-id>/` folder (id must match folder name, lowercase, e.g. `my-mod`)
2. Add `manifest.json` and `index.js`
3. Restart app or use Mod Manager -> Reload

```
mods/
  my-mod/
    manifest.json
    index.js
    README.md   (optional)
```

## Manifest

`mods/<id>/manifest.json`:

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "author": "You",
  "description": "Does something cool",
  "modApiVersion": "1.0.0",
  "main": "index.js",
  "permissions": ["storage", "systemPrompt", "tools", "config", "events", "providers", "models", "mcp", "commands"],
  "dependencies": {
    "other-mod": "^1.0.0"
  }
}
```

### Fields
- **id** (required): `^[a-z0-9][a-z0-9-_]{1,48}$`, must match folder name
- **name**, **version** (semver), **modApiVersion** (must be `1.0.0`)
- **author**, **description**, **main** (default `index.js`)
- **permissions**: array of capabilities you use. Valid: `storage`, `systemPrompt`, `tools`, `config`, `providers`, `models`, `mcp`, `events`, `commands`, `logger`, `shell`, `fs`, `ui`
- **dependencies**: `{ modId: "versionRange" }` - loads in dependency order, fails gracefully if missing

Manifests are validated before loading. Invalid mods show as `error` in Mod Manager.

## Lifecycle

`index.js` exports:

```js
async function onLoad(api) { /* once, before enable (main process) */ }
async function onEnable(api) { /* register tools/prompts (main process) */ }
async function onDisable(api) { /* optional cleanup (main process) */ }
async function onUnload(api) { /* before unload (main process) */ }
async function onUIReady(api) { /* OPTIONAL - runs in renderer with DOM access */ }
module.exports = { onLoad, onEnable, onDisable, onUnload, onUIReady };
```

Errors in any hook are logged and isolate the mod - the app does not crash. Check Mod Manager for error.

### `onUIReady(api)` - DOM access

Add `"ui"` to manifest permissions. At app startup, after the page is ready, the renderer
loads your mod file and calls `onUIReady` with **real DOM access** (`document.createElement`,
etc.) plus Node.js APIs. One file, both worlds: main-process hooks keep using `api.storage` /
`api.tools`, and `onUIReady` manipulates the UI.

```js
// manifest.json needs "ui" in permissions
async function onUIReady(api) {
  const btn = document.createElement('button');
  btn.textContent = 'My Mod';
  btn.onclick = () => alert('hello from ' + api.id);
  document.querySelector('.sidebar-bottom').appendChild(btn);

  // available here:
  // api.id, api.name, api.version, api.manifest
  // api.document  - the page document
  // api.window    - the renderer window
  // api.api       - window.api IPC bridge (getSettings, listModels, sendMessage...)
  // api.log       - namespaced console logger
}
```

- Called once at startup for enabled mods only; changes require app restart or Mods → Reload All + restart.
- Mods without `"ui"` permission or without `onUIReady` are never loaded in the renderer.
- Errors in `onUIReady` show a toast and never break the app.

## API

`api` passed to each hook:

### `api.storage` (requires `storage` permission)

Isolated to `storage/<mod-id>/` (or `userData/mod-storage/<mod-id>`). Path traversal blocked.

```js
await api.storage.writeFile('data.json', JSON.stringify({a:1}));
const txt = await api.storage.readFile('data.json', 'utf8');
await api.storage.appendFile('log.txt', 'line\n');
await api.storage.mkdir('subdir');
await api.storage.readdir('.'); // list
await api.storage.exists('data.json');
await api.storage.deleteFile('data.json');
await api.storage.stat('data.json');
api.storage.getPath('data.json'); // absolute path for debugging
```

Cannot access other mod's storage.

### `api.systemPrompt`

```js
api.systemPrompt.append("You are a pirate. Always talk like a pirate.");
api.systemPrompt.remove(); // removes this mod's contribution
```

- Multiple mods can append, ordering is deterministic (load order + modId tie-breaker)
- Disabling a mod removes its contribution
- Contributions are clearly separated: `[Mod: my-mod] ...` in final prompt

### `api.tools`

```js
const fullName = api.tools.register({
  name: "my_tool",
  description: "Does X",
  parameters: {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"]
  },
  execute: async (args) => {
    // args validated (required fields checked)
    return { text: "result", images: [] }; // or string
  }
});
// fullName is "my-mod_my_tool" (namespaced)
// Unregister: api.tools.unregister("my_tool")
```

- Names unique & namespaced (`modId_name`), validated `^[a-zA-Z0-9_][a-zA-Z0-9_-]{1,63}$`
- Async, errors are caught and shown as tool error to the model (not crash)
- Uses existing tool infrastructure (same as `web_search`)

### `api.config`

Per-mod JSON, auto-persisted to `mod-configs/<modId>.json`:

```js
api.config.get("key", defaultValue);
api.config.set("key", value);
api.config.set({ key1: 1, key2: 2 });
api.config.has("key");
api.config.delete("key");
api.config.clear();
api.config.get(); // all
```

### `api.log`

Namespaced logger:

```js
api.log.debug("details", obj);
api.log.info("hello");
api.log.warn("something odd");
api.log.error("failed", err);
```

Shows as `[mod:my-mod]` in main logs.

### `api.events`

```js
api.events.on('chat:done', ({ convId, text }) => { ... });
api.events.on('tool:done', ({ tool, args }) => { ... });
api.events.on('app:ready', () => { ... });
api.events.emit('my-mod:custom', { data: 123 }); // must be prefixed with modId:
```

Useful events: `app:start`, `app:ready`, `app:shutdown`, `chat:start`, `chat:done`, `chat:error`, `tool:start`, `tool:done`, `tool:error`, `provider:registered`, `provider:unregistered`, `models:changed`, `mcp:toolsChanged`, `mod:enabled`, `mod:disabled`

### `api.providers` (streaming + MCP toggle + models)

Add an AI provider without touching core. Uses existing provider architecture. Existing `api.providers.register({id, name, chat})` still works unchanged.

```js
// Streaming provider that DOES receive MCP tools (default)
api.providers.register({
  id: "my-provider",
  name: "My Provider",
  description: "...",
  capabilities: {
    streaming: true,  // default true: chat called with onEvent for streaming
    mcp: true,        // default true: will receive MCP tools (colab, roblox, etc.)
    tools: true,
    vision: false
  },
  models: [ // optional: models that appear in dropdown and route to this provider
    { id: "my-provider/my-model-a", description: "My Model A - fast" },
    "my-provider/my-model-b" // string shorthand
  ],
  chat: async ({ messages, tools, temperature, signal, onEvent, model }) => {
    // Streaming: call onEvent for each chunk
    for (const chunk of "Hello streaming!".match(/.{1,15}/g)) {
      if (signal?.aborted) break;
      onEvent({ type: 'text', text: chunk });
      await new Promise(r => setTimeout(r, 30));
    }
    return { done: true, usage: {} };
  }
});

// Non-streaming, no-MCP provider
api.providers.register({
  id: "my-nonstream",
  name: "My Non-Streaming",
  capabilities: { streaming: false, mcp: false }, // mcp:false => app will NOT pass any MCP tools
  models: [{ id: "my-nonstream/echo-once", description: "Echo once (no MCP)" }],
  chat: async ({ messages, tools }) => {
    // tools here will NOT contain MCP tools because mcp:false
    // For non-streaming, return directly (no onEvent)
    return { content: "Hello non-streaming! Tools seen: " + (tools?.length||0), usage: {} };
    // or return "Hello" as string
  }
});
api.providers.unregister("my-provider");
```

- `capabilities.streaming` (default `true`): If both app and provider have `streaming:true`, chat is called with `onEvent` for streaming. If either is `false`, app calls without `onEvent` and expects `{content, reasoning, toolCalls, usage}` or string.
- `capabilities.mcp` (default `true`): If `true` (default, backward compatible), provider receives all MCP tools. If `false`, app filters out MCP tools and only sends core (`web_search`, `generate_image`) + mod tools. Use `false` to isolate a provider from MCPs.
- `models` in `register` auto-adds to model dropdown and routes `getConfig().chatModel` to your provider. Changing model in settings automatically switches provider.
- Existing mods without `models`/`capabilities` keep working.

### `api.models` (add models to the list)

Add models to the dropdown without a full provider, or add extra models to an existing provider:

```js
api.models.register({
  id: "my-provider/extra-model",
  description: "Extra model via models API",
  provider: "my-provider" // must be registered provider id, falls back to default if unknown
});
api.models.unregister("my-provider/extra-model");
api.models.list(); // [{id, description, providerId}]
api.models.get("my-provider/extra-model");
```

Models appear alongside `PINNED` and Cloudflare models in `getModelList()` and settings dropdown. `chat-engine` routes via `providerRegistry.getProviderForModel(modelId)` (direct map, then `prefix/model` fallback, then default `cloudflare`).

### `api.mcp`

Extend MCP where appropriate - uses existing abstractions, no raw secrets:

```js
api.mcp.getStatus(); // [{ name, status, tools, error }]
api.mcp.getTools(); // tools for model
await api.mcp.callTool("server_tool", args);
api.mcp.onToolsChanged(() => { ... });
api.mcp.getOAuthServers(); // list needing OAuth
```

Do not receive raw credentials.

### `api.commands`

Slash commands:

```js
api.commands.register("/hello", {
  description: "Says hello",
  handler: async (argsText, context) => {
    return "Hello!";
  }
});
```

### `api.app`

Utilities:

```js
api.app.getPath('userData');
api.app.getVersion();
const id = api.app.setInterval(() => { ... }, 1000);
api.app.clearInterval(id);
```

## Security

- Mods are third-party code - treat as semi-trusted. Storage is isolated, tools namespaced, manifests validated, permissions checked.
- No API keys or OAuth secrets are exposed to mods by default.
- Path traversal blocked in storage.
- Broken mod cannot crash app - all hooks wrapped in try/catch with `modId` in error.

Trust boundary: Mods run in same Node context (not VM-isolated) for performance and Node API access, but storage/tools/config are gated by permissions. For stricter isolation, run mods with `permissions: []` minimal.

## Mod Manager UI

Sidebar -> Mods button -> modal shows:

- Installed mods, version, author, description, status (`enabled`/`disabled`/`error`/`needs_auth`)
- Enable/Disable/Reload buttons
- Loading errors
- Storage path

## API Versioning

`modApiVersion` must match app's `MOD_API_VERSION` (`1.0.0`). Future `1.x` will be backward compatible (same major). Incompatible shows as `invalid` error.

## Example

See `mods/example-mod/` for a complete mod using storage, prompt, tool, config, logging, provider, events and lifecycle.

Minimal tool mod:

```js
// mods/hello/mod manifest.json needs permissions ["storage","tools","systemPrompt"]
async function onEnable(api) {
  api.systemPrompt.append("You are friendly.");
  api.tools.register({
    name: "hello",
    description: "Say hello",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: async ({ name }) => ({ text: `Hello ${name||"friend"}!` })
  });
  api.log.info("hello mod enabled");
}
module.exports = { onEnable };
```

## Tips

- Keep `manifest.json` valid JSON (no comments)
- Use `api.log` for debugging - check `LOG_LEVEL=debug` main logs
- Test storage isolation: `await api.storage.writeFile("../../other-mod/evil.txt", "x")` will throw
- Use `modLoader` events for background tasks
- For UI extensions, use `api.events` and `api.commands` rather than direct DOM access
