'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { getConfig, hasCloudflareCredentials, loadLocalMcpServers, findMcpConfig, DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL } = require('./config');
const cf = require('./cf-client');
const { McpManager } = require('./mcp-manager');
const { Store, ChatEngine, processAttachment, MAX_ATTACH_SIZE } = require('./chat-engine');
const { getModelList } = require('./models');
const { debug, info, warn, error: logError } = require('./logger');
const { modLoader } = require('./mods/loader');
const { bus: modBus, EVENTS: MOD_EVENTS } = require('./mods/events');
const { getAppDataRoot, ensureDataLayout, getConfigDir, getCloudflareSettingsPath } = require('./appdata');

// Pin userData to %APPDATA%/Nexus AI for both dev and packaged builds
try { app.setPath('userData', getAppDataRoot()); } catch { /* ignore */ }

function migrateLegacyStore() {
  const dest = path.join(app.getPath('userData'), 'store.json');
  if (fs.existsSync(dest)) return;
  const appData = app.getPath('appData');
  const candidates = [
    path.join(appData, 'Electron', 'store.json'),
    path.join(appData, 'nexus-ai', 'store.json'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) {
        fs.copyFileSync(cand, dest);
        info('main', `migrated legacy store from ${cand}`);
        return;
      }
    } catch { /* ignore */ }
  }
}

// Expose for mods' mcp API
function getMcpManager() { return mcp; }
global._mcpManager = null; // will be set after mcp creation
module.exports.getMcpManager = getMcpManager;

// ---------------------------------------------------------------- single-instance lock

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------- app

let mainWindow = null;
let store = null;
let mcp = null;
let engine = null;

const MOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isSafeRegistryPath(value) {
  if (typeof value !== 'string' || !value.endsWith('/store.json')) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('..')) return false;
  return /^mods\/[a-z0-9][a-z0-9-]{0,63}\/store\.json$/.test(value);
}

function validateRegistry(registry) {
  // packages.json is canonical. Keep the legacy mods key readable so an
  // existing curator repository can migrate without breaking installed apps.
  const packages = registry?.packages || registry?.mods;
  if (!Array.isArray(packages)) throw new Error('Package index must contain a packages array');
  const seen = new Set();
  for (const entry of packages) {
    if (!entry || !MOD_ID_RE.test(entry.id) || !isSafeRegistryPath(entry.path)) {
      throw new Error('Registry contains an invalid mod entry');
    }
    if (seen.has(entry.id)) throw new Error(`Registry contains duplicate mod id: ${entry.id}`);
    seen.add(entry.id);
  }
  return { packages };
}

function registryFileUrl(storePath, baseUrl) {
  return new URL(storePath, baseUrl).toString();
}

