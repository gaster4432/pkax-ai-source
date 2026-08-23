'use strict';

const MOD_API_VERSION = '1.0.0';
const SUPPORTED_API_VERSIONS = ['1.0.0'];

// Simple semver check: only major version must match for 1.0.0
function isApiVersionCompatible(required, supported = MOD_API_VERSION) {
  if (!required) return false;
  // Allow exact match or ^1.0.0 style
  const clean = required.replace(/^\^|~/, '').trim();
  const [reqMajor] = clean.split('.');
  const [supMajor] = supported.split('.');
  // For 1.x, require same major
  return reqMajor === supMajor;
}

const VALID_PERMISSIONS = new Set([
  'storage',
  'systemPrompt',
  'tools',
  'config',
  'providers',
  'models',
  'mcp',
  'events',
  'logger',
  'commands',
  'shell', // shell execution
  'fs', // file system read
]);

function validateManifest(raw, modPath) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }
  const required = ['id', 'name', 'version', 'modApiVersion'];
  for (const f of required) {
    if (!raw[f] || typeof raw[f] !== 'string' || !raw[f].trim()) {
      errors.push(`Missing or empty required field: ${f}`);
    }
  }
  if (raw.id && !/^[a-z0-9][a-z0-9-_]{1,48}$/.test(raw.id)) {
    errors.push('id must be 2-49 chars, lowercase alphanumeric, hyphen/underscore, start with alphanumeric');
  }
  if (raw.version && !/^\d+\.\d+\.\d+/.test(raw.version)) {
    errors.push('version must be semver (e.g. 1.0.0)');
  }
  if (raw.modApiVersion && !SUPPORTED_API_VERSIONS.includes(raw.modApiVersion) && !isApiVersionCompatible(raw.modApiVersion)) {
    errors.push(`Unsupported modApiVersion ${raw.modApiVersion}. Supported: ${SUPPORTED_API_VERSIONS.join(', ')}`);
  }
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) errors.push('permissions must be an array');
    else {
      for (const p of raw.permissions) {
        if (!VALID_PERMISSIONS.has(p)) errors.push(`Unknown permission: ${p}`);
      }
    }
  }
  if (raw.dependencies !== undefined) {
    if (typeof raw.dependencies !== 'object' || Array.isArray(raw.dependencies)) errors.push('dependencies must be an object {modId: versionRange}');
    else {
      for (const [depId, range] of Object.entries(raw.dependencies)) {
        if (!/^[a-z0-9][a-z0-9-_]+$/.test(depId)) errors.push(`Invalid dependency id: ${depId}`);
        if (typeof range !== 'string') errors.push(`Dependency ${depId} version must be string`);
      }
    }
  }
  if (raw.author !== undefined && typeof raw.author !== 'string') errors.push('author must be string');
  if (raw.description !== undefined && typeof raw.description !== 'string') errors.push('description must be string');
  if (raw.main !== undefined && typeof raw.main !== 'string') errors.push('main must be string');
  return { valid: errors.length === 0, errors };
}

module.exports = { MOD_API_VERSION, SUPPORTED_API_VERSIONS, isApiVersionCompatible, validateManifest, VALID_PERMISSIONS };
