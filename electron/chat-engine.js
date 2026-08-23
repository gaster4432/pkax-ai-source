'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { getConfig } = require('./config');
const cf = require('./cf-client');
const { search } = require('./websearch');
const { debug, info, warn, error: logError } = require('./logger');
// Mod integrations (graceful fallback if mods not yet loaded)
let promptRegistry = null;
let toolRegistry = null;
let providerRegistry = null;
let modBus = null;
let MOD_EVENTS = null;
try { promptRegistry = require('./mods/system-prompt').registry; } catch {}
try { toolRegistry = require('./mods/tools').toolRegistry; } catch {}
try { providerRegistry = require('./mods/providers').providerRegistry; } catch {}
try { const ev = require('./mods/events'); modBus = ev.bus; MOD_EVENTS = ev.EVENTS; } catch {}

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'opus', 'aac'];
const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'kt', 'html', 'css', 'scss', 'xml',
  'csv', 'log', 'yml', 'yaml', 'sql', 'sh', 'bat', 'ps1', 'toml', 'ini', 'env', 'gitignore',
  'lua', 'rb', 'php', 'swift', 'r', 'jl', 'vue', 'svelte', 'astro', 'conf', 'cfg'];

const DEFAULT_SETTINGS = {
  temperature: 0.7,
  maxTokens: 8192,
  reasoningEffort: '',      // '' | 'low' | 'medium' | 'high'
  webSearchEnabled: true,
  webSearchResults: 5,
  requireToolApproval: false,
  autoImageGen: true,
};

const MAX_ATTACH_SIZE = 12 * 1024 * 1024;
const MAX_TEXT_INLINE = 50 * 1024;

// ---------------------------------------------------------------- store

class Store {
  constructor(file) {
    this.file = file;
    this.data = { conversations: [], settings: { ...DEFAULT_SETTINGS } };
    this._load();
  }
  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.data.conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
        this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) };
      }
    } catch (err) {
      console.error('[store] failed to load:', err.message);
      try {
        // backup corrupted file for recovery
        const backup = this.file + '.corrupt-' + Date.now() + '.bak';
        fs.renameSync(this.file, backup);
        console.error('[store] corrupted file backed up to', backup);
      } catch { /* ignore backup failure */ }
    }
  }
  save() {
    try {
      const dir = require('path').dirname(this.file);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const tmp = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] failed to save:', err.message);
    }
  }
  list() {
    return this.data.conversations
      .map(c => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id) {
    return this.data.conversations.find(c => c.id === id) || null;
  }
  create() {
    const conv = {
      id: crypto.randomUUID(),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    this.data.conversations.push(conv);
    this.save();
    return conv;
  }
  delete(id) {
    this.data.conversations = this.data.conversations.filter(c => c.id !== id);
    this.save();
  }
  rename(id, title) {
    const conv = this.get(id);
    if (conv) {
      conv.title = title.slice(0, 120);
      conv.updatedAt = Date.now();
      this.save();
    }
  }
  append(id, message) {
    const conv = this.get(id);
    if (!conv) return null;
    conv.messages.push(message);
    conv.updatedAt = Date.now();
    if (conv.title === 'New chat' && message.role === 'user') {
      const text = String(message.content || '').replace(/\s+/g, ' ').trim();
      conv.title = text.length > 42 ? text.slice(0, 42) + '…' : (text || 'New chat');
    }
    this.save();
    return conv;
  }
  getSettings() { return { ...this.data.settings }; }
  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }
}

// ---------------------------------------------------------------- chat engine

function toCfMessages(convMessages, attachmentsForLastUser) {
  const out = [];
  for (const m of convMessages) {
    if (m.role === 'user') {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images || []) parts.push({ type: 'image_url', image_url: { url: img } });
      if (m.attachments?.length) {
        const fileText = m.attachments.map(a =>
          a.inline ? `\n[Attached file ${a.name} (${a.type})]\n${a.inline}` : `\n[Attached file: ${a.name} (${a.type}, ${a.size})]`
        ).join('\n');
        if (fileText) parts.push({ type: 'text', text: fileText });
      }
      out.push(parts.length ? { role: 'user', content: parts } : { role: 'user', content: '' });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls || undefined,
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    }
  }
  return out;
}

