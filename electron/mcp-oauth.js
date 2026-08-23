'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
let _electronApp = null;
try { ({ app: _electronApp } = require('electron')); } catch { /* plain-node */ }
const { shell } = require('electron');
const { debug, info, warn, error: logError } = require('./logger');
const { getMcpCredentialsPath } = require('./appdata');

let credentialsFile = null;

function getCredentialsPath() {
  if (credentialsFile) return credentialsFile;
  credentialsFile = getMcpCredentialsPath();
  debug('oauth', `credentials file: ${credentialsFile}`);
  return credentialsFile;
}

function loadAllCredentials() {
  const file = getCredentialsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      debug('oauth', `loaded credentials for ${Object.keys(data).length} server(s) from ${file}`);
      return data;
    }
  } catch (e) {
    logError('oauth', `failed to load credentials from ${file}: ${e.message}`);
  }
  return {};
}

function saveAllCredentials(data) {
  const file = getCredentialsPath();
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    info('oauth', `saved credentials for ${Object.keys(data).length} server(s) to ${file}`);
  } catch (e) {
    logError('oauth', `failed to save credentials to ${file}: ${e.message}`);
  }
}

function loadServerCredentials(serverName) {
  const all = loadAllCredentials();
  return all[serverName] || {};
}

function saveServerCredentials(serverName, patch) {
  const all = loadAllCredentials();
  all[serverName] = { ...(all[serverName] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveAllCredentials(all);
}

// Provider implementing OAuthClientProvider interface with file persistence
class FileOAuthProvider {
  constructor({ serverName, serverUrl, redirectUrl }) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this._redirectUrl = redirectUrl;
    this._codeVerifier = null;
    const saved = loadServerCredentials(serverName);
    this._clientInformation = saved.clientInformation;
    this._tokens = saved.tokens;
    this._codeVerifierPersisted = saved.codeVerifier;
    this._discoveryState = saved.discoveryState;
    if (this._codeVerifierPersisted) this._codeVerifier = this._codeVerifierPersisted;
    debug('oauth', `provider created for ${serverName} url=${serverUrl} redirect=${redirectUrl} hasTokens=${!!this._tokens} hasClientInfo=${!!this._clientInformation}`);
  }

  get redirectUrl() { return this._redirectUrl; }

  get clientMetadata() {
    // Do NOT set scope here - let the server's resource metadata dictate scope.
    // Hardcoding 'openid profile email' causes "invalid scope" on some Cloudflare MCPs (e.g. observability).
    return {
      client_name: `Nexus AI - ${this.serverName}`,
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client, no secret
    };
  }

  // SDK may call state() to get PKCE state param; we store mapping for callback routing if needed
  async state() {
    const s = crypto.randomBytes(16).toString('hex');
    debug('oauth', `${this.serverName} generated state ${s.slice(0,8)}...`);
    return s;
  }

  clientInformation() {
    // If saved client was registered with a different redirect_uri (old random port), ignore it so we re-register with shared fixed port
    if (this._clientInformation && this._clientInformation.redirect_uris && !this._clientInformation.redirect_uris.includes(this._redirectUrl)) {
      debug('oauth', `${this.serverName} saved clientInformation has stale redirect_uris ${JSON.stringify(this._clientInformation.redirect_uris)} vs ${this._redirectUrl} - ignoring to re-register`);
      return undefined;
    }
    debug('oauth', `${this.serverName} clientInformation -> ${this._clientInformation ? 'found' : 'none'}`);
    return this._clientInformation;
  }

  async saveClientInformation(clientInformation) {
    info('oauth', `${this.serverName} saveClientInformation client_id=${clientInformation.client_id?.slice(0,20)}...`);
    this._clientInformation = clientInformation;
    saveServerCredentials(this.serverName, { clientInformation });
  }

  tokens() {
    debug('oauth', `${this.serverName} tokens -> ${this._tokens ? `found expiry=${this._tokens.expires_in || '?'}` : 'none'}`);
    return this._tokens;
  }

  async saveTokens(tokens) {
    info('oauth', `${this.serverName} saveTokens access_token=${tokens.access_token?.slice(0,20)}... refresh=${!!tokens.refresh_token} expires_in=${tokens.expires_in}`);
    this._tokens = tokens;
    saveServerCredentials(this.serverName, { tokens });
  }

  async redirectToAuthorization(authorizationUrl) {
    const urlStr = authorizationUrl.toString();
    info('oauth', `${this.serverName} redirectToAuthorization opening browser: ${urlStr.slice(0,300)}`);
    try {
      await shell.openExternal(urlStr);
      info('oauth', `${this.serverName} browser opened for OAuth`);
    } catch (e) {
      logError('oauth', `${this.serverName} failed to open browser: ${e.message}`);
      throw e;
    }
  }

  async saveCodeVerifier(codeVerifier) {
    debug('oauth', `${this.serverName} saveCodeVerifier ${codeVerifier.slice(0,20)}...`);
    this._codeVerifier = codeVerifier;
    saveServerCredentials(this.serverName, { codeVerifier });
  }

  async codeVerifier() {
    if (!this._codeVerifier) {
      const saved = loadServerCredentials(this.serverName);
      this._codeVerifier = saved.codeVerifier;
    }
    if (!this._codeVerifier) throw new Error(`No code verifier for ${this.serverName}`);
    debug('oauth', `${this.serverName} codeVerifier retrieved`);
    return this._codeVerifier;
  }

  async saveDiscoveryState(state) {
    debug('oauth', `${this.serverName} saveDiscoveryState`);
    this._discoveryState = state;
    saveServerCredentials(this.serverName, { discoveryState: state });
  }

  discoveryState() {
    if (this._discoveryState) debug('oauth', `${this.serverName} discoveryState found`);
    return this._discoveryState;
  }

  async invalidateCredentials(scope) {
    warn('oauth', `${this.serverName} invalidateCredentials scope=${scope}`);
    const all = loadAllCredentials();
    if (!all[this.serverName]) return;
    if (scope === 'all') delete all[this.serverName];
    else if (scope === 'tokens') delete all[this.serverName].tokens;
    else if (scope === 'client') delete all[this.serverName].clientInformation;
    else if (scope === 'verifier') { delete all[this.serverName].codeVerifier; this._codeVerifier = null; }
    else if (scope === 'discovery') delete all[this.serverName].discoveryState;
    saveAllCredentials(all);
    if (scope === 'all' || scope === 'tokens') this._tokens = undefined;
    if (scope === 'all' || scope === 'client') this._clientInformation = undefined;
  }
}

// Shared persistent callback server - started lazily only when an OAuth flow
// needs it, and stopped again after an idle period with no pending authorizations.
let sharedServer = null;
let sharedPort = 34115;
let pendingAuth = null; // { serverName, resolve, reject, timeoutId, expectedState }
let idleStopTimer = null;

const IDLE_STOP_MS = 30 * 1000;

function cancelIdleStop() {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
}

function scheduleIdleStop() {
  cancelIdleStop();
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    if (!pendingAuth) {
      info('oauth', `no pending authorizations - stopping callback server (was on port ${sharedPort})`);
      stopSharedCallbackServer();
    }
  }, IDLE_STOP_MS);
  if (idleStopTimer.unref) idleStopTimer.unref();
}