async function listStoreFiles(storePath, baseUrl) {
  // The public registry uses raw.githubusercontent.com. GitHub's contents API
  // lets us install every top-level JavaScript asset without putting download
  // URLs in the registry or in store.json.
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/$/.exec(baseUrl);
  if (!match) return null;
  const [, owner, repo, branch] = match;
  const directory = path.posix.dirname(storePath);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${directory}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub directory listing failed: HTTP ${response.status}`);
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error('GitHub directory listing was not an array');
  return entries
    .filter(entry => entry.type === 'file' && (
      entry.name === 'manifest.json' || entry.name === 'README.md' ||
      entry.name === 'thumbnail.png' || entry.name.endsWith('.js')
    ))
    .map(entry => entry.name);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Mod status broadcasting
function sendModStatus() {
  send('mods:status', modLoader.list());
}

async function setupMcp() {
  const servers = loadLocalMcpServers();
  info('main', `setupMcp loading ${servers.length} server(s): ${servers.map(s=>`${s.name}:${s.type}`).join(', ')}`);
  debug('main', `setupMcp full config: ${JSON.stringify(servers.map(s=> ({name:s.name,type:s.type,url:s.url,cmd:s.command})) ).slice(0,600)}`);
  const t0 = Date.now();
  await mcp.load(servers);
  info('main', `setupMcp load() dispatched in ${Date.now()-t0}ms`);
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Nexus AI',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      enableRemoteModule: false,
      allowRunningInsecureContent: false,
    },
  });
  // Block new windows - open externally via OS browser instead of in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(url);
    } catch { /* ignore invalid url */ }
    return { action: 'deny' };
  });
  // Prevent navigation away from app file
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.SMOKE_DUMP) {
    mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (e, code, desc) => console.log('[renderer:fail]', code, desc));
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  info('main', 'registerIpc');
  ipcMain.handle('app:init', () => {
    debug('main', 'IPC app:init');
    let cfg = null;
    let needsCredentials = false;
    try {
      cfg = getConfig();
    } catch (err) {
      if (err.code === 'NEED_CREDENTIALS') {
        needsCredentials = true;
      } else {
        throw err;
      }
    }
    const status = mcp.getServerStatus();
    debug('main', `app:init settings=${JSON.stringify(store.getSettings()).slice(0,300)} needsCredentials=${needsCredentials} mcp=${status.map(s=>`${s.name}:${s.status}:${s.tools.length}`).join(',')}`);
    return {
      settings: store.getSettings(),
      model: cfg?.chatModel || DEFAULT_CHAT_MODEL,
      imageModel: cfg?.imageModel || DEFAULT_IMAGE_MODEL,
      accountId: cfg?.accountId || null,
      hasCredentials: hasCloudflareCredentials(),
      needsCredentials,
      dataDir: getAppDataRoot(),
      configDir: getConfigDir(),
      cloudflareConfigFile: getCloudflareSettingsPath(),
      mcpStatus: status,
      conversations: store.list(),
      mcpConfigPath: findMcpConfig(),
    };
  });

  ipcMain.handle('app:saveCredentials', (e, payload) => {
    const accountId = String(payload?.accountId ?? '').trim();
    const apiToken = String(payload?.apiToken ?? '').trim();
    if (!accountId) return { ok: false, error: 'Cloudflare Account ID is required.' };
    if (!/^[a-f0-9]{32}$/i.test(accountId)) return { ok: false, error: 'Account ID should be a 32-character hex string from your Cloudflare dashboard.' };
    if (!apiToken) return { ok: false, error: 'Cloudflare API token is required.' };
    const file = getCloudflareSettingsPath();
    let data = {};
    try {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch { /* start fresh on corrupt file */ }
    data.accountId = accountId;
    data.apiToken = apiToken;
    if (!data.chatModel) data.chatModel = DEFAULT_CHAT_MODEL;
    if (!data.imageModel) data.imageModel = DEFAULT_IMAGE_MODEL;
    data.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    info('main', `saved Cloudflare credentials to ${file}`);
    return { ok: true, file };
  });

  ipcMain.handle('conv:create', () => {
    info('main', 'IPC conv:create');
    const conv = store.create();
    debug('main', `conv:create id=${conv.id}`);
    send('conv:changed', { convId: conv.id, list: store.list() });
    return conv;
  });
  ipcMain.handle('conv:delete', (e, id) => {
    info('main', `IPC conv:delete id=${id}`);
    store.delete(id);
    send('conv:changed', { convId: id, deleted: true, list: store.list() });
  });
  ipcMain.handle('conv:rename', (e, id, title) => {
    info('main', `IPC conv:rename id=${id} title=${title?.slice(0,40)}`);
    store.rename(id, title);
    send('conv:changed', { convId: id, list: store.list() });
  });
  ipcMain.handle('conv:get', (e, id) => {
    debug('main', `IPC conv:get id=${id}`);
    return store.get(id);
  });

  ipcMain.handle('chat:send', (e, payload) => {
    info('main', `IPC chat:send conv=${payload.convId} textLen=${payload.text?.length||0} images=${payload.images?.length||0}`);
    debug('main', `chat:send payload=${JSON.stringify({convId:payload.convId,text:(payload.text||'').slice(0,100),attachments:payload.attachments?.length})}`);
    return engine.send(payload);
  });
  ipcMain.handle('chat:stop', (e, convId) => {
    info('main', `IPC chat:stop conv=${convId}`);
    return engine.stop(convId);
  });
  ipcMain.handle('tool:approve', (e, approvalId, approved) => {
    info('main', `IPC tool:approve id=${approvalId} approved=${approved}`);
    return engine.approve(approvalId, approved);
  });

  ipcMain.handle('settings:get', () => {
    debug('main', 'IPC settings:get');
    return store.getSettings();
  });
  ipcMain.handle('settings:set', (e, patch) => {
    info('main', `IPC settings:set patch=${JSON.stringify(patch).slice(0,400)}`);
    const res = store.setSettings(patch);
    debug('main', `settings now ${JSON.stringify(res).slice(0,400)}`);
    return res;
  });

  ipcMain.handle('mcp:status', () => {
    debug('main', 'IPC mcp:status');
    return mcp.getServerStatus();
  });
  ipcMain.handle('mcp:retry', async () => {
    info('main', 'IPC mcp:retry');
    const t0 = Date.now();
    await mcp.shutdown();
    mcp = new McpManager(status => send('mcp:status', status));
    await setupMcp();
    info('main', `mcp:retry done in ${Date.now()-t0}ms`);
    return mcp.getServerStatus();
  });

  ipcMain.handle('mcp:oauth:list', () => {
    debug('main', 'IPC mcp:oauth:list');
    return mcp.getServersNeedingOAuth();
  });

  ipcMain.handle('mcp:oauth:authorize', async (e, serverName) => {
    info('main', `IPC mcp:oauth:authorize server=${serverName}`);
    try {
      const res = await mcp.authorizeServer(serverName);
      info('main', `mcp:oauth:authorize success ${serverName} -> ${res.status} tools=${res.tools.length}`);
      return { ok: true, server: res };
    } catch (err) {
      logError('main', `mcp:oauth:authorize failed ${serverName}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mcp:oauth:credentials', () => {
    try {
      const { loadAllCredentials, getCredentialsPath } = require('./mcp-oauth');
      const creds = loadAllCredentials();
      const file = getCredentialsPath();
      // Return sanitized view (don't leak full tokens to renderer unnecessarily, but show presence)
      const sanitized = Object.fromEntries(Object.entries(creds).map(([k,v])=> [k, {
        hasTokens: !!v.tokens,
        hasClientInfo: !!v.clientInformation,
        updatedAt: v.updatedAt,
        tokenPreview: v.tokens ? `${v.tokens.access_token?.slice(0,12)}...` : null,
      }]));
      return { ok: true, file, servers: sanitized };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mcp:oauth:clear', async (e, serverName) => {
    try {
      const { loadAllCredentials, saveAllCredentials } = require('./mcp-oauth');
      const all = loadAllCredentials();
      if (serverName) {
        delete all[serverName];
        info('main', `mcp:oauth:clear server=${serverName}`);
      } else {
        for (const k of Object.keys(all)) delete all[k];
        info('main', 'mcp:oauth:clear all');
      }
      saveAllCredentials(all);
      // reset server status to retry
      if (serverName && mcp.servers.has(serverName)) {
        const s = mcp.servers.get(serverName);
        s.status = 'starting';
        s.error = null;
        mcp._connect(serverName).catch(err=> logError('main', `reconnect after clear failed ${serverName}: ${err.message}`));
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('image:generate', async (e, { prompt, size }) => {
    info('main', `IPC image:generate promptLen=${prompt?.length||0} size=${size} preview=${prompt?.slice(0,60)}`);
    const t0 = Date.now();
    try {
      const dataUrl = await cf.generateImage({ prompt, size });
      info('main', `image:generate ok in ${Date.now()-t0}ms dataUrlLen=${dataUrl.length}`);
      return { ok: true, dataUrl };
    } catch (err) {
      logError('main', `image:generate failed in ${Date.now()-t0}ms: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('models:list', async () => {
    debug('main', 'IPC models:list');
    const t0 = Date.now();
    try {
      const models = await getModelList();
      info('main', `models:list ok ${models.length} models in ${Date.now()-t0}ms`);
      return { ok: true, models };
    }
    catch (err) {
      logError('main', `models:list failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:read', async (e, filePath) => {
    debug('main', `IPC file:read path=${filePath?.slice(0,120)}`);
    const t0 = Date.now();
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: 'Invalid file path' };
      if (filePath.length > 4096) return { ok: false, error: 'Path too long' };
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return { ok: false, error: 'Not a file' };
      if (stat.size > MAX_ATTACH_SIZE) return { ok: false, error: 'File too large (max 12 MB)' };
      const buf = await fs.promises.readFile(filePath);
      info('main', `file:read ok ${path.basename(filePath)} ${stat.size} bytes in ${Date.now()-t0}ms`);
      return { ok: true, name: path.basename(filePath), dataBase64: buf.toString('base64') };
    } catch (err) {
      logError('main', `file:read failed ${filePath}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:process', (e, { name, dataBase64 }) => {
    try {
      const att = processAttachment({ name, dataBase64 });
      if (att.image) return { ok: true, kind: 'image', name: att.name, size: att.size, image: att.image };
      if (att.audio) return { ok: true, kind: 'audio', name: att.name, size: att.size, audio: att.audio };
      if (att.pdf) return { ok: true, kind: 'pdf', name: att.name, size: att.size, pdf: att.pdf };
      if (att.inline) return { ok: true, kind: 'text', name: att.name, size: att.size, inline: att.inline, type: att.type };
      return { ok: true, kind: 'other', name: att.name, size: att.size, type: att.type };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:open-dialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach files',
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('image:save', async (e, dataUrl, suggestedName) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName || 'generated-image.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    await fs.promises.writeFile(res.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('shell:open-external', (e, url) => {
    try {
      if (typeof url !== 'string') return;
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(url);
    } catch { /* invalid url - ignore */ }
  });

  ipcMain.handle('audio:transcribe', async (e, { dataBase64, mime }) => {
    try {
      const text = await cf.transcribeAudio({ audioBase64: dataBase64, mime });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Mod manager
  ipcMain.handle('mods:list', () => {
    debug('main', 'IPC mods:list');
    return modLoader.list();
  });
  ipcMain.handle('mods:enable', async (e, modId) => {
    info('main', `IPC mods:enable ${modId}`);
    try {
      const res = await modLoader.enable(modId);
      sendModStatus();
      return { ok: true, ...res };
    } catch (err) {
      logError('main', `mods:enable failed ${modId}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('mods:disable', async (e, modId) => {
    info('main', `IPC mods:disable ${modId}`);
    try {
      const res = await modLoader.disable(modId);
      sendModStatus();
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('mods:uninstall', async (e, modId) => {
    info('main', `IPC mods:uninstall ${modId}`);
    try {
      // First disable to clean up prompt/tools/providers
      try { await modLoader.disable(modId); } catch {}
      const modDir = path.join(modLoader.getModsDir(), modId);
      if (!fs.existsSync(modDir)) return { ok: false, error: 'Mod not found on disk' };
      // Safety: ensure modDir is inside mods dir
      const modsRoot = path.resolve(modLoader.getModsDir());
      const target = path.resolve(modDir);
      if (!target.startsWith(modsRoot + path.sep) && target !== modsRoot) throw new Error('Invalid mod path');
      fs.rmSync(target, { recursive: true, force: true });
      info('main', `mods:uninstall deleted ${target}`);
      // Remove from loader map and refresh list
      modLoader.mods.delete(modId);
      sendModStatus();
      return { ok: true };
    } catch (err) {
      logError('main', `mods:uninstall failed ${modId}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('mods:reload', async (e, modId) => {
    info('main', `IPC mods:reload ${modId}`);
    try {
      const res = await modLoader.reload(modId);
      sendModStatus();
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('mods:dir', () => modLoader.getModsDir());

  // Mod Store - GitHub-based registry (minimal: only id + path, store.json has display info)
  const MOD_REGISTRY_URL = process.env.MOD_REGISTRY_URL || 'https://raw.githubusercontent.com/gaster4432/CF-AI-Mod-Registry/main/packages.json';
  const MOD_GITHUB_BASE = process.env.MOD_GITHUB_BASE || 'https://raw.githubusercontent.com/gaster4432/CF-AI-Mod-Registry/main/';
  ipcMain.handle('store:fetchPackages', async () => {
    info('main', `store:fetchPackages from ${MOD_REGISTRY_URL}`);
    try {
      const res = await fetch(MOD_REGISTRY_URL, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = validateRegistry(await res.json());
      debug('main', `packages fetched ${data.packages?.length||0} packages`);
      return { ok: true, packages: data.packages };
    } catch (err) {
      logError('main', `store:fetchRegistry failed: ${err.message}, trying local fallback`);
      try {
        const localPath = path.join(__dirname, '..', '..', 'CF-AI-Mod-Registry', 'packages.json');
        // Also try Documents fallback
        const docPath = path.join(require('os').homedir(), 'Documents', 'CF-AI-Mod-Registry', 'packages.json');
        let p = fs.existsSync(localPath) ? localPath : docPath;
        if (fs.existsSync(p)) {
          const data = validateRegistry(JSON.parse(fs.readFileSync(p, 'utf8')));
          return { ok: true, packages: data.packages, localFallback: true };
        }
      } catch {}
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('store:fetchMod', async (e, storePath) => {
    // storePath is like "mods/permanent-memory/store.json" inside GitHub repo
    if (!isSafeRegistryPath(storePath)) return { ok: false, error: 'Invalid registry path' };
    const url = registryFileUrl(storePath, MOD_GITHUB_BASE);
    debug('main', `store:fetchMod ${storePath} -> ${url}`);
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return { ok: true, mod: data };
    } catch (err) {
      // Fallback to local file
      try {
        const localBase = path.join(require('os').homedir(), 'Documents', 'CF-AI-Mod-Registry');
        const localFile = path.join(localBase, storePath);
        if (fs.existsSync(localFile)) {
          const data = JSON.parse(fs.readFileSync(localFile, 'utf8'));
          return { ok: true, mod: data, localFallback: true };
        }
      } catch {}
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('store:fetchThumbnail', async (e, { storePath, thumbnail }) => {
    if (!isSafeRegistryPath(storePath) || typeof thumbnail !== 'string' || !/^[a-zA-Z0-9_.-]+\.(png|jpe?g|webp)$/i.test(thumbnail)) {
      return { ok: false, error: 'Invalid thumbnail path' };
    }
    const relativePath = `${path.posix.dirname(storePath)}/${thumbnail}`;
    const mime = thumbnail.endsWith('.png') ? 'image/png'
      : /\.webp$/i.test(thumbnail) ? 'image/webp' : 'image/jpeg';
    try {
      const res = await fetch(registryFileUrl(relativePath, MOD_GITHUB_BASE), { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      return { ok: true, dataUrl: `data:${mime};base64,${data}` };
    } catch (err) {
      try {
        const localFile = path.join(require('os').homedir(), 'Documents', 'CF-AI-Mod-Registry', ...relativePath.split('/'));
        if (fs.existsSync(localFile)) {
          return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(localFile).toString('base64')}`, localFallback: true };
        }
      } catch { /* return the original error below */ }
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('store:install', async (e, { id, storePath }) => {
    info('main', `store:install ${id} from ${storePath}`);
    try {
      if (!MOD_ID_RE.test(id) || !isSafeRegistryPath(storePath)) throw new Error('Invalid mod id or registry path');
      if (path.posix.basename(path.posix.dirname(storePath)) !== id) throw new Error('Mod id does not match registry path');
      // Determine GitHub directory for this mod (same dir as store.json, without store.json)
      const modDirInRepo = path.posix.dirname(storePath); // e.g. mods/permanent-memory
      const baseUrl = registryFileUrl(`${modDirInRepo}/`, MOD_GITHUB_BASE);
      const localBase = path.join(require('os').homedir(), 'Documents', 'CF-AI-Mod-Registry', modDirInRepo);
      const destDir = path.join(modLoader.getModsDir(), id);
      // Check if already installed
      if (fs.existsSync(destDir)) {
        return { ok: false, error: `Mod ${id} already installed` };
      }
      fs.mkdirSync(destDir, { recursive: true });

      // Install the mod code, not store.json. GitHub listings discover every
      // top-level JavaScript file; the fallback supports local/custom registries.
      let filesToTry = ['manifest.json', 'index.js', 'README.md', 'thumbnail.png'];
      try {
        const listedFiles = await listStoreFiles(storePath, MOD_GITHUB_BASE);
        if (listedFiles?.length) filesToTry = listedFiles;
      } catch (err) {
        warn('main', `store:install could not list ${id} on GitHub: ${err.message}; using fallback file list`);
      }
      // Include a nonstandard main file when the manifest declares one.
      let manifest = null;
      try {
        const mRes = await fetch(baseUrl + 'manifest.json');
        if (mRes.ok) manifest = await mRes.json();
      } catch {}
      if (manifest && typeof manifest.main === 'string' && /^[a-zA-Z0-9_.-]+\.js$/.test(manifest.main) && !filesToTry.includes(manifest.main)) filesToTry.push(manifest.main);

      let downloaded = [];
      for (const file of filesToTry) {
        const url = baseUrl + file;
        const dest = path.join(destDir, file);
        let content = null;
        let isBinary = file.endsWith('.png');
        try {
          const res = await fetch(url);
          if (!res.ok) {
            // Try local fallback
            const localFile = path.join(localBase, file);
            if (fs.existsSync(localFile)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.copyFileSync(localFile, dest);
              downloaded.push(file);
              debug('main', `store:install copied local ${file} for ${id}`);
              continue;
            }
            debug('main', `store:install skip ${file} for ${id}: HTTP ${res.status}`);
            continue;
          }
          if (isBinary) {
            const buf = Buffer.from(await res.arrayBuffer());
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
          } else {
            const text = await res.text();
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, text, 'utf8');
          }
          downloaded.push(file);
          debug('main', `store:install downloaded ${file} for ${id}`);
        } catch (err) {
          // Try local fallback
          try {
            const localFile = path.join(localBase, file);
            if (fs.existsSync(localFile)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.copyFileSync(localFile, dest);
              downloaded.push(file);
              continue;
            }
          } catch {}
          debug('main', `store:install failed ${file} for ${id}: ${err.message}`);
        }
      }
      if (!downloaded.includes('manifest.json')) throw new Error('Failed to download manifest.json');
      if (!downloaded.some(f => f.endsWith('.js'))) throw new Error('No JavaScript files downloaded');

      // Validate and load
      const result = await modLoader.loadOne(id);
      // If loadOne didn't find it (because discover hasn't run), rediscover
      if (result.status === 'not_found') {
        await modLoader.discover();
        const retry = await modLoader.loadOne(id);
        if (retry.status === 'error' || retry.status === 'invalid') throw new Error(retry.error);
      }
      sendModStatus();
      info('main', `store:install ${id} done, downloaded: ${downloaded.join(', ')}`);
      return { ok: true, downloaded, modId: id };
    } catch (err) {
      logError('main', `store:install failed ${id}: ${err.message}`);
      // Cleanup partial
      try { fs.rmSync(path.join(modLoader.getModsDir(), id), { recursive: true, force: true }); } catch {}
      return { ok: false, error: err.message };
    }
  });

  // Forward mod events to renderer
  modBus.on(MOD_EVENTS.MOD_ENABLED, (p) => send('mods:status', modLoader.list()));
  modBus.on(MOD_EVENTS.MOD_DISABLED, (p) => send('mods:status', modLoader.list()));
}

// ---------------------------------------------------------------- bootstrap

app.whenReady().then(async () => {
  const layout = ensureDataLayout();
  info('main', `data layout root=${layout.root} mods=${layout.mods} config=${layout.config}`);
  migrateLegacyStore();
  store = new Store(path.join(app.getPath('userData'), 'store.json'));
  mcp = new McpManager(status => send('mcp:status', status));
  global._mcpManager = mcp;
  engine = new ChatEngine({ store, mcp, send });
  createWindow();
  registerIpc();
  const updateLoading = (text, sub) => send('loading:update', { text, sub });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  updateLoading('Initializing...', 'Starting Nexus AI');
  await sleep(100);

  updateLoading('Starting OAuth server...', 'Shared callback on port 34115');
  await sleep(100);
  try {
    const { ensureSharedCallbackServer } = require('./mcp-oauth');
    await ensureSharedCallbackServer();
    info('main', 'shared OAuth callback server ready');
  } catch (e) { warn('main', `OAuth server failed: ${e.message}`); }

  updateLoading('Connecting MCP servers...', 'Checking authorization tokens');
  await sleep(100);
  try {
    await setupMcp();
    const statuses = mcp.getServerStatus();
    const connected = statuses.filter(s => s.status === 'ready').length;
    info('main', `MCPs refreshed: ${statuses.map(s=>s.name+':'+s.status).join(', ')}`);
    updateLoading('MCP servers ready', `${connected}/${statuses.length} connected`);
  } catch (e) { logError('main', `MCP refresh failed: ${e.message}`); }
  await sleep(200);

  updateLoading('Loading models...', 'Fetching available models');
  await sleep(100);
  try {
    const models = await getModelList();
    info('main', `models loaded ${models.length}`);
    updateLoading('Models loaded', `${models.length} models available`);
    send('loading:models', models);
  } catch (e) { warn('main', `models preload failed: ${e.message}`); }
  await sleep(200);

  updateLoading('Bootstrapping mods...', 'Loading custom tools and providers');
  await sleep(100);
  try {
    modBus.emitSafe(MOD_EVENTS.APP_START, {});
    const modResults = await modLoader.loadAll();
    info('main', `mods loaded last: ${modResults.map(r=>`${r.id}:${r.status}`).join(', ')}`);
    const enabled = modResults.filter(r => r.status === 'enabled').length;
    updateLoading('Mods loaded', `${enabled}/${modResults.length} mods active`);
    sendModStatus();
  } catch (e) { logError('main', `mod loading failed: ${e.message}`); }
  await sleep(200);

  updateLoading('Final model refresh...', 'Including mod-provided models');
  await sleep(100);
  try {
    const finalModels = await getModelList();
    info('main', `final models refresh after mods: ${finalModels.length}`);
    updateLoading('All models loaded', `${finalModels.length} models ready`);
    send('loading:models', finalModels);
  } catch (e) { warn('main', `final models refresh failed: ${e.message}`); }
  await sleep(300);

  updateLoading('Ready', '');
  await sleep(100);
  send('loading:done');

  if (process.argv.includes('--smoke-test')) {
    setTimeout(async () => {
      try {
        const dump = await mainWindow.webContents.executeJavaScript(`({
          convItems: document.querySelectorAll('.conv-item').length,
          brand: document.querySelector('#brand-model')?.textContent,
          conn: document.querySelector('#conn-status')?.className,
          mcpItems: document.querySelectorAll('.mcp-item').length,
          mcpCount: document.querySelector('#mcp-count')?.textContent,
          hasInput: !!document.querySelector('#input'),
          apiType: typeof window.api,
        })`);
        console.log('[smoke] ' + JSON.stringify(dump));
      } catch (err) {
        console.log('[smoke] dump failed:', err.message);
      }
      console.log('[smoke] window created, exiting');
      app.quit();
    }, 6000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (e) => {
  // Allow async shutdown to complete - prevent quit until mcp cleaned up
  if (mcp && !global._quitting) {
    e.preventDefault();
    global._quitting = true;
    (async () => {
      try { await mcp.shutdown(); } catch { /* ignore */ }
      app.quit();
    })();
  }
});
