# Nexus AI

Local-first Electron desktop chat client for Cloudflare Workers AI. Streaming chat with
reasoning, vision (image attachments), web search, image generation, audio transcription,
MCP tool access (e.g. Roblox Studio), and persistent conversations.

## Features

- **Chat**: streaming markdown, collapsible reasoning ("thinking"), code highlighting, stop generation.
- **Models**: `@cf/qwen/qwen3.8-27b` (vision + function calling + reasoning), `@cf/black-forest-labs/flux-1-schnell` (image gen), `@cf/openai/whisper` (audio transcription).
- **Web search**: DuckDuckGo (no API key) — auto-injected before each request when enabled, plus an on-demand `web_search` tool.
- **Image generation**: dedicated Image Studio panel or let the model call the `generate_image` tool; save to disk or send into chat.
- **File attachments**: images (vision), audio (whisper), text files (inlined), PDFs (metadata).
- **MCP tools**: loaded from `%APPDATA%\Nexus AI\config\config.jsonc` only. Tool names are namespaced `server_tool`. Tool calls render as expandable cards in chat.
- **Settings**: temperature, max tokens, reasoning effort, web search toggle/result count, tool-approval mode, model picker.

## Setup

1. `npm install` (run `npm approve-scripts electron esbuild` if postinstall scripts are blocked).
2. `npm start` to launch. On first run the app asks for your Cloudflare **Account ID** and **API
   token** (Workers AI) and saves them to `%APPDATA%\Nexus AI\config\cloudflare.json`. Models default
   to `@cf/qwen/qwen3.8-27b` / `@cf/black-forest-labs/flux-1-schnell`.

## Data locations

Everything lives under `%APPDATA%\Nexus AI` (created and seeded on first run from the project files):

| Path | Purpose |
|---|---|
| `%APPDATA%\Nexus AI\store.json` | Conversations + settings |
| `%APPDATA%\Nexus AI\mods\` | Installed mods |
| `%APPDATA%\Nexus AI\mod-storage\<modId>\` | Per-mod sandboxed storage |
| `%APPDATA%\Nexus AI\mod-configs\<modId>.json` | Per-mod settings |
| `%APPDATA%\Nexus AI\config\config.jsonc` | MCP server configuration (seeded from project) |
| `%APPDATA%\Nexus AI\config\credentials.json` | MCP OAuth tokens (seeded from project) |
| `%APPDATA%\Nexus AI\config\cloudflare.json` | Cloudflare Account ID + API token + model prefs |

MCP servers are loaded **only** from `%APPDATA%\Nexus AI\config\config.jsonc` — no opencode or
other external config locations are consulted.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Launch the app |
| `npm run build:renderer` | Rebuild `renderer/bundle.js` + `bundle.css` from `renderer/app.js` (esbuild) |
| `npm run build` | build:renderer |
| `npm run dist` | Package Windows installer (electron-builder NSIS) |
| `node scripts/test-tool-loop.js` | E2E: web search tool loop against live API |
| `node scripts/test-e2e.js` | E2E: full engine + MCP + search |
| `node scripts/test-image-tool.js` | E2E: model-driven image generation via `generate_image` tool |
| `npx electron . --smoke-test` | Boot app, dump renderer state, exit |

## Architecture

```
electron/main.js         app lifecycle, BrowserWindow, IPC handlers
electron/chat-engine.js  Store (persistence), ChatEngine (streaming tool loop), attachments
electron/cf-client.js    Cloudflare AI REST client (streaming SSE, image gen, whisper, model list)
electron/mcp-manager.js  spawns local MCP servers (stdio), namespaces tools, callTool()
electron/websearch.js    DuckDuckGo search (html + lite fallback)
electron/config.js       JSONC config loader, MCP server discovery, credential resolution
electron/appdata.js      AppData layout (%APPDATA%\Nexus AI): mods/, config/, seeding
electron/preload.js      contextBridge API
renderer/app.js          UI (esbuild → bundle.js; marked + DOMPurify + highlight.js)
```

## Notes

- Credentials live in `%APPDATA%\Nexus AI\config\cloudflare.json` (gitignored via AppData); the token never enters the renderer.
- MCP servers must be `"type": "local"` and are filtered by `enabled !== false`; command env vars like `%LOCALAPPDATA%` are expanded.
- First run of a `uvx`-based MCP server can take a while to download its package — the MCP panel shows status and a retry button.
- The image endpoint may occasionally return "Capacity temporarily exceeded" on free tier; the model retries on its own (the tool loop handles it).
