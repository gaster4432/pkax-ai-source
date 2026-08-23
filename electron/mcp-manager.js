'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { debug, info, warn, error: logError } = require('./logger');

const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 300000;

function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

class McpManager {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.servers = new Map(); // name -> { client, transport, tools, status, error, stderr }
    this.toolMap = new Map(); // fullName -> { server, toolName }
    this._pendingRefresh = new Map(); // serverName -> timeout
  }

  async load(serverConfigs) {
    info('mcp', `load() ${serverConfigs.length} server(s): ${serverConfigs.map(c => `${c.name}:${c.type}${c.url ? `:${c.url}` : c.command ? `:${c.command}` : ''}`).join(', ')}`);
    for (const cfg of serverConfigs) {
      debug('mcp', `registering server "${cfg.name}" type=${cfg.type} ${cfg.type === 'http' ? `url=${cfg.url} headers=${cfg.headers ? Object.keys(cfg.headers).join(',') : 'none'}` : cfg.type === 'sse' ? `url=${cfg.url}` : `cmd=${cfg.command} args=${(cfg.args||[]).join(' ')}`}`);
      this.servers.set(cfg.name, {
        cfg,
        client: null,
        transport: null,
        tools: [],
        status: 'starting',
        error: null,
        stderr: '',
      });
      this._connect(cfg.name).catch(err => {
        logError('mcp', `connect failed for "${cfg.name}": ${err.message} ${err.stack ? '\n' + err.stack.split('\n').slice(1,3).join(' | ') : ''}`);
        const s = this.servers.get(cfg.name);
        if (!s) return;
        s.status = 'error';
        s.error = err.message;
        this._emit();
      });
    }
    this._emit();
    return [...this.servers.keys()];
  }

  async _refreshTools(serverName) {
    const s = this.servers.get(serverName);
    if (!s || !s.client) {
      warn('mcp', `_refreshTools(${serverName}) no client - skipping`);
      return;
    }
    const t0 = Date.now();
    debug('mcp', `_refreshTools(${serverName}) fetching listTools...`);
    try {
      const { tools } = await s.client.listTools();
      const dt = Date.now() - t0;
      const newNames = (tools || []).map(t => t.name);
      // remove old entries for this server
      let removed = 0;
      for (const [fullName, entry] of [...this.toolMap.entries()]) {
        if (entry.server === serverName) { this.toolMap.delete(fullName); removed++; }
      }
      s.tools = newNames;
      s.status = 'connected';
      s.error = null;
      for (const tool of tools || []) {
        let baseName = `${sanitizeName(serverName)}_${sanitizeName(tool.name)}`;
        let fullName = baseName;
        let suffix = 1;
        while (this.toolMap.has(fullName)) {
          fullName = `${baseName}_${suffix++}`;
        }
        this.toolMap.set(fullName, {
          server: serverName,
          toolName: tool.name,
          schema: tool.inputSchema,
          description: tool.description || '',
        });
      }
      this._emit();
      info('mcp', `${serverName} tools refreshed: ${newNames.length} tools in ${dt}ms (removed ${removed}, added ${newNames.length}) -> [${newNames.join(', ').slice(0, 300)}] total toolMap=${this.toolMap.size}`);
      if (newNames.length) debug('mcp', `${serverName} tool details: ${tools.map(t => `${t.name}:${(t.description||'').slice(0,60)}`).join(' | ').slice(0, 500)}`);
    } catch (err) {
      logError('mcp', `failed to refresh tools for ${serverName} after ${Date.now()-t0}ms: ${err.message}`);
      // don't mark as error if we already were connected - keep old tools usable
    }
  }

  async _connect(name) {
    const s = this.servers.get(name);
    if (!s) return;
    const cfg = s.cfg;
    const transportDesc = cfg.type === 'http' ? `http url=${cfg.url}` : cfg.type === 'sse' ? `sse url=${cfg.url}` : `stdio cmd=${cfg.command} args=${(cfg.args||[]).join(' ')}`;
    info('mcp', `_connect("${name}") type=${cfg.type} ${transportDesc}`);
    const tConnectStart = Date.now();
    const client = new Client(
      { name: 'nexus-ai', version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            // Auto-refresh when server advertises listChanged (preferred path for colab-mcp)
            onChanged: async (error, tools) => {
              if (error) {
                console.error(`[mcp] ${name} listChanged error:`, error.message);
                // fallback to manual refresh in case notifier failed
                this._refreshTools(name).catch(() => {});
                return;
              }
              if (Array.isArray(tools)) {
                // SDK already fetched new list; apply directly without extra round-trip
                try {
                  for (const [fullName, entry] of [...this.toolMap.entries()]) {
                    if (entry.server === name) this.toolMap.delete(fullName);
                  }
                  s.tools = tools.map(t => t.name);
                  for (const tool of tools) {
                    let baseName = `${sanitizeName(name)}_${sanitizeName(tool.name)}`;
                    let fullName = baseName;
                    let suffix = 1;
                    while (this.toolMap.has(fullName)) fullName = `${baseName}_${suffix++}`;
                    this.toolMap.set(fullName, {
                      server: name,
                      toolName: tool.name,
                      schema: tool.inputSchema,
                      description: tool.description || '',
                    });
                  }
                  this._emit();
                  console.log(`[mcp] ${name} listChanged -> ${tools.length} tools`);
                } catch (e) {
                  console.error(`[mcp] ${name} listChanged apply failed:`, e.message);
                }
              } else {
                // fallback: re-list
                this._refreshTools(name).catch(() => {});
              }
            },
            autoRefresh: true,
            debounceMs: 300,
          },
        },
      }
    );
    // Fallback for non-compliant servers that send tools/list_changed without
    // advertising the capability (some colab-mcp versions do this). The SDK's
    // listChanged handler is silently skipped if not advertised, so we install
    // a manual notification handler as well. If the SDK already registered one,
    // setNotificationHandler will throw "already set" - we catch and ignore.
    try {
      // eslint-disable-next-line global-require
      const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
      if (ToolListChangedNotificationSchema) {
        try {
          client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
            console.log(`[mcp] ${name} received tools/list_changed (fallback handler)`);
            // debounce via pendingRefresh so rapid notifications don't spam
            if (!this._pendingRefresh.has(name)) {
              const t = setTimeout(() => {
                this._pendingRefresh.delete(name);
                this._refreshTools(name).catch(() => {});
              }, 400);
              if (t.unref) t.unref();
              this._pendingRefresh.set(name, t);
            }
          });
        } catch (e) {
          // handler already set by listChanged - that's fine, listChanged will handle it
          if (!String(e.message || '').includes('already set')) throw e;
        }
      }
    } catch { /* fallback registration failed - listChanged config is enough for compliant servers */ }

    // Build OAuth provider if server declares oauth (e.g. cloudflare remotes) or has saved tokens
    // Always create provider for http servers that have oauth flag, and also for any http that has saved credentials
    let authProvider = null;
    const needsOAuth = s.cfg.oauth !== undefined;
    if (s.cfg.type === 'http' || s.cfg.type === 'sse') {
      try {
        const { FileOAuthProvider } = require('./mcp-oauth');
        const { loadAllCredentials } = require('./mcp-oauth');
        const allCreds = loadAllCredentials();
        const hasSavedTokens = !!(allCreds[name] && allCreds[name].tokens && allCreds[name].tokens.access_token);
        // Create provider ONLY if we have valid access tokens for silent refresh.
        // If only clientInformation exists but no tokens, we still want manual button, not auto-open.
        // This prevents "automatically opens all of them" as user requested - one-by-one via Authorize buttons only.
        const shouldProvide = hasSavedTokens;
        if (shouldProvide) {
          // Use shared fixed port for all providers so the single persistent callback server can handle them
          const redirectUrl = `http://localhost:34115/callback`;
          authProvider = new FileOAuthProvider({ serverName: name, serverUrl: s.cfg.url || 'http://localhost', redirectUrl });
          info('mcp', `"${name}" using OAuth provider (saved tokens) redirect=${redirectUrl} hasSavedTokens=${hasSavedTokens} needsOAuth=${needsOAuth}`);
        } else {
          debug('mcp', `"${name}" no OAuth provider for initial connect (needsOAuth=${needsOAuth} hasSavedTokens=${hasSavedTokens}) - will show Authorize button if needed`);
        }
      } catch (e) {
        warn('mcp', `"${name}" failed to create OAuth provider: ${e.message}`);
      }
    }

    let transport;
    if (s.cfg.type === 'http') {
      const url = new URL(s.cfg.url);
      const headers = s.cfg.headers || {};
      debug('mcp', `"${name}" creating StreamableHTTP transport url=${cfg.url} headers=${headers ? Object.keys(headers).join(',') : 'none'} oauth=${!!authProvider}`);
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
        authProvider: authProvider || undefined,
      });
    } else if (s.cfg.type === 'sse') {
      const url = new URL(s.cfg.url);
      const headers = s.cfg.headers || {};
      debug('mcp', `"${name}" creating SSE transport url=${cfg.url} oauth=${!!authProvider}`);
      transport = new SSEClientTransport(url, {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
        authProvider: authProvider || undefined,
      });
    } else {
      debug('mcp', `"${name}" creating Stdio transport command=${cfg.command} args=${JSON.stringify(cfg.args)} cwd=${cfg.cwd || process.cwd()}`);
      transport = new StdioClientTransport({
        command: s.cfg.command,
        args: s.cfg.args,
        env: s.cfg.env ? { ...process.env, ...s.cfg.env } : undefined,
        cwd: s.cfg.cwd || process.cwd(),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => {
        try {
          const txt = chunk.toString();
          s.stderr = (s.stderr + txt).slice(-3000);
          debug('mcp', `"${name}" stderr: ${txt.slice(0, 200).replace(/\n/g,' | ')}`);
        } catch { /* ignore */ }
      });
      transport.onerror = (err) => {
        logError('mcp', `"${name}" transport error: ${err?.message || String(err)}`);
        s.stderr = (s.stderr + '\n[transport error] ' + (err?.message || String(err))).slice(-3000);
      };
    }
    s.transport = transport;
    s.client = client;
    if (s.cfg.type !== 'local' && s.cfg.type !== undefined) {
      transport.onerror = transport.onerror || ((err) => {
        logError('mcp', `"${name}" remote transport error: ${err?.message || String(err)}`);
        s.stderr = (s.stderr + '\n[transport error] ' + (err?.message || String(err))).slice(-3000);
      });
    }
    transport.onclose = () => {
      warn('mcp', `"${name}" transport closed`);
    };

    debug('mcp', `"${name}" connecting (timeout ${CONNECT_TIMEOUT_MS}ms)...`);
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out connecting to ${name} after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)),
      ]);
    } catch (err) {
      const isAuthError = err && (err.name === 'UnauthorizedError' || /unauthorized|401|oauth|auth/i.test(err.message) || err.message.includes('POSTing to endpoint'));
      // For OAuth servers, the SDK throws "POSTing to endpoint" when 401 - treat as needs_auth
      if ((isAuthError || needsOAuth) && s.cfg.type === 'http') {
        // Check if it's really auth vs network error: try to distinguish by checking saved tokens
        const hasSavedTokens = (() => { try { const { loadAllCredentials } = require('./mcp-oauth'); const c = loadAllCredentials(); return !!c[name]?.tokens; } catch { return false; }})();
        if (needsOAuth && !hasSavedTokens) {
          warn('mcp', `"${name}" connect requires OAuth (no tokens) - marking needs_auth`);
          s.status = 'needs_auth';
          s.error = 'OAuth required - click Authorize in MCP panel';
          s.client = client;
          s.transport = transport;
          this._emit();
          info('mcp', `"${name}" awaiting OAuth authorization`);
          return;
        }
        if (isAuthError) {
          warn('mcp', `"${name}" auth error, checking credentials: ${err.message.slice(0,200)}`);
          // If we had tokens but they expired, mark needs_auth for re-auth
          if (hasSavedTokens) {
            warn('mcp', `"${name}" had tokens but still unauthorized - may need re-auth`);
            s.status = 'needs_auth';
            s.error = `OAuth token expired or invalid: ${err.message.slice(0,100)} - re-authorize`;
            s.client = client;
            s.transport = transport;
            this._emit();
            return;
          }
        }
      }
      throw err;
    }
    const caps = client.getServerCapabilities();
    info('mcp', `"${name}" connected in ${Date.now()-tConnectStart}ms caps=${JSON.stringify(caps||{}).slice(0,300)} serverVersion=${JSON.stringify(client.getServerVersion()||{}).slice(0,200)}`);
    debug('mcp', `"${name}" server instructions: ${(client.getInstructions()||'').slice(0,300)}`);
    // initial population - use shared refresh path to ensure consistent mapping
    await this._refreshTools(name);
    info('mcp', `"${name}" initial connect complete total toolMap=${this.toolMap.size}`);
  }

  getServersNeedingOAuth() {
    const out = [];
    for (const [name, s] of this.servers) {
      const hasOAuthFlag = s.cfg.oauth !== undefined;
      const isAuthError = /oauth|unauthorized|401|auth|POSTing to endpoint/i.test(s.error||'');
      if (s.status === 'needs_auth') {
        out.push({ name, url: s.cfg.url, status: s.status, error: s.error, hasOAuth: hasOAuthFlag });
      } else if (hasOAuthFlag && s.status === 'error' && isAuthError) {
        out.push({ name, url: s.cfg.url, status: s.status, error: s.error, hasOAuth: true });
      } else if (s.cfg.type === 'http' && s.status === 'error' && isAuthError && hasOAuthFlag) {
        out.push({ name, url: s.cfg.url, status: s.status, error: s.error, hasOAuth: hasOAuthFlag });
      }
    }
    return out;
  }

  async authorizeServer(name) {
    const s = this.servers.get(name);
    if (!s) throw new Error(`Unknown server ${name}`);
    if (s.cfg.type !== 'http' && s.cfg.type !== 'sse') throw new Error(`Server ${name} is not a remote HTTP server`);
    info('mcp', `authorizeServer "${name}" url=${s.cfg.url}`);
    const { performOAuthFlow } = require('./mcp-oauth');
    // Clean up old connection if any
    try { await s.client?.close(); } catch {}
    try { await s.transport?.close(); } catch {}
    s.status = 'starting';
    s.error = null;
    this._emit();
    const result = await performOAuthFlow(name, s.cfg.url);
    if (!result.success) throw new Error(result.error || 'OAuth failed');
    info('mcp', `authorizeServer "${name}" OAuth success, reconnecting...`);
    await this._connect(name);
    return this.getServerStatus().find(x=>x.name===name);
  }

  getServerStatus() {
    const out = [];
    for (const [name, s] of this.servers) {
      const needsOAuth = s.cfg.oauth !== undefined;
      out.push({
        name,
        status: s.status,
        error: s.error,
        tools: s.tools,
        stderr: s.stderr.slice(-800),
        url: s.cfg.url || null,
        type: s.cfg.type,
        needsOAuth,
        canAuthorize: s.status === 'needs_auth' || (needsOAuth && s.status === 'error'),
      });
    }
    return out;
  }

  getToolsForModel() {
    const tools = [];
    for (const [fullName, entry] of this.toolMap) {
      const s = this.servers.get(entry.server);
      if (!s || s.status !== 'connected') continue;
      const baseDesc = entry.description?.trim() || `Tool "${entry.toolName}"`;
      tools.push({
        type: 'function',
        function: {
          name: fullName,
          description: `${baseDesc} [via MCP server "${entry.server}"]`,
          parameters: entry.schema || { type: 'object', properties: {} },
        },
      });
    }
    return tools;
  }

  async callTool(fullName, args) {
    const t0 = Date.now();
    const entry = this.toolMap.get(fullName);
    if (!entry) {
      logError('mcp', `callTool unknown tool "${fullName}" available=${[...this.toolMap.keys()].slice(0,10).join(',')}`);
      throw new Error(`Unknown tool: ${fullName}`);
    }
    const s = this.servers.get(entry.server);
    if (!s || !s.client) throw new Error(`MCP server ${entry.server} not available`);
    if (s.status !== 'connected') throw new Error(`MCP server ${entry.server} is ${s.status}: ${s.error || 'not ready'}`);
    info('mcp', `callTool "${fullName}" -> ${entry.server}:${entry.toolName} args=${JSON.stringify(args||{}).slice(0,500)}`);
    debug('mcp', `callTool "${fullName}" server="${entry.server}" tool="${entry.toolName}" pendingRefresh=${this._pendingRefresh.has(entry.server)}`);

    let timeoutId;
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error(`Tool ${fullName} timed out after ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS);
    });
    let result;
    try {
      result = await Promise.race([
        s.client.callTool({ name: entry.toolName, arguments: args || {} }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const dt = Date.now() - t0;
    info('mcp', `callTool "${fullName}" done in ${dt}ms isError=${!!result?.isError} contentParts=${result?.content?.length||0} hasImages=${(result?.content||[]).some(p=>p.type==='image')}`);
    if (result?.isError) warn('mcp', `callTool "${fullName}" isError content=${JSON.stringify(result.content).slice(0,500)}`);
    debug('mcp', `callTool "${fullName}" raw result meta=${JSON.stringify(result?._meta||{}).slice(0,300)}`);
    let text = '';
    let images = [];
    for (const part of result?.content || []) {
      if (part.type === 'text') text += part.text;
      else if (part.type === 'image') {
        if (part.data) images.push(`data:${part.mimeType || 'image/png'};base64,${part.data}`);
      }
      else if (part.type === 'resource' && part.resource?.blob) {
        images.push(`data:${part.resource.mimeType || 'application/octet-stream'};base64,${part.resource.blob}`);
      } else {
        debug('mcp', `callTool "${fullName}" unknown content part type=${part.type} ${JSON.stringify(part).slice(0,300)}`);
      }
    }
    if (result?.isError && !text) text = 'Tool returned an error.';
    debug('mcp', `callTool "${fullName}" text len=${text.length} images=${images.length} textPreview=${text.slice(0,200).replace(/\n/g,' | ')}`);

    // Schedule a background refresh of the tool list for this server.
    // Colab-mcp (and similar) dynamically exposes new tools after a connect/browser
    // tool is invoked - without this, getToolsForModel() stays stale at 1 tool.
    // For servers that currently expose very few tools (colab starts at 1), we
    // do a synchronous refresh so the *next* model turn in the same chat loop
    // already sees the newly-added tools. For larger toolsets we debounce.
    const serverName = entry.server;
    const prevCount = s.tools.length;
    if (prevCount <= 3) {
      try { await this._refreshTools(serverName); } catch {}
    } else {
      if (!this._pendingRefresh.has(serverName)) {
        const timer = setTimeout(() => {
          this._pendingRefresh.delete(serverName);
          this._refreshTools(serverName).catch(() => {});
        }, 900);
        if (timer.unref) timer.unref();
        this._pendingRefresh.set(serverName, timer);
      }
    }

    return { text: text.slice(0, 40000), images };
  }

  _emit() {
    if (this.onStatus) {
      try { this.onStatus(this.getServerStatus()); } catch { /* ignore */ }
    }
  }

  async shutdown() {
    for (const timer of this._pendingRefresh.values()) clearTimeout(timer);
    this._pendingRefresh.clear();
    for (const [name, s] of this.servers) {
      try {
        await s.client?.close();
        await s.transport?.close();
      } catch { /* ignore */ }
    }
    this.servers.clear();
    this.toolMap.clear();
  }
}

module.exports = { McpManager };
