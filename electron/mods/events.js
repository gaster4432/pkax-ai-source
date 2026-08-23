'use strict';

const { EventEmitter } = require('events');
const { debug, info } = require('../logger');

// Central event bus for mods
// Only expose useful events, not raw internals

class ModEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  emitSafe(event, payload) {
    try {
      debug('mods', `event emit: ${event} ${JSON.stringify(payload||{}).slice(0,300)}`);
      super.emit(event, payload);
      super.emit('*', { event, payload });
    } catch (e) {
      // Prevent mod event handler crash from taking down app
      console.error(`[mods] event handler error for ${event}:`, e.message);
    }
  }

  // Wrap on to catch mod errors
  onSafe(event, handler, modId) {
    const wrapped = (payload) => {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[mods] handler error in ${modId} for ${event}:`, e.message);
      }
    };
    super.on(event, wrapped);
    return () => super.off(event, wrapped);
  }
}

const bus = new ModEventBus();

// Useful events (documented for mods)
const EVENTS = {
  APP_START: 'app:start',
  APP_READY: 'app:ready',
  APP_SHUTDOWN: 'app:shutdown',
  CHAT_START: 'chat:start',
  CHAT_DONE: 'chat:done',
  CHAT_ERROR: 'chat:error',
  TOOL_START: 'tool:start',
  TOOL_DONE: 'tool:done',
  TOOL_ERROR: 'tool:error',
  PROVIDER_REGISTERED: 'provider:registered',
  PROVIDER_UNREGISTERED: 'provider:unregistered',
  MCP_TOOLS_CHANGED: 'mcp:toolsChanged',
  CONFIG_CHANGED: 'config:changed',
  MOD_ENABLED: 'mod:enabled',
  MOD_DISABLED: 'mod:disabled',
};

module.exports = { ModEventBus, bus, EVENTS };
