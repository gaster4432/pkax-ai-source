import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  conversations: [],
  currentId: null,
  messages: [],
  settings: null,
  mcpStatus: [],
  models: [],
  generating: false,
  streamingMsg: null, // { element, textEl, reasonEl, text, reasoning, toolCards }
  pendingFiles: [],    // processed attachments awaiting send
  approvalPending: null,
  mods: [],
  modsDir: 'mods/',
};

// ---------------------------------------------------------------- utils

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function extOf(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function scrollToBottom() {
  const sc = $('#chat-scroll');
  requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
}

// ---------------------------------------------------------------- markdown

marked.use({ breaks: true, gfm: true });

function renderMarkdown(src) {
  // cap markdown input to avoid giant parses eating the UI thread
  const capped = (src || '').slice(0, 200000);
  const raw = marked.parse(capped, { async: false });
  const clean = DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|data:image\/)/,
    // forbid inline event handlers even if purifier misses
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });
  const wrap = document.createElement('div');
  wrap.innerHTML = clean;
  // external links
  wrap.querySelectorAll('a').forEach(a => {
    if (/^https?:/.test(a.getAttribute('href') || '')) {
      a.target = '_blank';
      a.rel = 'noopener';
      a.addEventListener('click', e => {
        e.preventDefault();
        window.api.openExternal(a.href);
      });
    }
  });
  // code blocks - limit work on huge blocks to keep UI responsive
  wrap.querySelectorAll('pre code').forEach(block => {
    const text = block.textContent;
    if (text.length > 50000) {
      block.textContent = text.slice(0, 50000) + '\n/* truncated for performance */';
      block.classList.add('hljs');
      return;
    }
    const cls = block.className.match(/language-(\S+)/);
    const lang = cls ? cls[1] : '';
    try {
      if (lang && hljs.getLanguage(lang)) {
        block.innerHTML = hljs.highlight(text, { language: lang }).value;
      } else {
        block.innerHTML = hljs.highlightAuto(text, ['javascript','python','bash','json','lua','cpp','html','css']).value;
      }
    } catch {
      block.textContent = text;
    }
    block.classList.add('hljs');
    const pre = block.parentElement;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => copyText(block.textContent));
    pre.appendChild(btn);
  });
  return wrap;
}

// ---------------------------------------------------------------- message rendering

function renderMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-assistant');
  wrap.dataset.msgId = msg.id;

  if (msg.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = msg.content || '';
    if (msg.images?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      msg.images.forEach(src => imgs.appendChild(makeImg(src)));
      bubble.appendChild(imgs);
    }
    if (msg.attachments?.length) {
      bubble.appendChild(renderAttachChips(msg.attachments));
    }
    wrap.appendChild(bubble);
  } else {
    if (msg.reasoning && msg.reasoning.trim()) {
      wrap.appendChild(renderReasoning(msg.reasoning, msg.done));
    }
    const content = document.createElement('div');
    content.className = 'msg-content';
    if (msg.content && msg.content.trim()) {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      const md = document.createElement('div');
      md.className = 'markdown';
      md.appendChild(renderMarkdown(msg.content));
      bubble.appendChild(md);
      content.appendChild(bubble);
    }
    if (msg.images?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      msg.images.forEach(src => imgs.appendChild(makeImg(src)));
      content.appendChild(imgs);
    }
    if (msg.toolImages?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      msg.toolImages.forEach(src => imgs.appendChild(makeImg(src)));
      content.appendChild(imgs);
    }
    if (msg.tools) {
      for (const t of msg.tools) content.appendChild(renderToolCard(t));
    }
    if (msg.content || msg.images?.length || msg.tools?.length) wrap.appendChild(content);

    if (msg.done) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.className = 'msg-action';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyText(msg.content || ''));
      const save = document.createElement('button');
      save.className = 'msg-action';
      save.textContent = 'Save images';
      save.addEventListener('click', () => {
        const imgs = (msg.images || []).concat(msg.toolImages || []);
        imgs.forEach((src, i) => window.api.saveImage(src, `image-${Date.now()}-${i}.png`));
      });
      actions.append(copy, save);
      wrap.appendChild(actions);
    }
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  if (msg.role === 'user') {
    meta.textContent = 'You';
  } else {
    meta.textContent = 'Qwen ' + (msg.model ? msg.model.split('/').pop() : '');
    if (msg.usage?.completion_tokens) {
      const usage = document.createElement('span');
      usage.textContent = `${msg.usage.completion_tokens} tokens`;
      meta.appendChild(usage);
    }
  }
  wrap.appendChild(meta);
  return wrap;
}

function renderReasoning(text, done) {
  const det = document.createElement('details');
  det.className = 'reasoning';
  if (done) det.open = false;
  const sum = document.createElement('summary');
  sum.textContent = 'Thinking';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  body.textContent = text;
  det.appendChild(sum);
  det.appendChild(body);
  return det;
}

function renderAttachChips(attachments) {
  const row = document.createElement('div');
  row.className = 'attachments';
  for (const a of attachments) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    const ico = document.createElement('span');
    ico.className = 'chip-ico';
    ico.textContent = a.inline ? '📄' : '📎';
    const label = document.createElement('span');
    label.textContent = `${a.name}${a.size ? ' · ' + fmtBytes(a.size) : ''}`;
    chip.append(ico, label);
    row.appendChild(chip);
  }
  return row;
}

function makeImg(src, extraClass) {
  const img = document.createElement('img');
  img.src = src;
  img.className = extraClass || '';
  img.addEventListener('click', () => openLightbox(src));
  return img;
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

function renderToolCard(t) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.tool = t.name;
  const head = document.createElement('div');
  head.className = 'tool-card-head';
  const ico = document.createElement('span');
  ico.className = 'tool-ico';
  ico.textContent = t.name.startsWith('web_search') ? '🔎' : t.name.startsWith('generate_image') ? '🎨' : '⚙️';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = t.name;
  const stateEl = document.createElement('span');
  stateEl.className = 'tool-state';
  stateEl.textContent = t.status === 'done' ? '✓ done' : t.status === 'error' ? '✕ failed' : 'running…';
  if (t.status === 'running' || !t.status) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    stateEl.prepend(sp);
  }
  head.append(ico, name, stateEl);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'tool-card-body';
  if (t.args && Object.keys(t.args).length) {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(t.args, null, 2).slice(0, 1200);
    body.appendChild(pre);
  }
  if (t.result && t.result.trim()) {
    const pre = document.createElement('pre');
    pre.textContent = t.result.slice(0, 3000);
    body.appendChild(pre);
  }
  if (t.error) {
    const pre = document.createElement('pre');
    pre.style.color = 'var(--red)';
    pre.textContent = t.error;
    body.appendChild(pre);
  }
  card.appendChild(body);

  if (t.images?.length) {
    const row = document.createElement('div');
    row.className = 'tool-img-row';
    t.images.forEach(src => row.appendChild(makeImg(src)));
    card.appendChild(row);
  }
  return card;
}