function ensureSharedCallbackServer() {
  cancelIdleStop();
  if (sharedServer) return Promise.resolve(sharedServer);
  return new Promise((resolve, reject) => {
    sharedServer = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') {
        res.writeHead(404); res.end(); return;
      }
      // Log raw URL for debugging - example: /callback?code=360f9ca9...&state=a6249...&iss=https%3A%2F%2Fbindings...
      info('oauth', `shared callback received: ${req.url?.slice(0,500)}`);
      const parsed = new URL(req.url || '', `http://localhost:${sharedPort}`);
      // Accept any path that looks like callback - we don't require pre-registration of code
      // Just look for ?code= param as user requested: "do not register the call back code ... just needs to know what to look for"
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');
      const state = parsed.searchParams.get('state');
      const iss = parsed.searchParams.get('iss');
      debug('oauth', `callback parsed code=${code?.slice(0,30)}... state=${state?.slice(0,10)} iss=${iss?.slice(0,40)} error=${error}`);

      if (!pendingAuth) {
        warn('oauth', `callback received but no pending auth - ignoring (code=${code?.slice(0,10)})`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:system-ui;background:#0b0d12;color:#e8ebf2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;background:#11141c;padding:40px;border-radius:16px;border:1px solid #222834"><h1 style="color:#f1c40f">No pending authorization</h1><p>No OAuth flow is waiting. You can close this window.</p><p style="color:#98a1b3;font-size:13px">Code was: ${code?code.slice(0,20)+'...':''}</p></div></body></html>`);
        return;
      }

      // Optional state verification - if provider generated a state, we can optionally check it matches
      // But we don't enforce strictly; just log mismatch
      if (state && pendingAuth.expectedState && state !== pendingAuth.expectedState) {
        warn('oauth', `state mismatch expected=${pendingAuth.expectedState?.slice(0,10)} got=${state.slice(0,10)} - still accepting code for ${pendingAuth.serverName}`);
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><head><title>Authorized</title></head><body style="font-family: system-ui; background:#0b0d12; color:#e8ebf2; display:flex; align-items:center; justify-content:center; height:100vh; margin:0">
            <div style="text-align:center; background:#11141c; padding:40px; border-radius:16px; border:1px solid #222834">
              <h1 style="color:#2ecc71">✓ Authorized</h1>
              <p>Nexus AI can now access <b>${pendingAuth.serverName}</b>.</p>
              <p style="color:#98a1b3; font-size:13px">You can close this window and return to the app. Continue authorizing remaining servers if needed.</p>
              <p style="color:#98a1b3; font-size:11px">Tokens saved to credentials.json for shipping.</p>
              <script>setTimeout(()=>window.close(), 2500)</script>
            </div>
          </body></html>`);
        const toResolve = pendingAuth;
        pendingAuth = null;
        if (toResolve.timeoutId) clearTimeout(toResolve.timeoutId);
        info('oauth', `resolved pending auth for ${toResolve.serverName} code=${code.slice(0,20)}...`);
        toResolve.resolve(code);
      } else if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:system-ui;background:#0b0d12;color:#e8ebf2;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center;background:#11141c;padding:40px;border-radius:16px;border:1px solid #e74c3c"><h1 style="color:#e74c3c">Auth failed</h1><p>${error}</p><p>${parsed.searchParams.get('error_description')||''}</p></div></body></html>`);
        const toReject = pendingAuth;
        pendingAuth = null;
        if (toReject && toReject.timeoutId) clearTimeout(toReject.timeoutId);
        toReject.reject(new Error(`OAuth error: ${error} ${parsed.searchParams.get('error_description')||''}`));
        scheduleIdleStop();
      } else {
        res.writeHead(400); res.end('Missing code - no ?code= param found in callback');
        const toReject = pendingAuth;
        pendingAuth = null;
        if (toReject && toReject.timeoutId) clearTimeout(toReject.timeoutId);
        toReject.reject(new Error('No code in callback'));
        scheduleIdleStop();
      }
    });

    sharedServer.on('error', (err) => {
      logError('oauth', `shared callback server error on port ${sharedPort}: ${err.message}`);
      // If port in use, try next port
      if (err.code === 'EADDRINUSE') {
        sharedPort++;
        info('oauth', `port in use, trying ${sharedPort}`);
        sharedServer = null;
        ensureSharedCallbackServer().then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    sharedServer.listen(sharedPort, '127.0.0.1', () => {
      info('oauth', `shared OAuth callback server listening on http://localhost:${sharedPort}/callback (lazy - stops after 30s idle)`);
      resolve(sharedServer);
    });
  });
}