function systemPrompt(settings, serverStatus) {
  // Simple assistant prompt as requested - memory mod will append permanent memories here
  const base = 'You are a helpful assistant.';
  // Append mod-provided system prompt contributions deterministically
  try {
    if (promptRegistry) {
      const modSection = promptRegistry.buildSection();
      if (modSection) return base + '\n' + modSection;
    }
  } catch (e) { warn('chat', `mod prompt build failed: ${e.message}`); }
  return base;
}

class ChatEngine {
  constructor({ store, mcp, send }) {
    this.store = store;
    this.mcp = mcp;
    this.emit = send; // (channel, payload) -> webContents
    this.active = new Map(); // convId -> AbortController
    this.pendingApprovals = new Map(); // id -> {resolve, reject}
  }

  stop(convId) {
    this.active.get(convId)?.abort();
  }

  // Helper to get chat provider (mod-extensible) - supports model-based routing and streaming
  _getProvider(settings, modelId) {
    try {
      if (providerRegistry) {
        // If a specific model is requested, try to find its provider
        if (modelId) {
          const forModel = providerRegistry.getProviderForModel(modelId);
          if (forModel) return forModel;
        }
        if (settings.provider && providerRegistry.has(settings.provider)) {
          return providerRegistry.get(settings.provider);
        }
        return providerRegistry.getDefault();
      }
    } catch {}
    return null;
  }

