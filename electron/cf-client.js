'use strict';

const { getConfig } = require('./config');
const { debug, info, warn, error: logError } = require('./logger');

const BASE = 'https://api.cloudflare.com/client/v4';

function authHeaders() {
  const { token } = getConfig();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function request(path, { method = 'POST', body, headers = {}, timeoutMs = 300000, signal: outerSignal } = {}) {
  const t0 = Date.now();
  const bodyPreview = body !== undefined ? (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 500)) : 'none';
  debug('cf', `→ ${method} ${path} timeout=${timeoutMs} bodyPreview=${bodyPreview.replace(/\n/g,' ')}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const onOuterAbort = () => controller.abort(outerSignal.reason || new DOMException('Aborted', 'AbortError'));
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...authHeaders(), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    const dt = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        message = (j.errors && j.errors[0] && j.errors[0].message) || j.result?.error || message;
        if (j.errors && j.errors[0] && j.errors[0].code) message += ` (code ${j.errors[0].code})`;
      } catch { /* keep http status */ }
      logError('cf', `✕ ${method} ${path} ${res.status} in ${dt}ms: ${message} body=${text.slice(0,400).replace(/\n/g,' ')}`);
      const err = new Error(message);
      err.status = res.status;
      err.body = text.slice(0, 2000);
      throw err;
    }
    info('cf', `✓ ${method} ${path} ${res.status} in ${dt}ms content-type=${res.headers.get('content-type')||'?'}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      warn('cf', `↯ ${method} ${path} aborted/timeout after ${Date.now()-t0}ms: ${err.message}`);
    } else if (!err.status) {
      logError('cf', `↯ ${method} ${path} network error after ${Date.now()-t0}ms: ${err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Stream a chat completion (OpenAI-compatible /ai/run format).
 * Calls onEvent with { type: 'text'|'reasoning'|'tool_call', ... } as deltas arrive.
 */
async function streamChat({ model, messages, tools, temperature, maxTokens, reasoningEffort, onEvent, signal }) {
  const { accountId } = getConfig();
  const tStart = Date.now();
  const payload = {
    model,
    messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools && tools.length) payload.tools = tools;
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  info('cf', `streamChat model=${model} msgs=${messages.length} tools=${tools?tools.length:0} temp=${temperature} maxTokens=${maxTokens} reasoning=${reasoningEffort||'default'} signalAborted=${!!signal?.aborted}`);
  debug('cf', `streamChat payload messages preview: ${JSON.stringify(messages).slice(0,800).replace(/\n/g,' ')} tools=${tools ? tools.map(t=>t.function.name).join(',').slice(0,300) : 'none'}`);

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const res = await request(`/accounts/${accountId}/ai/run/${model}`, {
    body: payload,
    signal: controller.signal,
    timeoutMs: 300000,
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let done = false;
  let chunkCount = 0;
  let textTotal = 0;
  let reasoningTotal = 0;
  let toolCallCount = 0;

  try {
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (!line.startsWith('data:')) {
          debug('cf', `stream line ignored: ${line.slice(0,150)}`);
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          done = true;
          debug('cf', `stream [DONE] after ${chunkCount} chunks`);
          continue;
        }
        let json;
        try { json = JSON.parse(data); } catch (e) {
          warn('cf', `stream JSON parse fail: ${data.slice(0,200)} err=${e.message}`);
          continue;
        }
        if (json.usage) {
          usage = json.usage;
          info('cf', `stream usage: ${JSON.stringify(usage)}`);
        }
        const choice = json.choices && json.choices[0];
        if (!choice) {
          debug('cf', `stream no choice: ${JSON.stringify(json).slice(0,300)}`);
          continue;
        }
        if (choice.finish_reason) {
          done = true;
          info('cf', `stream finish_reason=${choice.finish_reason} after ${chunkCount} chunks text=${textTotal} reasoning=${reasoningTotal} toolCalls=${toolCallCount}`);
        }
        const msg = choice.message || choice.delta || {};
        if (typeof msg.content === 'string' && msg.content) {
          textTotal += msg.content.length;
          onEvent({ type: 'text', text: msg.content });
        }
        if (typeof msg.reasoning === 'string' && msg.reasoning) {
          reasoningTotal += msg.reasoning.length;
          onEvent({ type: 'reasoning', text: msg.reasoning });
        }
        if (msg.tool_calls) {
          toolCallCount += msg.tool_calls.length;
          for (const tc of msg.tool_calls) {
            debug('cf', `stream tool_call idx=${tc.index} id=${tc.id} name=${tc.function?.name} argsPreview=${(tc.function?.arguments||'').slice(0,150)}`);
            onEvent({
              type: 'tool_call',
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments || '',
              parallel_tool_calls: json.parallel_tool_calls,
            });
          }
        }
      }
    }
    info('cf', `streamChat done=${done} usage=${JSON.stringify(usage)} chunks=${chunkCount} textLen=${textTotal} reasoningLen=${reasoningTotal} toolCalls=${toolCallCount} duration=${Date.now()-tStart}ms`);
  } catch (err) {
    logError('cf', `streamChat error after ${Date.now()-tStart}ms chunks=${chunkCount}: ${err.message}`);
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) controller.abort();
  }

  return { done, usage };
}

async function generateImage({ prompt, model, size, steps }) {
  const t0 = Date.now();
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) throw new Error('generateImage requires a non-empty prompt');
  if (prompt.length > 4000) throw new Error('Prompt too long (max 4000 chars)');
  const { accountId } = getConfig();
  const mdl = model || getConfig().imageModel;
  info('cf', `generateImage model=${mdl} size=${size||'default'} promptLen=${prompt.length} promptPreview=${prompt.slice(0,80).replace(/\n/g,' ')}`);
  const buildBody = (withSize) => {
    const body = { prompt: prompt.trim() };
    if (withSize && size) body.size = size;
    if (steps) body.steps = steps;
    return body;
  };
  const url = `/accounts/${accountId}/ai/run/${mdl}`;
  let res;
  try {
    res = await request(url, { body: buildBody(true) });
  } catch (err) {
    const isSizeError = size && (err.status === 400 || /size/i.test(err.message));
    if (isSizeError) {
      warn('cf', `generateImage retry without size after error: ${err.message}`);
      res = await request(url, { body: buildBody(false) });
    } else {
      logError('cf', `generateImage failed: ${err.message}`);
      throw err;
    }
  }
  const contentType = res.headers.get('content-type') || '';
  debug('cf', `generateImage response content-type=${contentType} in ${Date.now()-t0}ms`);
  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (json.result && typeof json.result === 'string') {
      const b64 = json.result;
      const mime = b64.startsWith('/9j/') ? 'image/jpeg' : (b64.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg');
      info('cf', `generateImage JSON string result ${b64.length} chars mime=${mime} in ${Date.now()-t0}ms`);
      return `data:${mime};base64,${b64}`;
    }
    if (json.result && json.result.image) {
      const b64 = json.result.image;
      const mime = b64.startsWith('/9j/') ? 'image/jpeg' : (b64.startsWith('iVBORw0KGgo') ? 'image/png' : 'image/jpeg');
      info('cf', `generateImage JSON image result ${b64.length} chars mime=${mime} in ${Date.now()-t0}ms`);
      return `data:${mime};base64,${b64}`;
    }
    logError('cf', `generateImage unexpected JSON: ${JSON.stringify(json).slice(0,500)}`);
    throw new Error('Unexpected JSON response from image model: ' + JSON.stringify(json).slice(0, 300));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = contentType.split(';')[0] || 'image/png';
  info('cf', `generateImage binary ${buf.length} bytes mime=${mime} in ${Date.now()-t0}ms`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function transcribeAudio({ audioBase64, mime }) {
  const t0 = Date.now();
  if (!audioBase64 || typeof audioBase64 !== 'string') throw new Error('transcribeAudio requires audioBase64');
  const approxBytes = Math.floor(audioBase64.length * 3 / 4);
  info('cf', `transcribeAudio mime=${mime||'?'} b64len=${audioBase64.length} approxBytes=${approxBytes}`);
  if (approxBytes > 12 * 1024 * 1024) throw new Error('Audio file too large for transcription (max 12 MB)');
  const { accountId } = getConfig();
  const body = { audio: audioBase64 };
  if (mime) body.mime = mime;
  const res = await request(`/accounts/${accountId}/ai/run/@cf/openai/whisper`, {
    body,
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  const text = json.result?.text || json.result?.response || json.result?.vtt || '';
  if (!text) {
    logError('cf', `transcribeAudio empty result ${JSON.stringify(json).slice(0,400)}`);
    throw new Error('Whisper returned no transcription.');
  }
  info('cf', `transcribeAudio done in ${Date.now()-t0}ms textLen=${text.length} preview=${text.slice(0,80).replace(/\n/g,' ')}`);
  return text;
}

async function listTextModels() {
  const t0 = Date.now();
  const { accountId } = getConfig();
  debug('cf', `listTextModels account=${accountId.slice(0,8)}...`);
  const res = await request(`/accounts/${accountId}/ai/models/search?task=Text%20Generation&per_page=100`, { method: 'GET' });
  const json = await res.json();
  const models = (json.result || [])
    .map(m => ({ id: m.name, description: m.description }))
    .filter(m => m.id.startsWith('@cf/'));
  info('cf', `listTextModels found ${models.length} @cf models in ${Date.now()-t0}ms`);
  debug('cf', `listTextModels ids: ${models.map(m=>m.id).join(',').slice(0,400)}`);
  return models;
}

module.exports = { streamChat, generateImage, transcribeAudio, listTextModels };