// ---------------------------------------------------------------- conversations

async function loadConversation(id) {
  const conv = await window.api.getConversation(id);
  if (!conv) return;
  state.messages = conv.messages || [];
  state.currentId = id;
  renderMessages();
  const active = conv.messages.findLast(m => m.role === 'user')?.content || 'New chat';
  $('#chat-title').textContent = (active || 'New chat').replace(/\s+/g, ' ').slice(0, 60);
  renderConvList();
}

function renderConvList() {
  const list = $('#conv-list');
  list.innerHTML = '';
  for (const c of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = c.title;
    title.addEventListener('click', () => loadConversation(c.id));
    const del = document.createElement('button');
    del.className = 'conv-del';
    del.textContent = '✕';
    del.title = 'Delete conversation';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.deleteConversation(c.id);
      if (c.id === state.currentId) {
        state.currentId = null;
        state.messages = [];
        renderMessages();
        $('#chat-title').textContent = 'New chat';
      }
    });
    item.append(title, del);
    list.appendChild(item);
  }
}

function renderMessages() {
  const body = $('#chat-body');
  body.innerHTML = '';
  const empty = $('#chat-empty');
  if (!state.messages.length) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const m of state.messages) body.appendChild(renderMessage(m));
  }
  scrollToBottom();
}

async function newChat() {
  const conv = await window.api.createConversation();
  state.currentId = conv.id;
  state.messages = [];
  renderMessages();
  renderConvList();
  $('#chat-title').textContent = 'New chat';
  $('#input').focus();
}

// ---------------------------------------------------------------- attachments

function chipFor(att) {
  const chip = document.createElement('span');
  chip.className = 'attach-chip';
  const ico = document.createElement('span');
  ico.className = 'chip-ico';
  ico.textContent = att.kind === 'image' ? '🖼' : att.kind === 'audio' ? '🎵' : att.kind === 'pdf' ? '📕' : att.kind === 'text' ? '📄' : '📎';
  const label = document.createElement('span');
  label.textContent = `${att.name} · ${fmtBytes(att.size || 0)}`;
  const x = document.createElement('button');
  x.className = 'chip-x';
  x.textContent = '✕';
  x.title = 'Remove';
  x.addEventListener('click', () => {
    const i = state.pendingFiles.indexOf(att);
    if (i > -1) state.pendingFiles.splice(i, 1);
    renderPendingFiles();
  });
  chip.append(ico, label, x);
  return chip;
}

function renderPendingFiles() {
  const row = $('#attach-row');
  row.innerHTML = '';
  for (const att of state.pendingFiles) row.appendChild(chipFor(att));
  row.classList.toggle('hidden', !state.pendingFiles.length);
}

async function addFiles(paths) {
  for (const p of paths) {
    const res = await window.api.readFile(p);
    if (!res.ok) {
      toast(`Failed to read ${res.name || 'file'}: ${res.error}`, true);
      continue;
    }
    const proc = await window.api.processFile({ name: res.name, dataBase64: res.dataBase64 });
    if (!proc.ok) {
      toast(`Failed to process ${res.name}: ${proc.error}`, true);
      continue;
    }
    state.pendingFiles.push(proc);
  }
  renderPendingFiles();
}

// ---------------------------------------------------------------- chat send

function buildSendPayload() {
  const text = $('#input').value.trim();
  const images = [];
  const attachments = [];
  const audioBlocks = [];
  for (const att of state.pendingFiles) {
    if (att.kind === 'image') images.push(att.image);
    else if (att.kind === 'audio') audioBlocks.push({ dataBase64: att.audio, mime: 'audio/' + (extOf(att.name) === 'mp3' ? 'mpeg' : extOf(att.name)), name: att.name });
    else if (att.kind === 'text') attachments.push({ name: att.name, size: att.size, type: att.type, inline: att.inline });
    else if (att.kind === 'pdf') attachments.push({ name: att.name, size: att.size, type: 'application/pdf' });
    else attachments.push({ name: att.name, size: att.size, type: att.type });
  }
  return { text, images, attachments, audioBlocks };
}

let sendInFlight = false;

async function send() {
  if (sendInFlight) return;
  const payload = buildSendPayload();
  if (!payload.text && !payload.images.length && !payload.attachments.length && !payload.audioBlocks.length) return;

  // transcribe audio first
  for (const a of payload.audioBlocks) {
    const res = await window.api.transcribeAudio(a);
    if (res.ok) payload.text += (payload.text ? '\n' : '') + `[Transcription of ${a.name}]\n${res.text}`;
    else toast(`Audio transcription failed for ${a.name}: ${res.error}`, true);
  }

  sendInFlight = true;
  $('#input').value = '';
  autoResize();
  state.pendingFiles = [];
  renderPendingFiles();
  setSendingUI(true);

  const textForTitle = payload.text || 'Attached file';
  // Only try to rename if we already have a conversation (not auto-creating)
  if (state.messages.length === 0 && state.currentId) {
    try { await window.api.renameConversation(state.currentId, textForTitle.slice(0, 60)); } catch {}
  }
  const res = await window.api.sendMessage({
    convId: state.currentId,
    text: payload.text,
    images: payload.images,
    attachments: payload.attachments,
  });
  // Handle auto-created conversation (ChatGPT-like: type with no active chat -> new chat)
  if (res && res.convId && res.convId !== state.currentId) {
    const wasAutoCreated = !!res.autoCreated;
    state.currentId = res.convId;
    // If backend auto-created, ensure UI switches to it immediately for correct delta routing
    try {
      const conv = await window.api.getConversation(res.convId);
      if (conv) {
        state.messages = conv.messages || [];
        renderMessages();
        $('#chat-title').textContent = (conv.title || textForTitle).slice(0, 60);
        renderConvList();
      }
    } catch {}
    if (wasAutoCreated) {
      // Also ensure the conversation list is refreshed
      try {
        const info = await window.api.init();
        state.conversations = info.conversations || state.conversations;
        renderConvList();
      } catch {}
    }
  }
  if (res?.error) toast(res.error, true);
  setSendingUI(false);
  sendInFlight = false;
}