  async send({ convId, text, images, attachments }) {
    const tSendStart = Date.now();
    // Auto-create conversation if no ID or not found (ChatGPT-like behavior)
    let autoCreated = false;
    let originalConvId = convId;
    if (!convId) {
      const newConv = this.store.create();
      convId = newConv.id;
      autoCreated = true;
      info('chat', `auto-created new conversation ${convId} (no convId provided)`);
      this.emit('conv:changed', { convId, list: this.store.list(), autoCreated: true });
    } else {
      const existing = this.store.get(convId);
      if (!existing) {
        const newConv = this.store.create();
        convId = newConv.id;
        autoCreated = true;
        info('chat', `auto-created new conversation ${convId} (requested ${originalConvId} not found - likely cleared)`);
        this.emit('conv:changed', { convId, list: this.store.list(), autoCreated: true, oldId: originalConvId });
      }
    }

    if (this.active.has(convId)) {
      warn('chat', `send blocked conv=${convId} already active`);
      return { error: 'A generation is already running in this conversation.' };
    }
    const controller = new AbortController();
    this.active.set(convId, controller);
    const settings = this.store.getSettings();
    info('chat', `send start conv=${convId}${autoCreated ? ' (auto-created)' : ''} textLen=${(text||'').length} images=${images?.length||0} attachments=${attachments?.length||0} model=${getConfig().chatModel} provider=${settings.provider||'cloudflare'} webSearch=${settings.webSearchEnabled} temp=${settings.temperature}`);
    debug('chat', `send payload textPreview=${(text||'').slice(0,150).replace(/\n/g,' ')} attachments=${JSON.stringify(attachments||[]).slice(0,300)}`);
    if (modBus) modBus.emitSafe(MOD_EVENTS.CHAT_START, { convId, text, images, attachments, autoCreated });
    try {
      const conv = this.store.get(convId);
      if (!conv) {
        logError('chat', `send conv not found ${convId} even after auto-create`);
        return { error: 'Conversation not found.' };
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        images: images || [],
        attachments: attachments || [],
        ts: Date.now(),
      };
      this.store.append(convId, userMsg);
      this.emit('conv:changed', { convId, list: this.store.list() });

      let searchBlock = '';
      if (settings.webSearchEnabled && text && text.trim()) {
        const tSearch = Date.now();
        info('chat', `webSearch enabled query="${text.slice(0,80).replace(/\n/g,' ')}" limit=${settings.webSearchResults||5}`);
        const results = await search(text, settings.webSearchResults || 5);
        info('chat', `webSearch done in ${Date.now()-tSearch}ms results=${results.length} titles=${results.map(r=>r.title.slice(0,40)).join(' | ').slice(0,300)}`);
        if (results.length) {
          debug('chat', `webSearch results detail: ${JSON.stringify(results).slice(0,800)}`);
          searchBlock = 'WEB SEARCH RESULTS (from DuckDuckGo; verify before trusting):\n' +
            results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || ''}`).join('\n\n');
        } else {
          debug('chat', `webSearch no results for query`);
        }
      } else {
        debug('chat', `webSearch skipped enabled=${settings.webSearchEnabled} textEmpty=${!text?.trim()}`);
      }

      const history = conv.messages.slice(0, -1);
      const messages = [
        { role: 'system', content: systemPrompt(settings, this.mcp.getServerStatus()) },
        ...toCfMessages(history, null),
      ];
      if (userMsg.attachments?.length) {
        const fileBlock = userMsg.attachments.map(a =>
          a.inline ? `\n[Attached file ${a.name} (${a.type})]\n${a.inline}` : `\n[Attached file: ${a.name} (${a.type}, ${a.size} bytes)]`
        ).join('\n');
        userMsg.attachmentsForModel = fileBlock;
      }
      const userParts = [];
      const userTextParts = [];
      if (searchBlock) userTextParts.push(searchBlock);
      if (text) userTextParts.push(text);
      if (userMsg.attachmentsForModel) userTextParts.push(userMsg.attachmentsForModel);
      if (userTextParts.length) userParts.push({ type: 'text', text: userTextParts.join('\n\n') });
      for (const img of (images || [])) userParts.push({ type: 'image_url', image_url: { url: img } });
      messages.push({ role: 'user', content: userParts.length ? userParts : '' });

      const assistantMsg = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        reasoning: '',
        ts: Date.now(),
      };
      this.store.append(convId, assistantMsg);
      this.emit('conv:changed', { convId, list: this.store.list() });

      let loopCount = 0;
      let lastUsage = null;
      let finalText = '';
      let finalReasoning = '';

      while (true) {
        if (controller.signal.aborted) {
          info('chat', `loop abort detected conv=${convId} after ${loopCount} iterations`);
          break;
        }
        if (loopCount++ > 12) {
          warn('chat', `loop max iterations (12) reached conv=${convId}`);
          break;
        }
        info('chat', `loop iteration ${loopCount} conv=${convId} messages=${messages.length} history=${conv.messages.length}`);

        // Rebuild tool list each iteration provider-aware (so mcp=false providers don't get MCP tools)
        // Use single provider instance for both tools and chat to ensure consistency (model routing + mcp toggle + streaming)
        // FIX: prioritize Store settings.model (user's dropdown choice) over cloudflare.json default - previously always used getConfig().chatModel
        const modelId = settings.model || getConfig().chatModel;
        const provider = this._getProvider(settings, modelId);
        const tools = this._buildTools(settings, provider);
        debug('chat', `loop ${loopCount} provider=${provider ? provider.id : 'none'} model=${modelId} tools=${tools.length} names=${tools.map(t=>t.function.name).join(',').slice(0,300)} mcp=${provider ? provider.capabilities?.mcp !== false : true} streaming=${provider ? provider.capabilities?.streaming !== false : true}`);

        let textAcc = '';
        let reasoningAcc = '';
        const toolAcc = new Map(); // index -> {id, name, arguments}

        let streamErr = null;
        let usageFromStream = null;
        try {
          // Reuse provider from tools building above for consistency (model routing + mcp + streaming)
          const chatFn = provider ? provider.chat.bind(provider) : cf.streamChat;
          const modelForProvider = modelId; // pass through selected model id for provider routing
          const isStreaming = !provider || provider.capabilities?.streaming !== false;
          debug('chat', `using provider ${provider ? provider.id : 'cf-direct'} model=${modelForProvider} streaming=${isStreaming} mcp=${provider ? provider.capabilities?.mcp !== false : true}`);
          let streamRes;
          if (isStreaming) {
            // Streaming path: provider calls onEvent for chunks (existing behavior, works for both Cloudflare and streaming mods)
            streamRes = await chatFn({
              model: modelForProvider,
              messages,
              tools: tools.length ? tools : undefined,
              temperature: settings.temperature,
              maxTokens: settings.maxTokens,
              reasoningEffort: settings.reasoningEffort || undefined,
              signal: controller.signal,
              onEvent: (ev) => {
                if (ev.type === 'text') {
                  textAcc += ev.text;
                  this.emit('chat:delta', { convId, msgId: assistantMsg.id, kind: 'text', text: ev.text });
                } else if (ev.type === 'reasoning') {
                  reasoningAcc += ev.text;
                  this.emit('chat:delta', { convId, msgId: assistantMsg.id, kind: 'reasoning', text: ev.text });
                } else if (ev.type === 'tool_call') {
                  const idx = ev.index ?? 0;
                  const cur = toolAcc.get(idx) || { id: ev.id, name: ev.name, arguments: '' };
                  if (ev.id) cur.id = ev.id;
                  if (ev.name) cur.name = ev.name;
                  if (ev.arguments) cur.arguments += ev.arguments;
                  toolAcc.set(idx, cur);
                }
              },
            });
          } else {
            // Non-streaming provider: returns final result directly (e.g., simple echo mod)
            // Support both {content, reasoning, toolCalls, usage} and plain string
            const result = await chatFn({
              model: modelForProvider,
              messages,
              tools: tools.length ? tools : undefined,
              temperature: settings.temperature,
              maxTokens: settings.maxTokens,
              signal: controller.signal,
            });
            if (typeof result === 'string') {
              textAcc += result;
              this.emit('chat:delta', { convId, msgId: assistantMsg.id, kind: 'text', text: result });
            } else if (result && typeof result === 'object') {
              if (result.content) {
                textAcc += result.content;
                this.emit('chat:delta', { convId, msgId: assistantMsg.id, kind: 'text', text: result.content });
              }
              if (result.reasoning) {
                reasoningAcc += result.reasoning;
                this.emit('chat:delta', { convId, msgId: assistantMsg.id, kind: 'reasoning', text: result.reasoning });
              }
              if (Array.isArray(result.toolCalls)) {
                for (let i = 0; i < result.toolCalls.length; i++) {
                  const tc = result.toolCalls[i];
                  toolAcc.set(i, { id: tc.id || `call_${i}`, name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) });
                }
              }
            }
            streamRes = { usage: result?.usage || null, done: true };
          }
          usageFromStream = streamRes?.usage || null;
          if (usageFromStream) lastUsage = usageFromStream;
        } catch (err) {
          streamErr = err;
        }

        if (streamErr) {
          logError('chat', `streamErr loop ${loopCount} conv=${convId}: ${streamErr.message} aborted=${controller.signal.aborted}`);
          if (controller.signal.aborted) break;
          throw streamErr;
        }
        info('chat', `loop ${loopCount} stream done textLen=${textAcc.length} reasoningLen=${reasoningAcc.length} toolCallCount=${toolAcc.size}`);

        const toolCalls = [...toolAcc.values()].filter(t => t.name);
        debug('chat', `loop ${loopCount} toolCalls=${toolCalls.map(t=>`${t.name}(${JSON.stringify(t.arguments).slice(0,150)})`).join(' | ').slice(0,600)}`);
        if (!toolCalls.length) {
          finalText = textAcc;
          finalReasoning = reasoningAcc;
          info('chat', `loop ${loopCount} no tool calls -> finishing conv=${convId} finalTextLen=${finalText.length}`);
          break;
        }
        info('chat', `loop ${loopCount} executing ${toolCalls.length} tool(s) conv=${convId}`);

        // assistant turn with tool calls
        messages.push({ role: 'assistant', content: textAcc || null, tool_calls: toolCalls.map(t => ({
          id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments || '{}' },
        })) });

        // persist tool calls for the UI/history
        if (textAcc) assistantMsg.content += textAcc;

        let toolImages = [];
        for (const tc of toolCalls) {
          let parsedArgs = {};
          try { parsedArgs = JSON.parse(tc.arguments || '{}'); } catch (e) {
            warn('chat', `tool ${tc.name} args JSON parse fail: ${tc.arguments.slice(0,200)} err=${e.message}`);
          }
          info('chat', `tool start ${tc.name} id=${tc.id} args=${JSON.stringify(parsedArgs).slice(0,400)}`);
          this.emit('chat:tool', { convId, msgId: assistantMsg.id, tool: tc.name, args: parsedArgs, status: 'running' });
          const log = { name: tc.name, args: parsedArgs, status: 'running', result: '', images: [] };
          assistantMsg.tools = assistantMsg.tools || [];
          assistantMsg.tools.push(log);
          const tTool = Date.now();
          try {
            debug('chat', `tool ${tc.name} _maybeApprove check requireApproval=${this.store.getSettings().requireToolApproval}`);
            await this._maybeApprove(convId, tc.name, parsedArgs, controller.signal);
            debug('chat', `tool ${tc.name} _executeTool start`);
            const result = await this._executeTool(tc.name, parsedArgs);
            info('chat', `tool ${tc.name} done in ${Date.now()-tTool}ms resultLen=${result.text.length} images=${result.images.length} preview=${result.text.slice(0,150).replace(/\n/g,' ')}`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
            for (const img of result.images) toolImages.push(img);
            log.status = 'done';
            log.result = result.text.slice(0, 4000);
            log.images = result.images;
            this.emit('chat:tool', { convId, msgId: assistantMsg.id, tool: tc.name, status: 'done', result: log.result, images: result.images });
          } catch (err) {
            logError('chat', `tool ${tc.name} failed in ${Date.now()-tTool}ms: ${err.message}`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` });
            log.status = 'error';
            log.result = err.message;
            this.emit('chat:tool', { convId, msgId: assistantMsg.id, tool: tc.name, status: 'error', result: err.message });
          }
        }
        info('chat', `loop ${loopCount} tool batch done toolImages=${toolImages.length} messages now ${messages.length}`);
        assistantMsg.toolImages = (assistantMsg.toolImages || []).concat(toolImages);
      }

      assistantMsg.content = finalText || assistantMsg.content;
      assistantMsg.reasoning = finalReasoning;
      assistantMsg.usage = lastUsage || { completion_tokens: 0, prompt_tokens: 0 };
      assistantMsg.model = getConfig().chatModel;
      assistantMsg.done = true;
      info('chat', `send done conv=${convId} duration=${Date.now()-tSendStart}ms finalTextLen=${(finalText||'').length} reasoningLen=${(finalReasoning||'').length} usage=${JSON.stringify(lastUsage)} loops=${loopCount-1}`);
      this.store.save();
      this.emit('conv:changed', { convId, list: this.store.list() });
      this.emit('chat:done', { convId, msgId: assistantMsg.id });
      if (modBus) modBus.emitSafe(MOD_EVENTS.CHAT_DONE, { convId, msgId: assistantMsg.id, text: finalText });
      return { ok: true, convId, autoCreated };
    } catch (err) {
      logError('chat', `send error conv=${convId} after ${Date.now()-tSendStart}ms: ${err.message} stack=${err.stack?.split('\n').slice(1,2).join(' | ')}`);
      if (modBus) modBus.emitSafe(MOD_EVENTS.CHAT_ERROR, { convId, error: err.message });
      if (err.name === 'AbortError' || controller.signal.aborted) {
        info('chat', `send aborted conv=${convId}`);
        this.emit('chat:done', { convId, msgId: null, aborted: true });
        return { ok: true, aborted: true, convId };
      }
      return { error: err.message, convId };
    } finally {
      debug('chat', `send cleanup conv=${convId} activeRemaining=${this.active.size-1}`);
      this.active.delete(convId);
    }
  }

  async _executeTool(name, args) {
    if (name === 'web_search') {
      const settings = this.store.getSettings();
      const limit = Math.max(1, Math.min(10, parseInt(args.limit, 10) || settings.webSearchResults || 5));
      const results = await search(args.query || '', limit);
      if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_DONE, { tool: name, args, result: results });
      return { text: JSON.stringify(results), images: [] };
    }
    if (name === 'generate_image') {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('generate_image requires a prompt');
      const dataUrl = await cf.generateImage({ prompt, size: args.size });
      if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_DONE, { tool: name, args });
      return { text: `Generated image from prompt "${prompt.slice(0, 120)}"`, images: [dataUrl] };
    }
    // Check mod-registered tools first (namespaced)
    try {
      if (toolRegistry && toolRegistry.has(name)) {
        if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_START, { tool: name, args, source: 'mod' });
        const res = await toolRegistry.execute(name, args);
        if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_DONE, { tool: name, args, result: res });
        return res;
      }
    } catch (e) {
      if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_ERROR, { tool: name, args, error: e.message });
      throw e;
    }
    // Fall back to MCP
    if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_START, { tool: name, args, source: 'mcp' });
    try {
      const res = await this.mcp.callTool(name, args);
      if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_DONE, { tool: name, args, result: res });
      return res;
    } catch (e) {
      if (modBus) modBus.emitSafe(MOD_EVENTS.TOOL_ERROR, { tool: name, args, error: e.message });
      throw e;
    }
  }

  _buildTools(settings, provider) {
    const tools = [];
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web via DuckDuckGo for current information, news, documentation, or anything time-sensitive. Returns a list of results with title, URL and snippet.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Number of results (1-10, default 5)' },
          },
          required: ['query'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generate an image from a text prompt using FLUX (text-to-image). Use when the user asks for an image, illustration, logo, photo or artwork.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed image description' },
            size: { type: 'string', enum: ['256x256', '512x512', '768x768', '1024x1024'], description: 'Optional output size' },
          },
          required: ['prompt'],
        },
      },
    });
    if (settings.requireToolApproval) {
      for (const t of tools) {
        t.function.description = '[User approval required before running] ' + t.function.description;
      }
    }
    // Only include MCP tools if provider supports them (default true for backward compat)
    const providerSupportsMcp = !provider || provider.capabilities?.mcp !== false;
    let mcpTools = [];
    if (providerSupportsMcp) {
      try { mcpTools = this.mcp.getToolsForModel(); } catch {}
    } else {
      debug('chat', `provider ${provider.id} has mcp=false, skipping MCP tools`);
    }
    let modTools = [];
    try { if (toolRegistry) modTools = toolRegistry.getToolsForModel(); } catch (e) { warn('chat', `mod tools failed: ${e.message}`); }
    return tools.concat(mcpTools).concat(modTools);
  }

  _maybeApprove(convId, toolName, args, signal) {
    const settings = this.store.getSettings();
    if (!settings.requireToolApproval) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const approveCb = { resolve, reject };
      this.pendingApprovals.set(id, approveCb);
      this.emit('chat:approval', { convId, approvalId: id, tool: toolName, args });
      const cleanup = () => {
        this.pendingApprovals.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Generation stopped while waiting for tool approval.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async approve(approvalId, approved) {
    const p = this.pendingApprovals.get(approvalId);
    if (!p) return;
    this.pendingApprovals.delete(approvalId);
    if (approved) p.resolve();
    else p.reject(new Error('Tool call denied by user.'));
  }
}

// ---------------------------------------------------------------- attachments

function processAttachment({ name, path: filePath, dataBase64 }) {
  if (!name || typeof name !== 'string') throw new Error('Attachment requires a filename');
  const ext = (name.split('.').pop() || '').toLowerCase().slice(0, 10);
  const size = dataBase64 ? Math.floor((dataBase64.length * 3) / 4) : 0;
  if (size > MAX_ATTACH_SIZE) throw new Error(`File too large (${(size / 1024 / 1024).toFixed(1)} MB, max 12 MB)`);
  const mime = IMAGE_MIME[ext];

  if (mime && dataBase64) {
    return { name, type: mime, size, image: `data:${mime};base64,${dataBase64}` };
  }
  if (AUDIO_EXT.includes(ext) && dataBase64) {
    return { name, type: `audio/${ext === 'mp3' ? 'mpeg' : ext}`, size, audio: dataBase64 };
  }
  if (TEXT_EXT.includes(ext) && dataBase64) {
    const buf = Buffer.from(dataBase64, 'base64');
    const raw = buf.toString('utf8');
    const truncated = raw.length > MAX_TEXT_INLINE;
    const inline = raw.slice(0, MAX_TEXT_INLINE) + (truncated ? `\n\n[truncated: ${raw.length - MAX_TEXT_INLINE} chars omitted]` : '');
    return { name, type: `text/plain; ext=${ext}`, size, inline, truncated };
  }
  if (ext === 'pdf' && dataBase64) {
    return { name, type: 'application/pdf', size, pdf: dataBase64 };
  }
  return { name, type: ext ? `file/${ext}` : 'application/octet-stream', size };
}

module.exports = { Store, ChatEngine, processAttachment, DEFAULT_SETTINGS, MAX_ATTACH_SIZE, MAX_TEXT_INLINE };

