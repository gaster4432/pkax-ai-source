'use strict';

const fs = require('fs');
const path = require('path');
const { debug, info, warn, error: logError } = require('./logger');
const { getConfigDir, getCloudflareSettingsPath, getMcpConfigPath } = require('./appdata');

debug('config', `config dir=${getConfigDir()}`);

const DEFAULT_CHAT_MODEL = '@cf/qwen/qwen3.8-27b';
const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

function firstDefined(obj, keys) {
  if (!obj) return '';
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function readCloudflareJson() {
  const file = getCloudflareSettingsPath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    logError('config', `failed to read ${file}: ${err.message}`);
  }
  return {};
}

function hasCloudflareCredentials() {
  const saved = readCloudflareJson();
  return Boolean(firstDefined(saved, ['apiToken']) && firstDefined(saved, ['accountId']));
}

function getConfig() {
  const saved = readCloudflareJson();
  const token = String(firstDefined(saved, ['apiToken', 'CF_API_TOKEN']) || '');
  const accountId = String(firstDefined(saved, ['accountId', 'CF_ACCOUNT_ID']) || '');
  if (!token || !accountId) {
    const err = new Error(
      'Cloudflare credentials not configured. Enter your Account ID and API token in the setup prompt.'
    );
    err.code = 'NEED_CREDENTIALS';
    throw err;
  }
  return {
    token,
    accountId,
    chatModel: saved.chatModel || DEFAULT_CHAT_MODEL,
    imageModel: saved.imageModel || DEFAULT_IMAGE_MODEL,
    webSearchResults: parseInt(String(saved.webSearchResults || '5'), 10) || 5,
  };
}

function stripJsoncComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseJsonc(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(stripJsoncComments(raw));
}

function findMcpConfig() {
  const candidates = [];
  candidates.push(getMcpConfigPath());
  debug('config', `findMcpConfig candidates: ${candidates.join(' | ')}`);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      info('config', `using MCP config: ${p}`);
      return p;
    }
  }
  warn('config', `no MCP config found in ${candidates.length} candidates`);
  return null;
}

function expandEnv(str) {
  return str.replace(/%([^%]+)%/g, (m, name) => process.env[name] !== undefined ? process.env[name] : m);
}

function isHttpType(t) {
  return ['http', 'https', 'streamable', 'streamableHttp', 'streamable-http', 'streamable_http', 'remote'].includes(String(t));
}
function isSseType(t) { return String(t) === 'sse'; }

function loadLocalMcpServers() { return loadMcpServers(); }

function loadMcpServers() {
  const configPath = findMcpConfig();
  if (!configPath) {
    warn('config', 'loadMcpServers no config file -> 0 servers');
    return [];
  }
  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    debug('config', `loadMcpServers reading ${configPath} ${raw.length} bytes`);
    config = parseJsonc(configPath);
    debug('config', `loadMcpServers parsed mcp keys: ${Object.keys(config.mcp||{}).join(', ') || 'none'}`);
  } catch (err) {
    logError('config', `Failed to parse MCP config at ${configPath}: ${err.message}`);
    return [];
  }
  const mcp = config.mcp || {};
  const servers = [];
  for (const [name, spec] of Object.entries(mcp)) {
    if (!spec || spec.enabled === false) continue;
    const type = spec.type || 'local';
    // --- HTTP / Streamable HTTP remote ---
    if (isHttpType(type)) {
      const rawUrl = spec.url || spec.endpoint || spec.serverUrl;
      if (!rawUrl || typeof rawUrl !== 'string') {
        warn('config', `MCP server "${name}" type=${type} missing url - skipping`);
        continue;
      }
      const url = expandEnv(rawUrl.trim());
      try { new URL(url); } catch {
        warn('config', `MCP server "${name}" has invalid url "${url}" - skipping`);
        continue;
      }
      const headers = spec.headers ? Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, expandEnv(String(v))])) : undefined;
      const env = spec.env ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, expandEnv(String(v))])) : undefined;
      const hasOAuth = spec.oauth !== undefined;
      servers.push({ name, type: 'http', url, headers, env, oauth: hasOAuth ? spec.oauth : undefined, rawType: type });
      continue;
    }
    if (isSseType(type)) {
      const rawUrl = spec.url || spec.endpoint;
      if (!rawUrl || typeof rawUrl !== 'string') {
        warn('config', `MCP server "${name}" type=sse missing url - skipping`);
        continue;
      }
      const url = expandEnv(rawUrl.trim());
      try { new URL(url); } catch {
        warn('config', `MCP server "${name}" has invalid sse url "${url}" - skipping`);
        continue;
      }
      const headers = spec.headers ? Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, expandEnv(String(v))])) : undefined;
      const hasOAuth = spec.oauth !== undefined;
      servers.push({ name, type: 'sse', url, headers, oauth: hasOAuth ? spec.oauth : undefined, rawType: type });
      continue;
    }
    // --- local stdio (default) ---
    if (type !== 'local') {
      warn('config', `MCP server "${name}" has unknown type "${type}" - treating as local`);
    }
    const cmd = spec.command;
    if (!Array.isArray(cmd) || cmd.length === 0) {
      warn('config', `MCP server "${name}" missing command - skipping`);
      continue;
    }
    servers.push({
      name,
      type: 'local',
      command: expandEnv(cmd[0]),
      args: cmd.slice(1).map(expandEnv),
      env: spec.env ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, expandEnv(String(v))])) : undefined,
      cwd: spec.cwd ? expandEnv(String(spec.cwd)) : undefined,
    });
  }
  info('config', `loadMcpServers done ${servers.length} enabled server(s): ${servers.map(s=>`${s.name}:${s.type}`).join(', ')}`);
  servers.forEach(s => debug('config', `  - ${s.name} type=${s.type} ${s.url||s.command} ${s.headers?`headers=${Object.keys(s.headers).join(',')}`:''}`));
  return servers;
}

module.exports = {
  getConfig,
  hasCloudflareCredentials,
  loadLocalMcpServers,
  loadMcpServers,
  findMcpConfig,
  expandEnv,
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGE_MODEL,
};
