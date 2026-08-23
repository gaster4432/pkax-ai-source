'use strict';

const { info, debug } = require('../logger');

// Registry for mod system prompt contributions
class SystemPromptRegistry {
  constructor() {
    this.contributions = new Map(); // modId -> { text, order }
    this._orderCounter = 0;
  }

  append(modId, text) {
    if (!text || typeof text !== 'string') throw new Error('systemPrompt text must be non-empty string');
    const trimmed = text.trim();
    if (!trimmed) throw new Error('systemPrompt text cannot be empty');
    if (trimmed.length > 5000) throw new Error('systemPrompt contribution too long (max 5000 chars)');
    const existing = this.contributions.get(modId);
    const order = existing ? existing.order : this._orderCounter++;
    this.contributions.set(modId, { text: trimmed, order });
    info('mods', `systemPrompt append from ${modId} (${trimmed.length} chars)`);
    debug('mods', `  -> ${trimmed.slice(0,100).replace(/\n/g,' ')}...`);
  }

  // For mods to remove their contribution (onDisable/onUnload)
  remove(modId) {
    if (this.contributions.has(modId)) {
      this.contributions.delete(modId);
      info('mods', `systemPrompt removed contribution from ${modId}`);
    }
  }

  clear(modId) { this.remove(modId); }

  // Returns array sorted deterministically by insertion order (and modId as tie-breaker for determinism)
  getContributions() {
    return [...this.contributions.entries()]
      .sort((a, b) => {
        if (a[1].order !== b[1].order) return a[1].order - b[1].order;
        return a[0].localeCompare(b[0]);
      })
      .map(([modId, { text }]) => ({ modId, text }));
  }

  // Build the appended section for system prompt
  buildSection() {
    const contribs = this.getContributions();
    if (!contribs.length) return '';
    const lines = ['\n--- Mod-provided instructions (do not override core instructions) ---'];
    for (const { modId, text } of contribs) {
      lines.push(`\n[Mod: ${modId}]\n${text}`);
    }
    return lines.join('\n');
  }

  // For testing
  _reset() {
    this.contributions.clear();
    this._orderCounter = 0;
  }
}

// Singleton
const registry = new SystemPromptRegistry();

module.exports = { SystemPromptRegistry, registry };