function setSendingUI(gen) {
  state.generating = gen;
  $('#btn-send').classList.toggle('hidden', gen);
  $('#btn-stop').classList.toggle('hidden', !gen);
}

// ---------------------------------------------------------------- streaming UI

function ensureStreamingMessage(convId, msgId) {
  const existing = $$('.msg').find(el => el.dataset.msgId === msgId);
  if (existing) return existing;
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant streaming';
  wrap.dataset.msgId = msgId;
  const content = document.createElement('div');
  content.className = 'msg-content';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const md = document.createElement('div');
  md.className = 'markdown streaming-cursor';
  bubble.appendChild(md);
  content.appendChild(bubble);
  wrap.appendChild(content);
  $('#chat-body').appendChild(wrap);
  $('#chat-empty').classList.add('hidden');
  scrollToBottom();
  return wrap;
}

let pendingDelta = null;
let pendingReasoning = null;

function applyDeltas() {
  const wrap = pendingDelta;
  pendingDelta = null;
  if (!wrap) return;
  const md = wrap.querySelector('.markdown');
  md.innerHTML = '';
  md.appendChild(renderMarkdown(wrap.dataset.text || ''));
  if (!(wrap.dataset.text || '').trim()) md.classList.add('streaming-cursor');
  scrollToBottom();
}

function applyReasoningDeltas() {
  const wrap = pendingReasoning;
  pendingReasoning = null;
  if (!wrap) return;
  let det = wrap.querySelector('.reasoning');
  if (!det) {
    det = document.createElement('details');
    det.className = 'reasoning';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'Thinking';
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    det.appendChild(sum);
    det.appendChild(body);
    wrap.insertBefore(det, wrap.firstChild);
  }
  det.querySelector('.reasoning-body').textContent = wrap.dataset.reasoning || '';
  scrollToBottom();
}

window.api.on('chat:delta', ({ convId, msgId, kind, text }) => {
  if (convId !== state.currentId) return;
  const wrap = ensureStreamingMessage(convId, msgId);
  if (kind === 'text') {
    wrap.dataset.text = (wrap.dataset.text || '') + text;
    if (!pendingDelta) requestAnimationFrame(applyDeltas);
    pendingDelta = wrap;
  } else if (kind === 'reasoning') {
    wrap.dataset.reasoning = (wrap.dataset.reasoning || '') + text;
    if (!pendingReasoning) requestAnimationFrame(applyReasoningDeltas);
    pendingReasoning = wrap;
  }
});

window.api.on('chat:tool', ({ convId, msgId, tool, args, status, result, images }) => {
  if (convId !== state.currentId) return;
  const wrap = ensureStreamingMessage(convId, msgId);
  let card = wrap.querySelector(`.tool-card[data-tool="${CSS.escape(tool)}"]`);
  if (!card) {
    card = renderToolCard({ name: tool, args, status });
    wrap.appendChild(card);
  } else {
    const stateEl = card.querySelector('.tool-state');
    const body = card.querySelector('.tool-card-body');
    if (status === 'done') {
      stateEl.innerHTML = '✓ done';
      body.innerHTML = '';
      if (result) {
        const pre = document.createElement('pre');
        pre.textContent = result.slice(0, 3000);
        body.appendChild(pre);
      }
    } else if (status === 'error') {
      stateEl.innerHTML = '✕ failed';
      body.innerHTML = '';
      const pre = document.createElement('pre');
      pre.style.color = 'var(--red)';
      pre.textContent = result || 'Tool call failed';
      body.appendChild(pre);
    }
  }
  if (status === 'done' && images?.length) {
    const row = document.createElement('div');
    row.className = 'tool-img-row';
    images.forEach(src => row.appendChild(makeImg(src)));
    card.appendChild(row);
  }
  scrollToBottom();
});

window.api.on('chat:approval', ({ convId, approvalId, tool, args }) => {
  if (convId !== state.currentId) return;
  state.approvalPending = approvalId;
  const bar = $('#approval-bar');
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'appr-title';
  title.textContent = '🔒 Tool requires approval: ' + tool;
  const argsPre = document.createElement('pre');
  argsPre.className = 'appr-args';
  argsPre.textContent = JSON.stringify(args, null, 2);
  const btns = document.createElement('div');
  btns.className = 'appr-btns';
  const allow = document.createElement('button');
  allow.className = 'btn-appr-allow';
  allow.textContent = 'Allow';
  allow.addEventListener('click', () => {
    window.api.approveTool(approvalId, true);
    bar.classList.add('hidden');
    state.approvalPending = null;
  });
  const deny = document.createElement('button');
  deny.className = 'btn-appr-deny';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => {
    window.api.approveTool(approvalId, false);
    bar.classList.add('hidden');
    state.approvalPending = null;
  });
  btns.append(allow, deny);
  bar.append(title, argsPre, btns);
});

window.api.on('chat:done', async ({ convId, msgId }) => {
  if (convId !== state.currentId) return;
  applyDeltas();
  applyReasoningDeltas();
  // re-render from persisted store
  const conv = await window.api.getConversation(convId);
  if (conv) {
    state.messages = conv.messages || [];
    renderMessages();
  }
  renderConvList();
});

window.api.on('conv:changed', ({ convId, list, autoCreated, oldId }) => {
  state.conversations = list;
  renderConvList();
  // Auto-switch to newly created conversation (ChatGPT-like: no need to press New Chat)
  if (autoCreated && convId) {
    if (!state.currentId || state.currentId === oldId || !state.conversations.some(c => c.id === state.currentId)) {
      state.currentId = convId;
      // Load the new conversation so the user's message appears immediately and deltas route correctly
      window.api.getConversation(convId).then(conv => {
        if (conv) {
          state.messages = conv.messages || [];
          renderMessages();
          $('#chat-title').textContent = (conv.title || '').slice(0, 60) || 'New chat';
          renderConvList();
        }
      }).catch(()=>{});
    }
  } else if (convId && state.currentId && !state.conversations.some(c => c.id === state.currentId)) {
    // Current was deleted/cleared, switch to most recent or the changed one
    const fallback = list[0]?.id || convId;
    if (fallback) {
      state.currentId = fallback;
      window.api.getConversation(fallback).then(conv => {
        if (conv) { state.messages = conv.messages || []; renderMessages(); $('#chat-title').textContent = (conv.title || '').slice(0,60); }
      }).catch(()=>{});
    }
  }
});

