'use strict';

/**
 * Dependency-free web search backed by DuckDuckGo HTML endpoints.
 * No API key required. Falls back between html / lite endpoints.
 */
const { debug, info, warn, error: logError } = require('./logger');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 800 * 1024; // 800 KB - prevents huge pages from eating memory
const searchCache = new Map(); // query|limit -> { ts, results }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchText(url) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Fetch timed out', 'TimeoutError')), FETCH_TIMEOUT_MS);
  try {
    debug('websearch', `fetch ${url.slice(0,100)}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Search backend returned HTTP ${res.status}`);
    const text = await res.text();
    const len = text.length;
    debug('websearch', `fetch ok ${url.slice(0,60)} ${res.status} len=${len} in ${Date.now()-t0}ms`);
    if (len > MAX_HTML_BYTES) {
      warn('websearch', `truncating html ${len} -> ${MAX_HTML_BYTES}`);
      return text.slice(0, MAX_HTML_BYTES);
    }
    return text;
  } catch (err) {
    logError('websearch', `fetch failed ${url.slice(0,80)} after ${Date.now()-t0}ms: ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripHtml(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractWithClassPatterns(html) {
  const results = [];
  const segments = html.split('result__body');
  for (let i = 1; i < segments.length && results.length < 8; i++) {
    const seg = segments[i];
    const linkMatch = seg.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/s);
    const snippetMatch = seg.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    const title = stripHtml(linkMatch[2]);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function extractLite(html) {
  const results = [];
  const rows = html.match(/<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs) || [];
  for (const row of rows) {
    const href = row.match(/href="([^"]+)"/)[1];
    const title = stripHtml(row.replace(/<a[^>]*href="[^"]*"[^>]*>/g, '').replace(/<\/a>/g, ''));
    if (href.startsWith('//duckduckgo.com/l/')) {
      const q = new URL('https:' + href).searchParams.get('uddg');
      if (q) results.push({ title, url: q, snippet: '' });
    }
  }
  return results;
}

async function search(query, limit = 5) {
  const t0 = Date.now();
  if (!query || !query.trim()) {
    debug('websearch', 'search empty query -> []');
    return [];
  }
  let clean = query.trim().replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
  if (!clean) {
    debug('websearch', 'search cleaned empty -> []');
    return [];
  }
  limit = Math.max(1, Math.min(10, parseInt(limit, 10) || 5));
  const cacheKey = `${clean}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    info('websearch', `cache hit "${clean.slice(0,50)}" limit=${limit} -> ${cached.results.length} results in ${Date.now()-t0}ms`);
    return cached.results;
  }
  info('websearch', `search start "${clean.slice(0,50)}" limit=${limit} cacheMiss`);
  // prune cache if it grows too large
  if (searchCache.size > 50) {
    for (const [k, v] of searchCache) {
      if (Date.now() - v.ts > CACHE_TTL_MS) searchCache.delete(k);
    }
  }
  const q = encodeURIComponent(clean);

  // Primary: html.duckduckgo.com
  try {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`);
    const results = dedupe(extractWithClassPatterns(html)).slice(0, limit);
    info('websearch', `html endpoint parsed ${results.length} results in ${Date.now()-t0}ms`);
    if (results.length) {
      results.forEach((r,i)=> debug('websearch', `  ${i+1}. ${r.title.slice(0,60)} ${r.url.slice(0,80)}`));
      searchCache.set(cacheKey, { ts: Date.now(), results });
      info('websearch', `search done "${clean.slice(0,40)}" -> ${results.length} results in ${Date.now()-t0}ms via html`);
      return results;
    } else {
      warn('websearch', `html endpoint 0 results for "${clean.slice(0,40)}"`);
    }
  } catch (err) {
    logError('websearch', `html endpoint failed in ${Date.now()-t0}ms: ${err.message}`);
  }

  // Fallback: lite.duckduckgo.com
  try {
    const html = await fetchText(`https://lite.duckduckgo.com/lite/?q=${q}`);
    const results = dedupe(extractLite(html)).slice(0, limit);
    info('websearch', `lite endpoint parsed ${results.length} results in ${Date.now()-t0}ms`);
    if (results.length) {
      results.forEach((r,i)=> debug('websearch', `  lite ${i+1}. ${r.title.slice(0,60)} ${r.url.slice(0,80)}`));
      searchCache.set(cacheKey, { ts: Date.now(), results });
      info('websearch', `search done "${clean.slice(0,40)}" -> ${results.length} results via lite in ${Date.now()-t0}ms`);
      return results;
    }
  } catch (err) {
    logError('websearch', `lite endpoint failed: ${err.message}`);
  }

  warn('websearch', `search no results "${clean.slice(0,40)}" after ${Date.now()-t0}ms`);
  return [];
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

module.exports = { search };
