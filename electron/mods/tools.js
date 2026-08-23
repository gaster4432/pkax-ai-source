'use strict';

const { info, warn, debug, error: logError } = require('../logger');

function isValidToolName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{1,63}$/.test(name);
}

class ToolRegistry {
  constructor() {
    this.tools = new Map(); // fullName -> { modId, name, description, parameters, execute, fullName }
    this.byMod = new Map(); // modId -> Set(fullName)
  }

  // For mods: register({ name, description, parameters, execute })
  register(modId, spec) {
    if (!spec || typeof spec !== 'object') throw new Error('Tool spec must be an object');
    const { name, description, parameters, execute } = spec;
    if (!isValidToolName(name)) throw new Error(`Invalid tool name "${name}" - must be 2-64 chars, start with letter/number/underscore, alphanumeric/_/-`);
    if (!description || typeof description !== 'string') throw new Error('Tool description required');
    if (typeof execute !== 'function') throw new Error('Tool execute must be a function');
    // Basic JSON schema validation for parameters
    if (parameters !== undefined && (typeof parameters !== 'object' || parameters === null)) {
      throw new Error('Tool parameters must be a JSON Schema object');
    }
    // Mod namespacing: fullName = modId_name (sanitized)
    const sanitizedMod = modId.replace(/[^a-zA-Z0-9_]/g, '_');
    const fullName = `${sanitizedMod}_${name}`;
    if (this.tools.has(fullName)) throw new Error(`Tool "${fullName}" already registered`);

    // Check for collision with core tools
    const coreNames = ['web_search', 'generate_image'];
    if (coreNames.includes(name) || coreNames.includes(fullName)) {
      throw new Error(`Tool name "${name}" collides with built-in tool`);
    }

    const entry = {
      modId,
      name,
      fullName,
      description: description.slice(0, 500),
      parameters: parameters || { type: 'object', properties: {} },
      execute,
      registeredAt: Date.now(),
    };
    this.tools.set(fullName, entry);
    if (!this.byMod.has(modId)) this.byMod.set(modId, new Set());
    this.byMod.get(modId).add(fullName);
    info('mods', `tool registered: ${fullName} by ${modId}`);
    debug('mods', `  desc: ${description.slice(0,80)}`);
    return fullName;
  }

  unregister(modId, name) {
    const sanitizedMod = modId.replace(/[^a-zA-Z0-9_]/g, '_');
    const fullName = name.includes('_') && this.tools.has(name) ? name : `${sanitizedMod}_${name}`;
    if (this.tools.has(fullName) && this.tools.get(fullName).modId === modId) {
      this.tools.delete(fullName);
      this.byMod.get(modId)?.delete(fullName);
      info('mods', `tool unregistered: ${fullName} by ${modId}`);
      return true;
    }
    return false;
  }

  unregisterAll(modId) {
    const set = this.byMod.get(modId);
    if (!set) return 0;
    let count = 0;
    for (const fullName of [...set]) {
      this.tools.delete(fullName);
      count++;
    }
    this.byMod.delete(modId);
    if (count) info('mods', `tools unregistered for mod ${modId}: ${count}`);
    return count;
  }

  get(fullName) { return this.tools.get(fullName) || null; }
  has(fullName) { return this.tools.has(fullName); }
  list() { return [...this.tools.values()]; }
  listByMod(modId) {
    const set = this.byMod.get(modId);
    if (!set) return [];
    return [...set].map(n => this.tools.get(n)).filter(Boolean);
  }

  // For chat-engine: get tools in OpenAI format
  getToolsForModel() {
    const out = [];
    for (const entry of this.tools.values()) {
      out.push({
        type: 'function',
        function: {
          name: entry.fullName,
          description: `${entry.description} [via mod ${entry.modId}]`,
          parameters: entry.parameters,
        }
      });
    }
    return out;
  }

  async execute(fullName, args) {
    const entry = this.tools.get(fullName);
    if (!entry) throw new Error(`Unknown mod tool: ${fullName}`);
    const t0 = Date.now();
    debug('mods', `tool execute ${fullName} args=${JSON.stringify(args).slice(0,300)}`);
    try {
      // Basic validation: if parameters has required fields, check presence
      if (entry.parameters && entry.parameters.required) {
        for (const req of entry.parameters.required) {
          if (args[req] === undefined) throw new Error(`Missing required parameter: ${req}`);
        }
      }
      const result = await Promise.resolve(entry.execute(args));
      const dt = Date.now() - t0;
      // Normalize result
      let text = '';
      let images = [];
      if (typeof result === 'string') text = result;
      else if (result && typeof result === 'object') {
        text = result.text || result.content || JSON.stringify(result).slice(0, 4000);
        images = result.images || [];
      } else if (result !== undefined) {
        text = String(result);
      }
      info('mods', `tool ${fullName} done in ${dt}ms textLen=${text.length}`);
      return { text: text.slice(0, 40000), images };
    } catch (e) {
      logError('mods', `tool ${fullName} failed in ${Date.now()-t0}ms: ${e.message}`);
      throw e;
    }
  }

  // For testing
  _reset() {
    this.tools.clear();
    this.byMod.clear();
  }
}

const registry = new ToolRegistry();

module.exports = { ToolRegistry, toolRegistry: registry, isValidToolName };