function stopSharedCallbackServer() {
  if (sharedServer) {
    try { sharedServer.close(); } catch {}
    sharedServer = null;
    info('oauth', 'shared callback server stopped');
  }
  if (pendingAuth && pendingAuth.timeoutId) clearTimeout(pendingAuth.timeoutId);
  pendingAuth = null;
}

// Called on app quit
if (_electronApp) {
  _electronApp.on('before-quit', () => stopSharedCallbackServer());
}

// Helper for single OAuth flow using shared server
function createCallbackServerForFlow(serverName, expectedState) {
  return new Promise(async (resolve, reject) => {
    await ensureSharedCallbackServer();
    if (pendingAuth) {
      warn('oauth', `overwriting pending auth for ${pendingAuth.serverName} with new request for ${serverName}`);
      // Reject previous pending? No, just overwrite - user wanted sequential, so previous should have completed
    }
    const timeoutId = setTimeout(() => {
      if (pendingAuth && pendingAuth.serverName === serverName) {
        logError('oauth', `callback timeout after 5m for ${serverName}`);
        pendingAuth = null;
        reject(new Error('OAuth callback timeout (5 minutes) - please try again. The callback server is still hosting, you can retry.'));
      }
    }, 5 * 60 * 1000);
    if (timeoutId.unref) timeoutId.unref();
    pendingAuth = { serverName, resolve, reject, timeoutId, expectedState };
    info('oauth', `registered pending auth for ${serverName} expecting state ${expectedState?.slice(0,10)} on shared server port ${sharedPort}`);
  });
}