// ---------------------------------------------------------------- mcp status

function renderMcp() {
  const list = $('#mcp-list');
  list.innerHTML = '';
  let connected = 0;
  const allConnected = state.mcpStatus.length && state.mcpStatus.every(s => s.status === 'connected');
  $('#mcp-count').textContent = allConnected ? 'all' : `${state.mcpStatus.filter(s => s.status === 'connected').length}/${state.mcpStatus.length}`;
  for (const s of state.mcpStatus) {
    if (s.status === 'connected') connected++;
    const item = document.createElement('div');
    item.className = 'mcp-item';
    const dot = document.createElement('span');
    dot.className = 'mcp-dot ' + s.status;
    const name = document.createElement('span');
    name.className = 'mcp-name';
    name.textContent = s.name;
    item.append(dot, name);
    if (s.status === 'connected') {
      const tools = document.createElement('span');
      tools.className = 'mcp-tools';
      tools.textContent = s.tools.length + ' tools';
      item.appendChild(tools);
    } else if (s.status === 'error') {
      const err = document.createElement('span');
      err.className = 'mcp-err';
      err.textContent = s.error;
      err.title = s.stderr || s.error;
      item.appendChild(err);
    } else {
      const st = document.createElement('span');
      st.className = 'mcp-tools';
      st.textContent = s.status;
      item.appendChild(st);
    }
    list.appendChild(item);
  }
  $('#btn-mcp-retry').classList.toggle('hidden', !state.mcpStatus.some(s => s.status === 'error' || s.status === 'starting'));
}

window.api.on('mcp:status', (status) => {
  state.mcpStatus = status;
  renderMcp();
  refreshOAuthPanel();
});

let storeCache = { packages: [], mods: new Map(), installedIds: new Set(), thumbnails: new Map(), nextPackageIndex: 0 };

function escapeStoreText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function loadStoreThumbnail(storePath, mod) {
  if (!mod?.thumbnail || storeCache.thumbnails.has(storePath)) return storeCache.thumbnails.get(storePath);
  // Cache both successful and failed lookups for this session.
  const request = window.api.fetchModThumbnail(storePath, mod.thumbnail)
    .then(res => res.ok ? res.dataUrl : null)
    .catch(() => null);
  storeCache.thumbnails.set(storePath, request);
  return request;
}

function getInstalledTagsAndPerms() {
  const tags = new Set();
  const perms = new Set();
  for (const m of state.mods || []) {
    if (m.tags) m.tags.forEach(t => tags.add(t));
    if (m.permissions) m.permissions.forEach(p => perms.add(p));
    // also from registry if we have it cached
    const cached = storeCache.mods.get(m.id);
    if (cached && cached.tags) cached.tags.forEach(t => tags.add(t));
    if (cached && cached.permissions) cached.permissions.forEach(p => perms.add(p));
  }
  return { tags: [...tags], perms: [...perms] };
}

function scoreModForRecommendations(mod, installed) {
  let score = 0;
  const mTags = new Set(mod.tags || []);
  const mPerms = new Set(mod.permissions || []);
  for (const t of installed.tags) if (mTags.has(t)) score += 2;
  for (const p of installed.perms) if (mPerms.has(p)) score += 1;
  // Boost if mod is not installed yet
  if (!installed.installedIds.has(mod.id)) score += 0.5;
  else score = -1; // already installed, don't recommend
  return score;
}

// ---------------------------------------------------------------- oauth (standalone, no OpenCode)

async function refreshOAuthPanel() {
  try {
    const res = await window.api.getOAuthServers();
    const needing = Array.isArray(res) ? res : [];
    // also check mcpStatus for needsOAuth flag directly (faster than extra IPC)
    const fromStatus = state.mcpStatus.filter(s => s.needsOAuth && (s.status === 'needs_auth' || s.status === 'error'));
    const merged = [...new Map([...needing, ...fromStatus].map(s => [s.name, s])).values()];
    const panel = $('#oauth-panel');
    const list = $('#oauth-list');
    const count = $('#oauth-count');
    if (!panel || !list) return;
    if (!merged.length) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    count.textContent = merged.length;
    list.innerHTML = '';
    // fetch credentials file path for hint
    try {
      const cred = await window.api.getOAuthCredentials();
      if (cred.ok && cred.file) $('#oauth-file').textContent = cred.file.split(/[/\\]/).pop();
    } catch {}
    for (const s of merged) {
      const item = document.createElement('div');
      item.className = 'oauth-item';
      const name = document.createElement('span');
      name.className = 'oauth-name';
      name.textContent = s.name;
      name.title = s.url || '';
      const url = document.createElement('span');
      url.className = 'oauth-url';
      url.textContent = (s.url || '').replace(/^https?:\/\//,'').slice(0,40);
      url.title = s.url || '';
      const btn = document.createElement('button');
      btn.className = 'btn-oauth';
      btn.textContent = 'Authorize';
      btn.title = 'Open browser to authorize this MCP - tokens saved to credentials.json for shipping';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Opening…';
        try {
          toast(`Opening browser for ${s.name}...`);
          const res = await window.api.authorizeMcp(s.name);
          if (res.ok) {
            toast(`${s.name} authorized ✓ (${res.server.tools.length} tools)`);
            refreshOAuthPanel();
          } else {
            toast(`${s.name} auth failed: ${res.error}`, true);
            btn.textContent = 'Retry';
            btn.disabled = false;
          }
        } catch (e) {
          toast(`Auth error: ${e.message}`, true);
          btn.textContent = 'Retry';
          btn.disabled = false;
        }
      });
      item.append(name, url, btn);
      list.appendChild(item);
    }
  } catch (e) {
    // silent
  }
}

// ---------------------------------------------------------------- mods

function renderMods() {
  const list = $('#mods-list');
  const count = $('#mods-count');
  if (!list) return;
  list.innerHTML = '';
  const mods = state.mods || [];
  count.textContent = mods.length ? `${mods.filter(m=>m.status==='enabled').length}/${mods.length}` : '0';
  for (const m of mods) {
    const item = document.createElement('div');
    item.className = 'mods-item ' + (m.status || 'unknown');
    const dot = document.createElement('span');
    dot.className = 'mods-dot ' + (m.status || 'unknown');
    const name = document.createElement('span');
    name.className = 'mods-name';
    name.textContent = m.name || m.id;
    name.title = `${m.id}@${m.version} - ${m.status}${m.error ? ': '+m.error : ''}`;
    const ver = document.createElement('span');
    ver.className = 'mods-ver';
    ver.textContent = m.version || '';
    item.append(dot, name, ver);
    list.appendChild(item);
  }
}

