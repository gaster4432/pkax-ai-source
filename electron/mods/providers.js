'use strict';

const { info, warn, error: logError, debug } = require('../logger');

// Provider registry - wraps existing cf-client as default, allows mods to add providers
// Provider shape: { id, name, description, chat: async ({messages, tools, temperature, maxTokens, signal, onEvent}) => {usage} }

class ProviderRegistry {
  constructor() {
    this.providers = new Map(); // id -> provider
    this.models = new Map(); // modelId -> { id, description, providerId, model }
    this.defaultId = 'cloudflare';
    // Register built-in cf provider lazily
    this._registerBuiltIn();
  }

  _registerBuiltIn() {
    // Built-in Cloudflare provider using cf-client
    const cf = require('../cf-client');
    const { getConfig } = require('../config');
    this.providers.set('cloudflare', {
      id: 'cloudflare',
      name: 'Cloudflare Workers AI',
      description: 'Built-in Cloudflare Workers AI provider',
      isBuiltIn: true,
      capabilities: { streaming: true, tools: true, vision: true },
      async chat({ messages, tools, temperature, maxTokens, reasoningEffort, signal, onEvent, model }) {
        // FIX: use passed model (from chat-engine's settings.model) instead of re-reading default
        const modelToUse = model || getConfig().chatModel;
        return cf.streamChat({ model: modelToUse, messages, tools, temperature, maxTokens, reasoningEffort, signal, onEvent });
      },
      async generateImage(opts) {
        const cf2 = require('../cf-client');
        return cf2.generateImage(opts);
      },
      async transcribeAudio(opts) {
        const cf2 = require('../cf-client');
        return cf2.transcribeAudio(opts);
      }
    });
    // Register built-in models are handled via models.js PINNED, but we also track them here for routing
    this.models.set('@cf/qwen/qwen3.8-27b', { id: '@cf/qwen/qwen3.8-27b', description: 'Qwen 3.8 27B — vision, reasoning, tool calling (default)', providerId: 'cloudflare' });
    this.models.set('@cf/qwen/qwen2.5-coder-32b-instruct', { id: '@cf/qwen/qwen2.5-coder-32b-instruct', description: 'Qwen 2.5 Coder 32B Instruct', providerId: 'cloudflare' });
    debug('mods', 'provider registry: built-in cloudflare registered with streaming');
  }

  register(provider) {
    if (!provider || typeof provider !== 'object') throw new Error('Provider must be an object');
    const { id, name, chat, models, capabilities } = provider;
    if (!id || typeof id !== 'string' || !/^[a-z0-9-_]+$/.test(id)) throw new Error('Provider id must be lowercase alphanumeric with hyphens (e.g. my-provider)');
    if (this.providers.has(id)) throw new Error(`Provider id "${id}" already registered`);
    if (!name || typeof name !== 'string') throw new Error('Provider name required');
    if (typeof chat !== 'function') throw new Error('Provider must implement async chat({messages, tools, ...})');
    const caps = {
      streaming: true, // default true - most providers support streaming via onEvent
      tools: true,
      vision: false,
      mcp: true, // default true - provider will receive MCP tools; set to false to isolate from MCPs
      ...capabilities,
    };
    this.providers.set(id, {
      id,
      name,
      description: provider.description || '',
      chat,
      generateImage: provider.generateImage,
      transcribeAudio: provider.transcribeAudio,
      capabilities: caps,
      isBuiltIn: false,
      modId: provider._modId || 'unknown',
    });
    info('mods', `provider registered: ${id} (${name}) streaming=${caps.streaming} by ${provider._modId || 'unknown'}`);
    // Register models if provided - these will appear in the model list (doesn't break existing mods that don't provide models)
    if (Array.isArray(models)) {
      for (const m of models) {
        try {
          const modelId = typeof m === 'string' ? m : m.id;
          const desc = typeof m === 'string' ? '' : (m.description || m.name || '');
          const name = typeof m === 'string' ? m : (m.name || m.id);
          if (!modelId) throw new Error('Model id required');
          if (this.models.has(modelId)) {
            const existing = this.models.get(modelId);
            if (existing.providerId !== id) throw new Error(`Model ${modelId} already registered by ${existing.providerId}`);
          }
          this.models.set(modelId, { id: modelId, description: desc, name, providerId: id, modId: provider._modId });
          info('mods', `model registered: ${modelId} -> provider ${id} by ${provider._modId}`);
        } catch (e) {
          warn('mods', `failed to register model ${m.id || m} for provider ${id}: ${e.message}`);
        }
      }
    }
    return provider;
  }

