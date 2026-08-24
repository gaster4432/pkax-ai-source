'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  init: () => ipcRenderer.invoke('app:init'),
  saveCredentials: (payload) => ipcRenderer.invoke('app:saveCredentials', payload),
  createConversation: () => ipcRenderer.invoke('conv:create'),
  deleteConversation: (id) => ipcRenderer.invoke('conv:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conv:rename', id, title),
  getConversation: (id) => ipcRenderer.invoke('conv:get', id),
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  stopGeneration: (convId) => ipcRenderer.invoke('chat:stop', convId),
  approveTool: (approvalId, approved) => ipcRenderer.invoke('tool:approve', approvalId, approved),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  retryMcp: () => ipcRenderer.invoke('mcp:retry'),
  getOAuthServers: () => ipcRenderer.invoke('mcp:oauth:list'),
  authorizeMcp: (serverName) => ipcRenderer.invoke('mcp:oauth:authorize', serverName),
  getOAuthCredentials: () => ipcRenderer.invoke('mcp:oauth:credentials'),
  clearOAuthCredentials: (serverName) => ipcRenderer.invoke('mcp:oauth:clear', serverName),
  // Mod manager
  getMods: () => ipcRenderer.invoke('mods:list'),
  enableMod: (modId) => ipcRenderer.invoke('mods:enable', modId),
  disableMod: (modId) => ipcRenderer.invoke('mods:disable', modId),
  uninstallMod: (modId) => ipcRenderer.invoke('mods:uninstall', modId),
  reloadMod: (modId) => ipcRenderer.invoke('mods:reload', modId),
  getModsDir: () => ipcRenderer.invoke('mods:dir'),
  getUiMods: () => ipcRenderer.invoke('mods:ui-list'),
  updaterStatus: () => ipcRenderer.invoke('updater:status'),
  updaterStart: () => ipcRenderer.invoke('updater:start'),
  updaterRestart: () => ipcRenderer.invoke('updater:restart'),
  // Mod Store (GitHub-based)
  fetchPackages: () => ipcRenderer.invoke('store:fetchPackages'),
  fetchMod: (storePath) => ipcRenderer.invoke('store:fetchMod', storePath),
  fetchModThumbnail: (storePath, thumbnail) => ipcRenderer.invoke('store:fetchThumbnail', { storePath, thumbnail }),
  installMod: (id, storePath) => ipcRenderer.invoke('store:install', { id, storePath }),
  generateImage: (payload) => ipcRenderer.invoke('image:generate', payload),
  listModels: () => ipcRenderer.invoke('models:list'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  processFile: (payload) => ipcRenderer.invoke('file:process', payload),
  openFileDialog: () => ipcRenderer.invoke('file:open-dialog'),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('image:save', dataUrl, name),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  transcribeAudio: (payload) => ipcRenderer.invoke('audio:transcribe', payload),

  on: (channel, cb) => {
    const valid = ['chat:delta', 'chat:tool', 'chat:done', 'chat:approval', 'conv:changed', 'mcp:status', 'mods:status', 'loading:update', 'loading:done', 'loading:models'];
    if (!valid.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

// contextBridge.exposeInMainWorld silently does nothing when contextIsolation is false
// (our setup, for mod DOM access) - assign directly instead; nodeIntegration makes this safe.
try { contextBridge.exposeInMainWorld('api', api); } catch { /* not supported */ }
if (!window.api) window.api = api;