function renderModsModal() {
  const list = $('#mods-modal-list');
  const dirEl = $('#mods-dir-path');
  if (!list) return;
  list.innerHTML = '';
  const mods = state.mods || [];
  if (dirEl) dirEl.textContent = state.modsDir || 'mods/';
  if (!mods.length) {
    list.innerHTML = '<div style="color:var(--text-faint);padding:20px;text-align:center">No mods found. Create a folder in <code>mods/</code> with a <code>manifest.json</code> and <code>index.js</code>. See <code>mods/example-mod/</code> or <code>docs/MODDING.md</code>.</div>';
    return;
  }
  for (const m of mods) {
    const card = document.createElement('div');
    card.className = 'mods-modal-item ' + (m.status || '');
    const head = document.createElement('div');
    head.className = 'mods-modal-head';
    const title = document.createElement('div');
    title.className = 'mods-modal-title';
    title.textContent = `${m.name || m.id}`;
    const ver = document.createElement('span');
    ver.className = 'mods-ver';
    ver.textContent = `v${m.version || '?'} • ${m.status}`;
    head.append(title, ver);
    card.appendChild(head);
    const meta = document.createElement('div');
    meta.className = 'mods-modal-meta';
    meta.textContent = `${m.id} • by ${m.author || 'unknown'} • API ${m.modApiVersion || '?'} • ${m.permissions ? m.permissions.join(', ') : ''}`;
    card.appendChild(meta);
    if (m.description) {
      const desc = document.createElement('div');
      desc.className = 'mods-modal-desc';
      desc.textContent = m.description;
      card.appendChild(desc);
    }
    if (m.error) {
      const err = document.createElement('div');
      err.className = 'mods-modal-err';
      err.textContent = m.error;
      card.appendChild(err);
    }
    const actions = document.createElement('div');
    actions.className = 'mods-modal-actions';
    if (m.status === 'enabled') {
      const btn = document.createElement('button');
      btn.className = 'btn-disable';
      btn.textContent = 'Uninstall';
      btn.title = 'Disable then delete from disk';
      btn.addEventListener('click', async () => {
        if (!confirm(`Uninstall ${m.id}? This will delete it from your computer.`)) return;
        btn.disabled = true;
        btn.textContent = 'Uninstalling...';
        const dis = await window.api.disableMod(m.id);
        if (!dis.ok) { toast(`Disable failed: ${dis.error}`, true); btn.disabled = false; btn.textContent = 'Uninstall'; return; }
        const res = await window.api.uninstallMod(m.id);
        if (!res.ok) toast(`Uninstall failed: ${res.error}`, true);
        else toast(`${m.id} uninstalled`);
        await refreshMods();
      });
      actions.appendChild(btn);
    } else if (m.status === 'disabled' || m.status === 'error' || m.status === 'invalid') {
      const btn = document.createElement('button');
      btn.className = 'btn-enable';
      btn.textContent = m.status === 'error' ? 'Retry' : 'Enable';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await window.api.enableMod(m.id);
        if (!res.ok) toast(`Enable failed: ${res.error}`, true);
        else toast(`${m.id} enabled`);
        await refreshMods();
      });
      actions.appendChild(btn);
      const del = document.createElement('button');
      del.textContent = 'Uninstall';
      del.title = 'Delete from disk';
      del.addEventListener('click', async () => {
        if (!confirm(`Uninstall ${m.id}? This will delete it from your computer.`)) return;
        del.disabled = true;
        const res = await window.api.uninstallMod(m.id);
        if (!res.ok) toast(`Uninstall failed: ${res.error}`, true);
        else toast(`${m.id} uninstalled`);
        await refreshMods();
      });
      actions.appendChild(del);
    }
    const reload = document.createElement('button');
    reload.textContent = 'Reload';
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      const res = await window.api.reloadMod(m.id);
      if (!res.ok) toast(`Reload failed: ${res.error}`, true);
      else toast(`${m.id} reloaded`);
      await refreshMods();
    });
    actions.appendChild(reload);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function refreshMods() {
  try {
    const mods = await window.api.getMods();
    state.mods = mods || [];
    const dir = await window.api.getModsDir();
    if (dir) state.modsDir = dir;
    renderMods();
    renderModsModal();
  } catch (e) {
    console.error('refreshMods failed', e);
  }
}

window.api.on('mods:status', (mods) => {
  state.mods = mods || [];
  renderMods();
  renderModsModal();
});

async function openStore() {
  $('#store-modal').classList.remove('hidden');
  $('#store-status').textContent = 'Loading packages from GitHub...';
  $('#store-list').innerHTML = '';
  $('#store-recommended').classList.add('hidden');
  try {
    const res = await window.api.fetchPackages();
    if (!res.ok) throw new Error(res.error);
    storeCache.packages = res.packages || [];
    storeCache.nextPackageIndex = 0;
    const mods = storeCache.packages;
    $('#store-status').textContent = `${mods.length} packages available`;
    $('#store-count').textContent = `${mods.length} available`;
    storeCache.installedIds = new Set((state.mods||[]).map(m=>m.id));
    // Precompute recommendations
    const installed = { tags: getInstalledTagsAndPerms().tags, perms: getInstalledTagsAndPerms().perms, installedIds: storeCache.installedIds };
    const scored = mods.map(m => ({ ...m, _score: 0 }));
    // Lazy load will compute score after fetching each store.json; for now just render placeholders
    renderStoreList();
    // Only fetch metadata for the first screen. More loads as the user scrolls.
    lazyLoadStoreMods(8);
  } catch (e) {
    $('#store-status').textContent = `Failed to load registry: ${e.message}`;
  }
}

