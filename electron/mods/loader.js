'use strict';

const fs = require('fs');
const path = require('path');
const { validateManifest, MOD_API_VERSION, isApiVersionCompatible } = require('./manifest');
const { createModApi } = require('./api');
const { debug, info, warn, error: logError } = require('../logger');
const { bus, EVENTS } = require('./events');
const { getModsDir } = require('../appdata');

const MANIFEST_NAME = 'manifest.json';

class ModLoader {
  constructor() {
    this.mods = new Map(); // id -> { manifest, path, api, module, status, error, enabled }
    this.modsDir = this._resolveModsDir();
    this.commandRegistry = new Map(); // for slash commands
  }

  _resolveModsDir() {
    // All mods (dev and packaged) live in %APPDATA%/Pkax/mods
    return getModsDir();
  }

  getModsDir() { return this.modsDir; }

  // For UI and testing
  list() {
    return [...this.mods.values()].map(m => ({
      id: m.manifest.id,
      name: m.manifest.name,
      version: m.manifest.version,
      author: m.manifest.author,
      description: m.manifest.description,
      modApiVersion: m.manifest.modApiVersion,
      enabled: m.enabled,
      status: m.status,
      error: m.error,
      path: m.path,
      permissions: m.manifest.permissions || [],
      dependencies: m.manifest.dependencies || {},
    }));
  }

  get(modId) { return this.mods.get(modId) || null; }

