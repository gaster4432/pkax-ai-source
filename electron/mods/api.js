'use strict';

const { createStorageApi } = require('./storage');
const { registry: promptRegistry } = require('./system-prompt');
const { toolRegistry } = require('./tools');
const { createConfigApi } = require('./config');
const { providerRegistry } = require('./providers');
const { bus, EVENTS } = require('./events');
const { debug, info, warn, error: logError } = require('../logger');

// Create the mod API object for a given mod
function createModApi(manifest, modPath) {
  const modId = manifest.id;
  const permissions = new Set(manifest.permissions || ['storage', 'systemPrompt', 'tools', 'config', 'logger', 'events']);

  // Helper to check permission
  function requirePerm(perm) {
    if (!permissions.has(perm)) {
      throw new Error(`Mod "${modId}" lacks permission "${perm}" - add it to manifest.permissions`);
    }
  }

  // Storage
  const storage = (() => {
    const api = createStorageApi(modId);
    // Wrap to enforce permission
    const wrap = {};
    for (const k of Object.keys(api)) {
      if (k.startsWith('_')) { wrap[k] = api[k]; continue; }
      wrap[k] = (...args) => {
        requirePerm('storage');
        return api[k](...args);
      };
    }
    return wrap;
  })();

  // System prompt
  const systemPrompt = {
    append(text) {
      requirePerm('systemPrompt');
      return promptRegistry.append(modId, text);
    },
    remove() {
      requirePerm('systemPrompt');
      return promptRegistry.remove(modId);
    },
    // Expose current for debugging (read-only)
    getContributions() { return promptRegistry.getContributions().filter(c => c.modId === modId); }
  };

  // Tools
  const tools = {
    register(spec) {
      requirePerm('tools');
      const fullName = toolRegistry.register(modId, spec);
      return fullName;
    },
    unregister(name) {
      requirePerm('tools');
      return toolRegistry.unregister(modId, name);
    },
    list() { return toolRegistry.listByMod(modId); }
  };

  // Config
  const config = createConfigApi(modId, [...permissions]);

  // Logger - always allowed, namespaced
  const log = {
    debug: (...args) => debug(`mod:${modId}`, ...args),
    info: (...args) => info(`mod:${modId}`, ...args),
    warn: (...args) => warn(`mod:${modId}`, ...args),
    error: (...args) => logError(`mod:${modId}`, ...args),
    log: (...args) => info(`mod:${modId}`, ...args),
  };

  // Events
  const events = {
    on(event, handler) {
      requirePerm('events');
      if (!Object.values(EVENTS).includes(event) && event !== '*') {
        warn(`mod:${modId}`, `subscribing to unknown event "${event}" - allowed but may not fire`);
      }
      return bus.onSafe(event, handler, modId);
    },
    off(event, handler) { return bus.off(event, handler); },
    emit(event, payload) {
      requirePerm('events');
      // Mods can only emit custom events prefixed with modId
      if (!event.startsWith(`${modId}:`) && !event.startsWith('mod:')) {
        throw new Error(`Mods can only emit events prefixed with "${modId}:" - got "${event}"`);
      }
      return bus.emitSafe(event, payload);
    },
    EVENTS,
  };

  // Providers - enhanced to support models and streaming
  const providers = {
    register(spec) {
      requirePerm('providers');
      // Support spec.models to add models alongside provider in one call (doesn't break existing mods)
      const withMod = { ...spec, _modId: modId };
      const result = providerRegistry.register(withMod);
      bus.emitSafe(EVENTS.PROVIDER_REGISTERED, { providerId: spec.id, modId });
      // If provider declares models, they are already registered via providerRegistry
      // Also emit for UI to refresh model list
      if (spec.models) bus.emitSafe('models:changed', { modId, models: spec.models });
      return result;
    },
    unregister(id) {
      requirePerm('providers');
      const ok = providerRegistry.unregister(id);
      if (ok) bus.emitSafe(EVENTS.PROVIDER_UNREGISTERED, { providerId: id, modId });
      return ok;
    },
    list() { return providerRegistry.list(); },
    get(id) { return providerRegistry.get(id); },
    // Helper to check streaming capability
    supportsStreaming(providerId) {
      const p = providerRegistry.get(providerId);
      return p ? !!p.capabilities?.streaming : false;
    }
  };

  // Models - add models to the model list without needing a full provider (or for existing provider)
  const models = {
    register(modelSpec) {
      requirePerm('models');
      if (!modelSpec || typeof modelSpec !== 'object') throw new Error('Model spec must be {id, description, provider}');
      const providerId = modelSpec.provider || 'cloudflare';
      // provider must exist or will fallback to default
      const result = providerRegistry.registerModelDirect({ id: modelSpec.id, description: modelSpec.description, name: modelSpec.name, provider: providerId }, modId);
      // Tag with modId for cleanup
      const stored = providerRegistry.getModel(modelSpec.id);
      if (stored) stored.modId = modId;
      bus.emitSafe('models:changed', { modId, modelId: modelSpec.id });
      info(`mod:${modId}`, `model registered: ${modelSpec.id} -> ${providerId}`);
      return result;
    },
    unregister(modelId) {
      requirePerm('models');
      const ok = providerRegistry.unregisterModel(modelId);
      if (ok) bus.emitSafe('models:changed', { modId, modelId });
      return ok;
    },
    list() { return providerRegistry.listModels(); },
    get(id) { return providerRegistry.getModel(id); }
  };

  // MCP extensions - use existing MCP abstractions, not raw secrets
  const mcp = (() => {
    // Lazy require to avoid circular deps
    const getMcpManager = () => {
      try { return require('../main').getMcpManager?.() || global._mcpManager || null; } catch { return null; }
    };
    return {
      // No raw credentials - just status and tools
      getStatus() {
        requirePerm('mcp');
        const mgr = getMcpManager();
        return mgr ? mgr.getServerStatus() : [];
      },
      getTools() {
        requirePerm('mcp');
        const mgr = getMcpManager();
        return mgr ? mgr.getToolsForModel() : [];
      },
      async callTool(fullName, args) {
        requirePerm('mcp');
        const mgr = getMcpManager();
        if (!mgr) throw new Error('MCP not ready');
        return mgr.callTool(fullName, args);
      },
      onToolsChanged(handler) {
        requirePerm('mcp');
        return bus.onSafe(EVENTS.MCP_TOOLS_CHANGED, handler, modId);
      },
      // For mods that want to be notified when OAuth is needed, they can listen to status
      getOAuthServers() {
        requirePerm('mcp');
        const mgr = getMcpManager();
        return mgr ? (mgr.getServersNeedingOAuth ? mgr.getServersNeedingOAuth() : []) : [];
      }
    };
  })();

  // Additional capabilities - slash commands
  const commands = (() => {
    const registry = new Map();
    return {
      register(name, opts) {
        requirePerm('commands');
        if (!name || typeof name !== 'string' || !name.startsWith('/')) throw new Error('Command name must start with /');
        if (registry.has(name)) throw new Error(`Command ${name} already registered by this mod`);
        if (typeof opts.handler !== 'function') throw new Error('Command handler must be a function');
        registry.set(name, { name, description: opts.description || '', handler: opts.handler, modId });
        info(`mod:${modId}`, `command registered: ${name}`);
        // Expose via global command registry if available
        try {
          const loader = require('./loader');
          if (loader.commandRegistry) loader.commandRegistry.set(name, { modId, ...opts });
        } catch {}
        return true;
      },
      unregister(name) {
        registry.delete(name);
        try {
          const loader = require('./loader');
          loader.commandRegistry?.delete(name);
        } catch {}
        return true;
      },
      list() { return [...registry.values()]; }
    };
  })();

  // App hooks - background tasks
  const app = {
    getPath: (name) => {
      const { app } = require('electron');
      return app.getPath(name);
    },
    getVersion: () => {
      const { app } = require('electron');
      return app.getVersion();
    },
    // Allow mods to schedule background tasks (respect permissions)
    setInterval: (fn, ms) => {
      const id = setInterval(() => {
        try { fn(); } catch (e) { logError(`mod:${modId}`, `interval error: ${e.message}`); }
      }, ms);
      return id;
    },
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => {
        try { fn(); } catch (e) { logError(`mod:${modId}`, `timeout error: ${e.message}`); }
      }, ms);
      return id;
    },
  };

  // The full mod API
  const api = {
    id: modId,
    manifest,
    path: modPath,
    version: manifest.version,
    storage,
    systemPrompt,
    tools,
    config,
    log,
    events,
    providers,
    models,
    mcp,
    commands,
    app,
    // For testing
    _permissions: permissions,
  };

  return api;
}

module.exports = { createModApi };