function renderStoreList() {
  const list = $('#store-list');
  const search = ($('#store-search').value || '').toLowerCase();
  if (!storeCache.packages) return;
  list.innerHTML = '';
  const mods = storeCache.packages;
  const filtered = mods.filter(m => !search || m.id.toLowerCase().includes(search));
  $('#store-count').textContent = `${filtered.length}/${mods.length}`;
  for (const m of filtered) {
    const cached = storeCache.mods.get(m.id);
    const row = document.createElement('div');
    row.className = 'store-card';
    row.dataset.modId = m.id;
    const isInstalled = storeCache.installedIds.has(m.id);
    row.innerHTML = `
      <div class="store-icon">${cached?._thumbnailUrl ? `<img src="${cached._thumbnailUrl}" alt="" />` : escapeStoreText((cached?.name || m.id).slice(0, 1).toUpperCase())}</div>
      <div class="store-card-body">
        <div class="mods-modal-head">
          <div class="mods-modal-title">${escapeStoreText(cached?.name || m.id)}</div>
          <span class="mods-ver">${isInstalled ? 'Installed' : escapeStoreText(cached?.version || '')}</span>
        </div>
        <div class="mods-modal-meta">${cached ? `${escapeStoreText(cached.author || 'Unknown author')} • ${escapeStoreText((cached.tags || []).slice(0,2).join(' • '))}` : 'Loading package details...'}</div>
        <div class="mods-modal-desc">${cached ? escapeStoreText(cached.description) : 'Fetching store.json...'}</div>
        <div class="mods-modal-actions">
          <button class="btn-install" data-id="${escapeStoreText(m.id)}" ${isInstalled ? 'disabled' : ''}>${isInstalled ? 'Installed' : 'Install'}</button>
        </div>
      </div>
    `;
    list.appendChild(row);
  }
  // Wire install buttons
  list.querySelectorAll('.btn-install').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const entry = storeCache.packages.find(x=>x.id===id);
      btn.disabled = true; btn.textContent = 'Installing...';
      const res = await window.api.installMod(id, entry.path);
      if (res.ok) {
        toast(`${id} installed`);
        btn.textContent = 'Installed';
        await refreshMods();
        storeCache.installedIds.add(id);
        renderStoreList();
      } else {
        toast(`Install failed: ${res.error}`, true);
        btn.disabled = false; btn.textContent = 'Install';
      }
    });
  });
}

async function lazyLoadStoreMods(batchSize = 8) {
  if (!storeCache.packages) return;
  const mods = storeCache.packages;
  const installed = { tags: getInstalledTagsAndPerms().tags, perms: getInstalledTagsAndPerms().perms, installedIds: storeCache.installedIds };
  const end = Math.min(storeCache.nextPackageIndex + batchSize, mods.length);
  for (let i = storeCache.nextPackageIndex; i < end; i++) {
    const m = mods[i];
    if (storeCache.mods.has(m.id)) continue;
    try {
      const res = await window.api.fetchMod(m.path);
      if (res.ok) {
        storeCache.mods.set(m.id, res.mod);
        const thumbnail = await loadStoreThumbnail(m.path, res.mod);
        if (thumbnail) res.mod._thumbnailUrl = thumbnail;
        // Update recommendation score
        res.mod._score = scoreModForRecommendations(res.mod, installed);
        // Hydrate the visible card immediately; do not make the user reopen
        // the store just to see metadata or the downloaded thumbnail.
        renderStoreList();
      }
    } catch {}
  }
  storeCache.nextPackageIndex = end;
  // Re-render with data and show recommendations
  renderStoreWithRecommendations();
}

function renderStoreWithRecommendations() {
  const recList = $('#store-recommended-list');
  const recPanel = $('#store-recommended');
  if (!recList || !recPanel) return;
  const modsWithData = [...storeCache.mods.values()].filter(m=>m._score>0).sort((a,b)=>b._score-a._score).slice(0,3);
  if (!modsWithData.length) {
    recPanel.classList.add('hidden');
    renderStoreList();
    return;
  }
  recPanel.classList.remove('hidden');
  recList.innerHTML = '';
  for (const m of modsWithData) {
    const row = document.createElement('div');
    row.className = 'mods-modal-item';
    row.style.borderColor = 'var(--accent)';
    row.innerHTML = `<div class="mods-modal-head"><div class="mods-modal-title">${escapeStoreText(m.name||m.id)}</div><span class="mods-ver">★ Recommended</span></div><div class="mods-modal-desc">${escapeStoreText(m.description)}</div><div class="mods-modal-actions"><button class="btn-install" data-id="${escapeStoreText(m.id)}" ${storeCache.installedIds.has(m.id)?'disabled':''}>${storeCache.installedIds.has(m.id)?'Installed':'Install'}</button></div>`;
    recList.appendChild(row);
  }
  recList.querySelectorAll('.btn-install').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id=btn.dataset.id; const e=storeCache.packages.find(x=>x.id===id);
      btn.disabled=true; btn.textContent='Installing...';
      const res=await window.api.installMod(id,e.path);
      if(res.ok){toast(`${id} installed`); await refreshMods(); storeCache.installedIds.add(id); renderStoreList(); renderStoreWithRecommendations();}
      else{toast(`Install failed: ${res.error}`,true); btn.disabled=false; btn.textContent='Install';}
    });
  });
  renderStoreList();
}

// ---------------------------------------------------------------- settings

async function refreshModels() {
  const res = await window.api.listModels();
  if (res.ok) {
    state.models = res.models;
    const sel = $('#set-model');
    const current = state.settings.model || sel.value;
    sel.innerHTML = '';
    for (const m of res.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id.replace('@cf/', '');
      opt.title = m.description || '';
      sel.appendChild(opt);
    }
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
    else sel.value = sel.options[0]?.value;
    if (sel.value) $('#brand-model').textContent = sel.value.split('/').pop();
  } else {
    toast('Failed to load models: ' + res.error, true);
  }
}

function openSettings() {
  const s = state.settings;
  $('#set-temp').value = s.temperature;
  $('#temp-val').textContent = s.temperature.toFixed(2);
  $('#set-maxtok').value = s.maxTokens;
  $('#maxtok-val').textContent = s.maxTokens;
  $('#set-reasoning').value = s.reasoningEffort || '';
  $('#set-approval').checked = !!s.requireToolApproval;
  $('#settings-modal').classList.remove('hidden');
  refreshModels();
}

async function applySettings() {
  state.settings = await window.api.setSettings({
    temperature: parseFloat($('#set-temp').value),
    maxTokens: parseInt($('#set-maxtok').value, 10),
    reasoningEffort: $('#set-reasoning').value,
    requireToolApproval: $('#set-approval').checked,
  });
  $('#toggle-websearch').checked = !!state.settings.webSearchEnabled;
  $('#temp-val').textContent = state.settings.temperature.toFixed(2);
  $('#maxtok-val').textContent = state.settings.maxTokens;
  const model = $('#set-model').value;
  if (model && model !== state.settings.model) {
    state.settings.model = model;
    await window.api.setSettings({ model });
    $('#brand-model').textContent = model.split('/').pop();
  }
  toast('Settings saved');
}