  async discover() {
    info('mods', `discovering mods in ${this.modsDir}`);
    if (!fs.existsSync(this.modsDir)) {
      fs.mkdirSync(this.modsDir, { recursive: true });
      info('mods', `created mods dir ${this.modsDir}`);
      return [];
    }
    const entries = await fs.promises.readdir(this.modsDir, { withFileTypes: true });
    const found = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const modPath = path.join(this.modsDir, ent.name);
      const manifestPath = path.join(modPath, MANIFEST_NAME);
      if (!fs.existsSync(manifestPath)) {
        warn('mods', `skipping ${ent.name}: no ${MANIFEST_NAME}`);
        continue;
      }
      try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        // Ensure id matches folder name for determinism
        if (manifest.id !== ent.name) {
          warn('mods', `manifest id "${manifest.id}" does not match folder "${ent.name}" - using folder name`);
          manifest.id = ent.name;
        }
        const { valid, errors } = validateManifest(manifest, modPath);
        if (!valid) {
          logError('mods', `invalid manifest for ${ent.name}: ${errors.join('; ')}`);
          this.mods.set(manifest.id, {
            manifest, path: modPath, status: 'invalid', error: errors.join('; '), enabled: false,
          });
          continue;
        }
        found.push({ manifest, modPath });
        info('mods', `discovered ${manifest.id}@${manifest.version} api=${manifest.modApiVersion}`);
      } catch (e) {
        logError('mods', `failed to read manifest for ${ent.name}: ${e.message}`);
        this.mods.set(ent.name, { manifest: { id: ent.name }, path: modPath, status: 'error', error: e.message, enabled: false });
      }
    }
    // Resolve dependencies
    const sorted = this._resolveDependencies(found);
    for (const { manifest, modPath } of sorted) {
      // Add to map as discovered but not yet loaded
      if (!this.mods.has(manifest.id)) {
        this.mods.set(manifest.id, { manifest, path: modPath, status: 'discovered', error: null, enabled: manifest.enabled !== false });
      }
    }
    return this.list();
  }

  _resolveDependencies(found) {
    // Simple topological sort based on dependencies, fail gracefully on missing/circular
    const byId = new Map(found.map(f => [f.manifest.id, f]));
    const visited = new Set();
    const temp = new Set();
    const sorted = [];
    const errors = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      if (temp.has(id)) {
        errors.push(`Circular dependency involving ${id}`);
        return;
      }
      temp.add(id);
      const entry = byId.get(id);
      if (!entry) {
        temp.delete(id);
        return;
      }
      const deps = entry.manifest.dependencies || {};
      for (const depId of Object.keys(deps)) {
        if (!byId.has(depId)) {
          const msg = `Mod ${id} depends on missing mod ${depId}`;
          warn('mods', msg);
          // Mark as error but still allow loading if dependency is optional? For now, mark error
          entry.manifest._depError = msg;
        } else {
          visit(depId);
        }
      }
      temp.delete(id);
      visited.add(id);
      sorted.push(entry);
    };

    for (const { manifest } of found) visit(manifest.id);
    // Any not visited (due to error) add at end
    for (const f of found) if (!visited.has(f.manifest.id)) sorted.push(f);
    return sorted;
  }

  async loadAll() {
    await this.discover();
    const results = [];
    for (const mod of [...this.mods.values()]) {
      if (mod.status === 'invalid' || mod.status === 'error') {
        results.push({ id: mod.manifest.id, status: mod.status, error: mod.error });
        continue;
      }
      if (mod.manifest._depError) {
        mod.status = 'error';
        mod.error = mod.manifest._depError;
        logError('mods', `skipping ${mod.manifest.id} due to dependency error: ${mod.error}`);
        results.push({ id: mod.manifest.id, status: 'error', error: mod.error });
        continue;
      }
      if (mod.enabled === false) {
        mod.status = 'disabled';
        info('mods', `skipping disabled mod ${mod.manifest.id}`);
        results.push({ id: mod.manifest.id, status: 'disabled' });
        continue;
      }
      const res = await this.loadOne(mod.manifest.id);
      results.push(res);
    }
    bus.emitSafe(EVENTS.APP_READY, { mods: this.list() });
    return results;
  }

  async loadOne(modId) {
    const entry = this.mods.get(modId);
    if (!entry) return { id: modId, status: 'not_found', error: 'Mod not discovered' };
    const { manifest, path: modPath } = entry;
    const mainFile = manifest.main || 'index.js';
    const mainPath = path.join(modPath, mainFile);

    // Create API
    const api = createModApi(manifest, modPath);
    entry.api = api;

    // Check if already loaded
    if (entry.status === 'loaded' || entry.status === 'enabled') {
      return { id: modId, status: entry.status };
    }

    try {
      if (!fs.existsSync(mainPath)) {
        throw new Error(`Main file not found: ${mainFile}`);
      }
      // Clear require cache for reload
      delete require.cache[require.resolve(mainPath)];

      // Load module in isolated try/catch
      const modModule = require(mainPath);
      entry.module = modModule;
      entry.status = 'loaded';
      entry.error = null;
      info('mods', `loaded ${modId} from ${mainPath}`);

      // Call onLoad if present
      if (typeof modModule.onLoad === 'function') {
        try {
          await Promise.resolve(modModule.onLoad(api));
          info('mods', `${modId} onLoad completed`);
        } catch (e) {
          logError('mods', `${modId} onLoad failed: ${e.message}`);
          entry.status = 'error';
          entry.error = `onLoad: ${e.message}`;
          // Don't crash app, keep mod in error state
          return { id: modId, status: 'error', error: entry.error };
        }
      }

      // Auto-enable if not disabled
      if (entry.enabled !== false) {
        await this.enable(modId);
      }

      return { id: modId, status: entry.status };
    } catch (e) {
      logError('mods', `failed to load ${modId}: ${e.message} ${e.stack?.split('\n')[1]||''}`);
      entry.status = 'error';
      entry.error = e.message;
      return { id: modId, status: 'error', error: e.message };
    }
  }

  async enable(modId) {
    const entry = this.mods.get(modId);
    if (!entry) throw new Error(`Mod ${modId} not found`);
    if (entry.status === 'enabled') return { id: modId, status: 'enabled' };
    if (entry.status === 'error' || entry.status === 'invalid') {
      throw new Error(`Cannot enable mod in status ${entry.status}: ${entry.error}`);
    }
    if (!entry.module) {
      const res = await this.loadOne(modId);
      if (res.status === 'error') throw new Error(res.error);
    }
    try {
      const modModule = entry.module;
      if (typeof modModule.onEnable === 'function') {
        await Promise.resolve(modModule.onEnable(entry.api));
      }
      entry.enabled = true;
      entry.status = 'enabled';
      info('mods', `enabled ${modId}`);
      bus.emitSafe(EVENTS.MOD_ENABLED, { modId });
      return { id: modId, status: 'enabled' };
    } catch (e) {
      logError('mods', `enable failed for ${modId}: ${e.message}`);
      entry.status = 'error';
      entry.error = `onEnable: ${e.message}`;
      throw e;
    }
  }

  async disable(modId) {
    const entry = this.mods.get(modId);
    if (!entry) throw new Error(`Mod ${modId} not found`);
    if (entry.status !== 'enabled') return { id: modId, status: entry.status };
    try {
      const modModule = entry.module;
      if (typeof modModule.onDisable === 'function') {
        await Promise.resolve(modModule.onDisable(entry.api));
      }
      // Clean up mod contributions
      const { registry: promptRegistry } = require('./system-prompt');
      promptRegistry.remove(modId);
      const { toolRegistry } = require('./tools');
      toolRegistry.unregisterAll(modId);
      const { providerRegistry } = require('./providers');
      providerRegistry.unregisterByMod(modId);
      // Note: storage and config remain, but not cleared

      entry.enabled = false;
      entry.status = 'disabled';
      info('mods', `disabled ${modId}`);
      bus.emitSafe(EVENTS.MOD_DISABLED, { modId });
      return { id: modId, status: 'disabled' };
    } catch (e) {
      logError('mods', `disable failed for ${modId}: ${e.message}`);
      entry.status = 'error';
      entry.error = `onDisable: ${e.message}`;
      throw e;
    }
  }

  async unload(modId) {
    const entry = this.mods.get(modId);
    if (!entry) throw new Error(`Mod ${modId} not found`);
    try {
      if (entry.status === 'enabled') await this.disable(modId);
      const modModule = entry.module;
      if (modModule && typeof modModule.onUnload === 'function') {
        await Promise.resolve(modModule.onUnload(entry.api));
      }
      // Clean up
      const { registry: promptRegistry } = require('./system-prompt');
      promptRegistry.remove(modId);
      const { toolRegistry } = require('./tools');
      toolRegistry.unregisterAll(modId);
      const { providerRegistry } = require('./providers');
      providerRegistry.unregisterByMod(modId);

      // Remove from require cache
      if (entry.path) {
        const mainFile = entry.manifest.main || 'index.js';
        const mainPath = path.join(entry.path, mainFile);
        try { delete require.cache[require.resolve(mainPath)]; } catch {}
      }
      entry.status = 'unloaded';
      entry.module = null;
      entry.api = null;
      info('mods', `unloaded ${modId}`);
      return { id: modId, status: 'unloaded' };
    } catch (e) {
      logError('mods', `unload failed for ${modId}: ${e.message}`);
      entry.status = 'error';
      entry.error = `onUnload: ${e.message}`;
      throw e;
    }
  }

  async reload(modId) {
    await this.unload(modId);
    // Re-discover to catch manifest changes
    const entry = this.mods.get(modId);
    if (entry) {
      entry.status = 'discovered';
      entry.enabled = entry.manifest.enabled !== false;
    }
    return this.loadOne(modId);
  }

  // For shutdown
  async shutdown() {
    bus.emitSafe(EVENTS.APP_SHUTDOWN, {});
    for (const [id, entry] of [...this.mods.entries()]) {
      if (entry.status === 'enabled') {
        try { await this.disable(id); } catch {}
      }
      try {
        if (entry.module && typeof entry.module.onUnload === 'function') {
          await Promise.resolve(entry.module.onUnload(entry.api));
        }
      } catch {}
    }
    info('mods', 'shutdown complete');
  }
}

const loader = new ModLoader();

module.exports = { ModLoader, modLoader: loader };
