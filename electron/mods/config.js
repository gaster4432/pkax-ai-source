'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { debug, info } = require('../logger');

function getModConfigPath(modId) {
  try {
    if (app && app.getPath) {
      const dir = path.join(app.getPath('userData'), 'mod-configs');
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, `${modId}.json`);
    }
  } catch {}
  const fallbackDir = path.join(__dirname, '..', '..', 'storage', modId);
  fs.mkdirSync(fallbackDir, { recursive: true });
  return path.join(fallbackDir, 'config.json');
}

function loadModConfig(modId) {
  const file = getModConfigPath(modId);
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      debug('mods', `config load ${modId} from ${file} keys=${Object.keys(data).join(',')}`);
      return data;
    }
  } catch (e) {
    console.error(`[mods] failed to load config for ${modId}:`, e.message);
  }
  return {};
}

function saveModConfig(modId, data) {
  const file = getModConfigPath(modId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    debug('mods', `config save ${modId} to ${file}`);
  } catch (e) {
    console.error(`[mods] failed to save config for ${modId}:`, e.message);
  }
}

function createConfigApi(modId, permissions) {
  const hasPermission = !permissions || permissions.includes('config');
  let cache = loadModConfig(modId);
  let saveTimer = null;

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveModConfig(modId, cache);
      saveTimer = null;
    }, 300);
    if (saveTimer.unref) saveTimer.unref();
  };

  return {
    get(key, defaultValue) {
      if (!hasPermission) throw new Error(`Mod ${modId} lacks permission: config`);
      if (key === undefined) return { ...cache };
      return cache[key] !== undefined ? cache[key] : defaultValue;
    },
    set(key, value) {
      if (!hasPermission) throw new Error(`Mod ${modId} lacks permission: config`);
      if (typeof key === 'object' && key !== null) {
        cache = { ...cache, ...key };
      } else {
        cache[key] = value;
      }
      scheduleSave();
      info('mods', `config set ${modId}.${key}=${JSON.stringify(value).slice(0,100)}`);
      return true;
    },
    has(key) {
      if (!hasPermission) throw new Error(`Mod ${modId} lacks permission: config`);
      return cache[key] !== undefined;
    },
    delete(key) {
      if (!hasPermission) throw new Error(`Mod ${modId} lacks permission: config`);
      delete cache[key];
      scheduleSave();
      return true;
    },
    clear() {
      if (!hasPermission) throw new Error(`Mod ${modId} lacks permission: config`);
      cache = {};
      saveModConfig(modId, cache);
      return true;
    },
    // Expose path for debugging
    _path: getModConfigPath(modId),
  };
}

module.exports = { createConfigApi, getModConfigPath, loadModConfig, saveModConfig };