// ---------------------------------------------------------------- image studio

const gallery = [];
const MAX_GALLERY = 30;

async function generateImage() {
  const prompt = $('#studio-prompt').value.trim();
  if (!prompt) { toast('Enter a prompt first', true); return; }
  if (prompt.length > 4000) { toast('Prompt too long (max 4000)', true); return; }
  const btn = $('#btn-generate');
  btn.disabled = true;
  $('#studio-status').textContent = 'Generating…';
  $('#studio-status').className = 'studio-status';
  try {
    const res = await window.api.generateImage({
      prompt,
      size: $('#studio-size').value,
      model: $('#studio-model').value !== 'default' ? $('#studio-model').value : undefined,
    });
    if (res.ok) {
      gallery.unshift({ prompt, src: res.dataUrl });
      if (gallery.length > MAX_GALLERY) gallery.length = MAX_GALLERY;
      renderGallery();
      $('#studio-status').textContent = '';
    } else {
      $('#studio-status').textContent = res.error;
      $('#studio-status').className = 'studio-status error';
    }
  } catch (err) {
    $('#studio-status').textContent = err.message || String(err);
    $('#studio-status').className = 'studio-status error';
  } finally {
    btn.disabled = false;
  }
}

function renderGallery() {
  const g = $('#studio-gallery');
  g.innerHTML = '';
  for (const item of gallery) {
    const wrap = document.createElement('div');
    wrap.className = 'gallery-item';
    const img = makeImg(item.src);
    const actions = document.createElement('div');
    actions.className = 'gallery-actions';
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.addEventListener('click', () => window.api.saveImage(item.src, `flux-${Date.now()}.png`));
    const send = document.createElement('button');
    send.textContent = 'Send to chat';
    send.addEventListener('click', () => {
      state.pendingFiles.push({ kind: 'image', name: 'generated.png', size: 0, image: item.src });
      renderPendingFiles();
      $('#chat-empty').classList.add('hidden');
      toast('Image attached to chat');
    });
    actions.append(save, send);
    wrap.append(img, actions);
    g.appendChild(wrap);
  }
}

// ---------------------------------------------------------------- first-run setup

function runFirstRunSetup() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'setup-overlay';
    overlay.innerHTML = `
      <div class="setup-card">
        <div class="setup-title">Welcome to Pkax</div>
        <p class="setup-sub">Enter your Cloudflare Workers AI credentials once &mdash; they will be saved to <code>config\\cloudflare.json</code> in the app data folder and loaded automatically from now on.</p>
        <label class="field-label" for="setup-account">Cloudflare Account ID</label>
        <input id="setup-account" class="setup-input" type="text" placeholder="32-character hex ID from your dashboard" spellcheck="false" autocomplete="off" />
        <label class="field-label" for="setup-token">API Token (Workers AI)</label>
        <input id="setup-token" class="setup-input" type="password" placeholder="Your Cloudflare API token" spellcheck="false" autocomplete="off" />
        <div class="setup-actions">
          <span class="setup-error"></span>
          <button class="btn-primary btn-setup-save">Save &amp; Continue</button>
        </div>
        <p class="setup-hint">Defaults: chat model <code>@cf/qwen/qwen3.8-27b</code>, image model <code>@cf/black-forest-labs/flux-1-schnell</code>.</p>
      </div>`;
    document.body.appendChild(overlay);
    const accountInput = overlay.querySelector('#setup-account');
    const tokenInput = overlay.querySelector('#setup-token');
    const errEl = overlay.querySelector('.setup-error');
    const btn = overlay.querySelector('.btn-setup-save');
    const submit = async () => {
      errEl.textContent = '';
      btn.disabled = true;
      try {
        const res = await window.api.saveCredentials({
          accountId: accountInput.value.trim(),
          apiToken: tokenInput.value.trim(),
        });
        if (!res.ok) {
          errEl.textContent = res.error || 'Failed to save.';
          btn.disabled = false;
          return;
        }
        toast('Credentials saved');
        overlay.remove();
        resolve(true);
      } catch (err) {
        errEl.textContent = err.message || String(err);
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', submit);
    [accountInput, tokenInput].forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    accountInput.focus();
  });
}

// ---------------------------------------------------------------- boot

window.api.on('loading:update', ({ text, sub }) => {
  const el = document.getElementById('loading-text');
  const subEl = document.getElementById('loading-sub');
  if (el && text) el.textContent = text;
  if (subEl && sub !== undefined) subEl.textContent = sub;
});
window.api.on('loading:done', () => {
  const scr = document.getElementById('loading-screen');
  if (scr) { scr.style.opacity = '0'; scr.style.transition = 'opacity 0.4s'; setTimeout(() => scr.remove(), 400); }
});

