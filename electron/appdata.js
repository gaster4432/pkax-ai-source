'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let _app = null;
try { ({ app: _app } = require('electron')); } catch { /* plain-node (scripts/tests) */ }

const APP_FOLDER_NAME = 'Pkax';
const SEED_FILES = ['config.jsonc', 'credentials.json'];
const CONFIG_FILE_NAMES = ['config.jsonc', 'config.json'];

function mkdirp(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

function appDataBase() {
  try { if (_app && _app.getPath) return _app.getPath('appData'); } catch { /* ignore */ }
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function getAppDataRoot() {
  return path.join(appDataBase(), APP_FOLDER_NAME);
}

function getUserDataDir() {
  return mkdirp(getAppDataRoot());
}

function getModsDir() {
  return mkdirp(path.join(getUserDataDir(), 'mods'));
}

function getConfigDir() {
  return mkdirp(path.join(getUserDataDir(), 'config'));
}

function getMcpConfigPath() {
  const dir = getConfigDir();
  for (const name of CONFIG_FILE_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, 'config.jsonc');
}

function getMcpCredentialsPath() {
  return path.join(getConfigDir(), 'credentials.json');
}

function getCloudflareSettingsPath() {
  return path.join(getConfigDir(), 'cloudflare.json');
}

function seedProjectFiles() {
  const dir = getConfigDir();
  for (const name of SEED_FILES) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(__dirname, '..', name);
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        if (_app) {
          try { require('./logger').info('appdata', `seeded ${name} -> ${dest}`); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.error(`[appdata] failed to seed ${name}: ${err.message}`);
    }
  }
}

function ensureDataLayout() {
  const root = getUserDataDir();
  const mods = getModsDir();
  const config = getConfigDir();
  seedProjectFiles();
  return { root, mods, config };
}

module.exports = {
  APP_FOLDER_NAME,
  getAppDataRoot,
  getUserDataDir,
  getModsDir,
  getConfigDir,
  getMcpConfigPath,
  getMcpCredentialsPath,
  getCloudflareSettingsPath,
  ensureDataLayout,
};
