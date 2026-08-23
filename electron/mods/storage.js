'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getBaseStoragePath(modId) {
  // Prefer userData for packaged app, fallback to project storage/<modId>
  try {
    if (app && app.getPath) {
      const p = path.join(app.getPath('userData'), 'mod-storage', modId);
      fs.mkdirSync(p, { recursive: true });
      return p;
    }
  } catch {}
  const fallback = path.join(__dirname, '..', '..', 'storage', modId);
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function resolveSafe(base, relPath) {
  if (!relPath || typeof relPath !== 'string') throw new Error('Path must be a non-empty string');
  if (path.isAbsolute(relPath)) throw new Error('Absolute paths not allowed');
  // Block any path containing .. segment (path traversal)
  const parts = relPath.split(/[\\/]/);
  if (parts.includes('..')) throw new Error(`Path traversal blocked (.. not allowed): ${relPath}`);
  // Also block absolute-like or Windows drive
  if (/^[a-zA-Z]:/.test(relPath)) throw new Error(`Absolute path not allowed: ${relPath}`);
  const normalized = path.normalize(relPath);
  // After normalize, re-check for .. that may have been introduced via a/./../
  if (normalized === '..' || normalized.startsWith('..' + path.sep) || normalized.includes(path.sep + '..' + path.sep) || normalized.includes(path.sep + '..')) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  const full = path.join(base, normalized);
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error(`Path escapes sandbox: ${relPath}`);
  }
  return full;
}

function createStorageApi(modId) {
  const base = getBaseStoragePath(modId);

  return {
    // For testing/debugging
    _basePath: base,

    async readFile(filePath, encoding = 'utf8') {
      const full = resolveSafe(base, filePath);
      return fs.promises.readFile(full, encoding);
    },
    async writeFile(filePath, content, encoding = 'utf8') {
      const full = resolveSafe(base, filePath);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      return fs.promises.writeFile(full, content, encoding);
    },
    async appendFile(filePath, content, encoding = 'utf8') {
      const full = resolveSafe(base, filePath);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      return fs.promises.appendFile(full, content, encoding);
    },
    async exists(filePath) {
      const full = resolveSafe(base, filePath);
      try {
        await fs.promises.access(full);
        return true;
      } catch { return false; }
    },
    async deleteFile(filePath) {
      const full = resolveSafe(base, filePath);
      return fs.promises.unlink(full);
    },
    async mkdir(dirPath) {
      const full = resolveSafe(base, dirPath);
      return fs.promises.mkdir(full, { recursive: true });
    },
    async readdir(dirPath = '.') {
      const full = resolveSafe(base, dirPath);
      return fs.promises.readdir(full);
    },
    async stat(filePath) {
      const full = resolveSafe(base, filePath);
      return fs.promises.stat(full);
    },
    // Alias for list
    async list(dirPath = '.') {
      return this.readdir(dirPath);
    },
    // For sync access if needed
    getPath(relPath = '.') {
      return resolveSafe(base, relPath);
    }
  };
}

module.exports = { createStorageApi, getBaseStoragePath, resolveSafe };