async function init() {
  let info = await window.api.init();
  if (info.needsCredentials) {
    await runFirstRunSetup();
    info = await window.api.init();
  }
  state.settings = info.settings;
  state.mcpStatus = info.mcpStatus;
  state.conversations = info.conversations || [];
  state.settings.model = state.settings.model || info.model;
  const displayModel = state.settings.model || info.model;
  $('#brand-model').textContent = displayModel.split('/').pop();
  $('#set-account').textContent = info.accountId?.slice(0, 12) + '…';
  $('#set-model').value = displayModel;

  $('#toggle-websearch').checked = !!state.settings.webSearchEnabled;
  $('#toggle-websearch').addEventListener('change', async (e) => {
    state.settings = await window.api.setSettings({ webSearchEnabled: e.target.checked });
  });

  $('#studio-model').innerHTML = '<option value="default">FLUX 1 schnell (default)</option>';
  try {
    const imgModels = await window.api.listModels();
    if (imgModels.ok) {
      for (const m of imgModels.models) {
        if (m.id.includes('flux') || m.id.includes('sd-xl')) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.id.replace('@cf/', '');
          $('#studio-model').appendChild(opt);
        }
      }
    }
  } catch { /* non-fatal */ }

  renderMcp();
  refreshOAuthPanel();
  await refreshMods();
  renderConvList();
  renderMessages();

  // event wiring
  $('#btn-new-chat').addEventListener('click', newChat);
  $('#btn-send').addEventListener('click', send);
  $('#btn-stop').addEventListener('click', () => window.api.stopGeneration(state.currentId));
  $('#btn-attach').addEventListener('click', async () => {
    const paths = await window.api.openFileDialog();
    if (paths.length) addFiles(paths);
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-close').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-modal').addEventListener('click', (e) => { if (e.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden'); });
  $('#btn-refresh-models').addEventListener('click', refreshModels);
  $('#btn-mcp-retry').addEventListener('click', async () => {
    $('#btn-mcp-retry').disabled = true;
    const status = await window.api.retryMcp();
    state.mcpStatus = status;
    renderMcp();
    refreshOAuthPanel();
    $('#btn-mcp-retry').disabled = false;
  });
  const oauthClear = $('#btn-oauth-clear');
  if (oauthClear) oauthClear.addEventListener('click', async () => {
    if (!confirm('Clear all stored OAuth tokens? You will need to re-authorize each MCP.')) return;
    await window.api.clearOAuthCredentials();
    toast('OAuth tokens cleared');
    refreshOAuthPanel();
    const status = await window.api.retryMcp();
    state.mcpStatus = status;
    renderMcp();
  });
  const btnMods = $('#btn-mods');
  if (btnMods) btnMods.addEventListener('click', () => {
    refreshMods();
    $('#mods-modal').classList.remove('hidden');
  });
  const btnModsClose = $('#btn-mods-close');
  if (btnModsClose) btnModsClose.addEventListener('click', () => $('#mods-modal').classList.add('hidden'));
  const modsModal = $('#mods-modal');
  if (modsModal) modsModal.addEventListener('click', (e) => { if (e.target === modsModal) modsModal.classList.add('hidden'); });
  const btnModsReloadAll = $('#btn-mods-reload-all');
  if (btnModsReloadAll) btnModsReloadAll.addEventListener('click', async () => {
    btnModsReloadAll.disabled = true;
    const mods = await window.api.getMods();
    for (const m of mods) await window.api.reloadMod(m.id);
    await refreshMods();
    btnModsReloadAll.disabled = false;
    toast('Mods reloaded');
  });
  const btnModsAdd = $('#btn-mods-add');
  if (btnModsAdd) btnModsAdd.addEventListener('click', () => openStore());
  const btnStoreClose = $('#btn-store-close');
  if (btnStoreClose) btnStoreClose.addEventListener('click', () => $('#store-modal').classList.add('hidden'));
  const storeModal = $('#store-modal');
  if (storeModal) storeModal.addEventListener('click', (e) => { if (e.target === storeModal) storeModal.classList.add('hidden'); });
  const storeSearch = $('#store-search');
  if (storeSearch) storeSearch.addEventListener('input', () => renderStoreList());
  const storeList = $('#store-list');
  if (storeList) storeList.addEventListener('scroll', () => {
    if (storeList.scrollTop + storeList.clientHeight >= storeList.scrollHeight - 160) lazyLoadStoreMods();
  });
  $('#btn-studio').addEventListener('click', () => $('#studio').classList.remove('hidden'));
  $('#btn-studio-close').addEventListener('click', () => $('#studio').classList.add('hidden'));
  $('#btn-generate').addEventListener('click', generateImage);

  $('#input').addEventListener('input', autoResize);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  ['input', 'set-temp', 'set-maxtok', 'set-reasoning', 'set-approval'].forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (id === 'set-temp') $('#temp-val').textContent = parseFloat(el.value).toFixed(2);
      if (id === 'set-maxtok') $('#maxtok-val').textContent = el.value;
      applySettings();
    });
  });
  // Model dropdown should update UI and persist immediately, not just on Save
  const modelSel = $('#set-model');
  if (modelSel) {
    modelSel.addEventListener('change', async () => {
      const newModel = modelSel.value;
      $('#brand-model').textContent = newModel.split('/').pop();
      state.settings.model = newModel;
      await window.api.setSettings({ model: newModel });
      toast(`Model set to ${newModel}`);
    });
  }

  // drag & drop
  document.addEventListener('dragenter', (e) => { e.preventDefault(); $('#drop-overlay').classList.remove('hidden'); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragleave', (e) => { if (e.target === document.body) $('#drop-overlay').classList.add('hidden'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $('#drop-overlay').classList.add('hidden');
    const paths = [...(e.dataTransfer.files || [])].map(f => f.path);
    if (paths.length) addFiles(paths);
  });

  if (!state.conversations.length) {
    newChat();
  } else {
    loadConversation(state.conversations[0].id);
  }

  // ping API once to show connection status
  const models = await window.api.listModels();
  const dot = $('#conn-status');
  dot.classList.add(models.ok ? 'ok' : 'err');
  dot.title = models.ok ? 'Connected to Cloudflare Workers AI' : 'API unreachable: ' + (models.error || '');

  await initModUI();
}

// ---------------------------------------------------------------- mod UI hooks
// Mods with "ui" permission get their index.js require()'d HERE (renderer has full
// Node access via nodeIntegration) and onUIReady(api) is called with real DOM access.

async function initModUI() {
  let uiMods = [];
  try {
    uiMods = await window.api.getUiMods();
  } catch (e) {
    console.error('[mod-ui] failed to list ui mods:', e);
    return;
  }
  const nodeRequire = window.require;
  if (!nodeRequire) {
    console.warn('[mod-ui] nodeIntegration unavailable - skipping UI mods');
    return;
  }
  for (const m of uiMods) {
    try {
      delete nodeRequire.cache[nodeRequire.resolve(m.mainPath)];
      const mod = nodeRequire(m.mainPath);
      if (typeof mod.onUIReady !== 'function') continue;
      await Promise.resolve(mod.onUIReady({
        id: m.id,
        name: m.name,
        version: m.version,
        manifest: m.manifest,
        document,
        window,
        api: window.api,
        log: {
          debug: (...a) => console.debug(`[mod:${m.id}]`, ...a),
          info: (...a) => console.info(`[mod:${m.id}]`, ...a),
          warn: (...a) => console.warn(`[mod:${m.id}]`, ...a),
          error: (...a) => console.error(`[mod:${m.id}]`, ...a),
        },
      }));
      console.info(`[mod:${m.id}] onUIReady completed`);
    } catch (e) {
      console.error(`[mod-ui] ${m.id} onUIReady failed:`, e);
      toast(`${m.name || m.id} UI error: ${e.message}`, true);
    }
  }
}

let _resizeTimer = null;
function autoResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    const el = $('#input');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, 16);
}

init().catch(err => {
  console.error('init failed', err);
  const el = document.getElementById('chat-empty');
  if (el) el.innerHTML = `<div style="color:var(--red);padding:20px">Failed to initialize: ${String(err.message || err)}</div>`;
});
