'use strict';

// Central verbose logger for main process. Enabled by default; can be quieted with LOG_LEVEL=warn or LOG_LEVEL=error.
// Usage: const { log, debug, info, warn, error } = require('./logger');
// Levels: debug > info > warn > error . Default is debug (most verbose) to satisfy "log more" request.

const levelOrder = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const currentLevel = levelOrder[envLevel] !== undefined ? levelOrder[envLevel] : 0;

function ts() { return new Date().toISOString().slice(11, 23); } // HH:MM:SS.mmm

function fmtArgs(tag, args) {
  return [`[${ts()}][${tag}]`, ...args];
}

function should(level) { return levelOrder[level] >= currentLevel; }

function debug(tag, ...args) { if (should('debug')) console.log(...fmtArgs(tag, args)); }
function info(tag, ...args) { if (should('info')) console.log(...fmtArgs(tag, args)); }
function warn(tag, ...args) { if (should('warn')) console.warn(...fmtArgs(tag, args)); }
function error(tag, ...args) { if (should('error')) console.error(...fmtArgs(tag, args)); }

// shorthand: log is info level
function log(tag, ...args) { info(tag, ...args); }

module.exports = { log, debug, info, warn, error, ts };