  // Model management for provider extensions
  registerModel(model, providerId) {
    // model can be string id or object {id, description, name}
    let id, description, name;
    if (typeof model === 'string') {
      id = model;
      description = '';
    } else if (typeof model === 'object' && model !== null) {
      id = model.id;
      description = model.description || model.name || '';
      name = model.name;
    } else {
      throw new Error('Model must be string id or {id, description}');
    }
    if (!id || typeof id !== 'string') throw new Error('Model id required');
    if (this.models.has(id)) {
      // Allow re-register if same provider, but warn if different provider tries to claim same id
      const existing = this.models.get(id);
      if (existing.providerId !== providerId) {
        throw new Error(`Model id "${id}" already registered by provider "${existing.providerId}"`);
      }
      debug('mods', `model ${id} already registered for ${providerId}, updating`);
    }
    this.models.set(id, { id, description: description || '', name: name || id, providerId });
    info('mods', `model registered: ${id} -> provider ${providerId}`);
    return { id, providerId };
  }

  unregisterModel(modelId) {
    if (this.models.has(modelId)) {
      const m = this.models.get(modelId);
      if (m.providerId === 'cloudflare' && m.id.startsWith('@cf/')) {
        // Don't allow unregistering built-in pinned models via this path
        // but allow if explicitly requested by the owning mod
      }
      this.models.delete(modelId);
      info('mods', `model unregistered: ${modelId}`);
      return true;
    }
    return false;
  }

  getModel(modelId) { return this.models.get(modelId) || null; }
  listModels() { return [...this.models.values()]; }
  hasModel(modelId) { return this.models.has(modelId); }

  getProviderForModel(modelId) {
    // Direct mapping
    const m = this.models.get(modelId);
    if (m) {
      const p = this.providers.get(m.providerId);
      if (p) return p;
    }
    // Fallback: if model starts with provider prefix like "my-provider/model-name"
    const prefix = modelId.split('/')[0];
    if (this.providers.has(prefix)) return this.providers.get(prefix);
    // Fallback to default
    return this.getDefault();
  }

  unregister(id) {
    if (this.providers.has(id)) {
      const p = this.providers.get(id);
      if (p.isBuiltIn) throw new Error('Cannot unregister built-in provider');
      this.providers.delete(id);
      info('mods', `provider unregistered: ${id}`);
      return true;
    }
    return false;
  }

  get(id) { return this.providers.get(id) || null; }
  list() { return [...this.providers.values()]; }
  has(id) { return this.providers.has(id); }

  // For chat-engine to get default or by id
  getDefault() { return this.providers.get(this.defaultId); }
  setDefault(id) {
    if (!this.providers.has(id)) throw new Error(`Provider ${id} not found`);
    this.defaultId = id;
  }

  // For mods: unregister all from a given mod (onDisable)
  unregisterByMod(modId) {
    let count = 0;
    for (const [id, p] of [...this.providers.entries()]) {
      if (p.modId === modId && !p.isBuiltIn) {
        this.providers.delete(id);
        count++;
        info('mods', `provider ${id} removed for mod ${modId}`);
      }
    }
    // Remove models owned by this mod's providers
    let modelCount = 0;
    for (const [modelId, m] of [...this.models.entries()]) {
      // Check if model was registered by this mod's provider (via providerId)
      const provider = this.providers.get(m.providerId);
      // If provider gone and model was from this mod, remove it. Also check direct modId tracking for models
      // For simplicity, remove models where providerId belongs to this mod or was explicitly registered
      if (!this.providers.has(m.providerId) && m.providerId !== 'cloudflare') {
        // This model belonged to a provider that was just removed
        this.models.delete(modelId);
        modelCount++;
      } else if (m.providerId && this.providers.get(m.providerId)?.modId === modId) {
        this.models.delete(modelId);
        modelCount++;
      }
    }
    // Also remove models directly registered via models API under modId
    for (const [modelId, m] of [...this.models.entries()]) {
      if (m.modId === modId) {
        this.models.delete(modelId);
        modelCount++;
      }
    }
    if (modelCount) info('mods', `models removed for mod ${modId}: ${modelCount}`);
    if (this.defaultId && !this.providers.has(this.defaultId)) {
      this.defaultId = 'cloudflare';
    }
    return count;
  }

  // Direct model registration for mods that want to add models without a full provider (or for existing provider)
  // This is exposed via mod.models.register
  registerModelDirect(model, modId) {
    // model: { id, description, provider, name }
    let providerId = model.provider || this.defaultId;
    if (!this.providers.has(providerId)) {
      warn('mods', `model ${model.id} references unknown provider ${providerId}, using default`);
      providerId = this.defaultId;
    }
    const entry = { id: model.id, description: model.description || '', name: model.name || model.id, providerId, modId };
    this.models.set(model.id, entry);
    info('mods', `model registered: ${model.id} -> ${providerId} by ${modId}`);
    return entry;
  }
}

const registry = new ProviderRegistry();

module.exports = { ProviderRegistry, providerRegistry: registry };
