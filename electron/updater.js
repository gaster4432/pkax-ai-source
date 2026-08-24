'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { info, warn, error: logError } = require('./logger');

const REGISTRY_PACKAGES_URL = process.env.MOD_REGISTRY_URL
  || 'https://raw.githubusercontent.com/gaster4432/CF-AI-Mod-Registry/main/packages.json';
const REGISTRY_BASE = REGISTRY_PACKAGES_URL.replace(/packages\.json(\?.*)?$/, '');
const UPDATES_URL = REGISTRY_BASE + 'core/updates.json';

const STATE_FILE = 'update-state.json';

let installDir = null;
let busy = false;
let cachedMeta = null;

// ---------------------------------------------------------------- state

function getStatePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
  } catch {
    return { status: 'idle' };
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(next, null, 2));
  } catch (e) {
    warn('updater', `failed to persist state: ${e.message}`);
  }
  return next;
}

// ---------------------------------------------------------------- helpers

function semverCompare(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function safePath(p) {
  if (typeof p !== 'string') throw new Error('invalid update path');
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (!norm || norm === '.' || norm.startsWith('/') || norm.startsWith('../')
    || norm.split('/').includes('..') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`unsafe update path: ${p}`);
  }
  return norm;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveInstallDir() {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, 'app');
  try {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------- check + update flow

async function checkForUpdates() {
  if (!installDir) return;
  const current = app.getVersion();
  const st = readState();

  // Recover from states that cannot survive a restart:
  // - 'downloading': process died mid-download
  // - 'ready'/'available' for a version <= current: already applied or superseded
  if (st.status === 'downloading') {
    writeState({ status: 'idle', error: undefined });
  } else if ((st.status === 'ready' || st.status === 'available')
    && st.version && semverCompare(st.version, current) <= 0) {
    info('updater', `clearing stale ${st.status} state for ${st.version} (current ${current})`);
    writeState({ status: 'idle', version: undefined, notes: undefined, error: undefined });
  }
  if (readState().status !== 'idle') return; // genuinely pending newer version

  let meta;
  try {
    meta = JSON.parse((await fetchBuffer(UPDATES_URL)).toString('utf8'));
  } catch (e) {
    info('updater', `no update metadata reachable (${e.message})`);
    return;
  }
  if (!meta || typeof meta.latest !== 'string'
    || (!Array.isArray(meta.files) && !Array.isArray(meta.fullFiles))) {
    warn('updater', 'malformed updates.json - ignoring');
    return;
  }
  cachedMeta = meta;
  if (semverCompare(meta.latest, current) <= 0) {
    if (readState().status !== 'idle') writeState({ status: 'idle', version: undefined, error: undefined });
    return;
  }
  writeState({ status: 'available', version: meta.latest, notes: meta.notes || '', error: undefined });
  info('updater', `update available: ${current} -> ${meta.latest}`);
}

async function startUpdate() {
  if (!installDir) throw new Error('updater unavailable (dev mode or unpackaged)');
  if (busy) throw new Error('update already in progress');
  busy = true;
  const prevVersion = app.getVersion();
  writeState({ status: 'downloading', error: undefined });
  try {
    let meta = cachedMeta;
    if (!meta) {
      meta = JSON.parse((await fetchBuffer(UPDATES_URL)).toString('utf8'));
      cachedMeta = meta;
    }
    if (!meta || typeof meta.latest !== 'string') {
      throw new Error('malformed updates.json');
    }

    // Delta only applies cleanly when coming from its exact base version;
    // anything else takes the full-file path.
    const current = app.getVersion();
    const useDelta = typeof meta.deltaFrom === 'string' && semverCompare(current, meta.deltaFrom) === 0;
    let entries;
    if (useDelta) {
      info('updater', `delta path: ${meta.deltaFrom} -> ${meta.latest}`);
      entries = meta.files || [];
    } else if (Array.isArray(meta.fullFiles) && meta.fullFiles.length) {
      info('updater', `full path: ${current} -> ${meta.latest} (${meta.fullFiles.length} files)`);
      entries = meta.fullFiles;
    } else {
      throw new Error(`no applicable update path from ${current} (deltaFrom: ${meta.deltaFrom || 'none'})`);
    }

    // Phase 1: download everything to staging, verify hashes. Touch nothing yet.
    const tmpBase = path.join(app.getPath('userData'), 'update-tmp', meta.latest);
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpBase, { recursive: true });

    const jobs = [];
    for (const entry of entries) {
      if (entry.type === 'installer') {
        jobs.push({ type: 'installer', url: entry.url });
        continue;
      }
      const rel = safePath(entry.path);
      const buf = await fetchBuffer(entry.url);
      const expected = (entry.sha256 || '').toLowerCase();
      if (expected && sha256(buf) !== expected) {
        throw new Error(`hash mismatch for ${rel} - aborting`);
      }
      const dest = path.join(tmpBase, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      jobs.push({ type: 'file', path: rel });
    }

    // Phase 2: back up originals.
    const backupRoot = path.join(app.getPath('userData'), 'update-backup', prevVersion);
    for (const j of jobs) {
      if (j.type !== 'file') continue;
      const cur = path.join(installDir, j.path);
      if (!fs.existsSync(cur)) continue;
      const bdest = path.join(backupRoot, j.path);
      fs.mkdirSync(path.dirname(bdest), { recursive: true });
      fs.copyFileSync(cur, bdest);
    }

    // Phase 3: apply.
    for (const j of jobs) {
      if (j.type !== 'file') continue;
      const src = path.join(tmpBase, j.path);
      const dst = path.join(installDir, j.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }

    // Cleanup staging.
    try { fs.rmSync(path.join(app.getPath('userData'), 'update-tmp'), { recursive: true, force: true }); } catch { /* ignore */ }

    writeState({ status: 'ready', version: meta.latest, notes: meta.notes || '' });
    info('updater', `update ${meta.latest} staged - restart to apply`);
  } catch (e) {
    logError('updater', `update failed: ${e.message}`);
    writeState({ status: 'error', error: e.message, version: cachedMeta?.latest });
    throw e;
  } finally {
    busy = false;
  }
}

function restartToApply() {
  const st = readState();
  if (st.status !== 'ready') throw new Error('no staged update to apply');
  info('updater', 'relaunching to apply update');
  app.relaunch();
  setTimeout(() => app.exit(0), 200);
}

// ---------------------------------------------------------------- IPC wiring

function registerUpdaterIpc(ipcMain) {
  ipcMain.handle('updater:status', () => ({
    ok: true,
    supported: !!installDir,
    state: readState(),
    currentVersion: app.getVersion(),
  }));
  ipcMain.handle('updater:start', async () => {
    try {
      await startUpdate();
      return { ok: true, state: readState() };
    } catch (e) {
      return { ok: false, error: e.message, state: readState() };
    }
  });
  ipcMain.handle('updater:restart', () => {
    try {
      restartToApply();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function initUpdater() {
  installDir = resolveInstallDir();
  if (!installDir) {
    info('updater', 'dev/unpackaged mode - auto-update disabled');
    return;
  }
  info('updater', `install dir: ${installDir}`);
  checkForUpdates().catch(e => warn('updater', `initial check failed: ${e.message}`));
}

module.exports = { initUpdater, registerUpdaterIpc };