// High-level flow: start auth for a server, open browser, wait for code via shared server, exchange, persist
// This does NOT open all at once - caller must invoke per server via button click as user requested
async function performOAuthFlow(serverName, serverUrl) {
  // Use shared fixed redirect URL for all flows - ensures server stays hosting
  await ensureSharedCallbackServer();
  const redirectUrl = `http://localhost:${sharedPort}/callback`;
  info('oauth', `performOAuthFlow ${serverName} ${serverUrl} redirect=${redirectUrl} (shared persistent)`);
  const provider = new FileOAuthProvider({ serverName, serverUrl, redirectUrl });
  const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');

  let codePromise = null;
  let expectedState = null;

  // Intercept state() to capture expected state for verification
  const originalState = provider.state.bind(provider);
  provider.state = async () => {
    const s = await originalState();
    expectedState = s;
    debug('oauth', `${serverName} captured expected state ${s.slice(0,10)} for callback matching`);
    return s;
  };

  // Wrap redirect to start waiting BEFORE opening browser
  const originalRedirect = provider.redirectToAuthorization.bind(provider);
  provider.redirectToAuthorization = async (url) => {
    info('oauth', `${serverName} redirectToAuthorization intercepted, registering pending auth on shared server`);
    // Register pending BEFORE opening browser so we don't miss the callback
    codePromise = createCallbackServerForFlow(serverName, expectedState);
    await originalRedirect(url);
    info('oauth', `${serverName} browser opened, waiting for callback on shared server port ${sharedPort}...`);
  };

  try {
    const result = await auth(provider, { serverUrl });
    debug('oauth', `${serverName} auth() first call result=${result}`);
    if (result === 'REDIRECT') {
      if (!codePromise) {
        // Provider didn't call redirect (maybe needs manual trigger) - create pending now
        warn('oauth', `${serverName} auth returned REDIRECT but no redirect seen - creating pending`);
        codePromise = createCallbackServerForFlow(serverName, expectedState);
      }
      info('oauth', `${serverName} waiting for user to complete browser auth on shared server...`);
      const code = await codePromise;
      info('oauth', `${serverName} got code ${code.slice(0,30)}..., exchanging for tokens`);
      // Don't register code - just look for it in request as user requested; the code is the one from ?code= param
      const result2 = await auth(provider, { serverUrl, authorizationCode: code });
      info('oauth', `${serverName} auth second call result=${result2}`);
      if (result2 === 'AUTHORIZED') {
        info('oauth', `${serverName} OAuth AUTHORIZED`);
        return { success: true, provider };
      } else {
        warn('oauth', `${serverName} unexpected second auth result ${result2}`);
        return { success: false, error: `Unexpected result ${result2}` };
      }
    } else if (result === 'AUTHORIZED') {
      info('oauth', `${serverName} already AUTHORIZED (existing tokens)`);
      return { success: true, provider };
    } else {
      warn('oauth', `${serverName} auth result ${result}`);
      return { success: false, error: `Auth result ${result}` };
    }
  } catch (e) {
    logError('oauth', `${serverName} performOAuthFlow failed: ${e.message} ${e.stack?.split('\n').slice(1,2).join(' | ')}`);
    throw e;
  } finally {
    if (!pendingAuth) scheduleIdleStop();
  }
}

function getServersNeedingOAuth(mcpManager) {
  const out = [];
  for (const [name, s] of mcpManager.servers) {
    if (s.cfg.type === 'http' && (s.status === 'needs_auth' || s.status === 'error') && s.error && /oauth|unauthorized|401|auth/i.test(s.error)) {
      out.push({ name, url: s.cfg.url, status: s.status, error: s.error });
    } else if (s.cfg.type === 'http' && s.status === 'needs_auth') {
      out.push({ name, url: s.cfg.url, status: s.status, error: s.error });
    }
  }
  return out;
}

module.exports = {
  FileOAuthProvider,
  getCredentialsPath,
  loadAllCredentials,
  saveAllCredentials,
  createCallbackServer: ensureSharedCallbackServer, // alias for compat
  ensureSharedCallbackServer,
  getSharedCallbackUrl: () => `http://localhost:${sharedPort}/callback`,
  performOAuthFlow,
  getServersNeedingOAuth,
  stopSharedCallbackServer,
};
