'use strict';

const { URL } = require('url');

const TRUSTED_DOC_HOSTS = Object.freeze([
  'code.visualstudio.com',
  'nodejs.org',
  'docs.python.org',
  'developer.mozilla.org',
  'learn.microsoft.com',
]);

function clipText(value, maxLength = 240) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function isTrustedDocUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/i.test(url.protocol)) {
      return false;
    }
    const host = String(url.hostname || '').trim().toLowerCase();
    return TRUSTED_DOC_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch (_error) {
    return false;
  }
}

function normalizeTrustedDocSource(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return { ok: false, url: '', host: '', reason: 'Empty doc source.' };
  }
  try {
    const parsed = new URL(raw);
    const normalized = parsed.toString();
    const host = String(parsed.hostname || '').trim().toLowerCase();
    if (!isTrustedDocUrl(normalized)) {
      return { ok: false, url: normalized, host, reason: `Host ${host || 'unknown'} is not in the trusted docs allowlist.` };
    }
    return { ok: true, url: normalized, host, reason: '' };
  } catch (error) {
    return { ok: false, url: '', host: '', reason: clipText(error instanceof Error ? error.message : 'Invalid doc URL.', 180) || 'Invalid doc URL.' };
  }
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCharCode(parseInt(digits, 10)));
}

function stripHtml(value = '') {
  const html = String(value || '');
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|p|div|section|article|li|h\d)\b[^>]*>/gi, '\n')
      .replace(/<\/([pdivsectionarticlelih\d]+)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
}

function extractTitle(html = '') {
  const titleMatch = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return clipText(stripHtml(titleMatch[1]), 120);
  }
  const headingMatch = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return headingMatch ? clipText(stripHtml(headingMatch[1]), 120) : '';
}

function extractCodeSnippets(html = '', maxCount = 3) {
  const snippets = [];
  const seen = new Set();
  const regex = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) && snippets.length < maxCount) {
    const text = stripHtml(match[1])
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
    if (!text) {
      continue;
    }
    const clipped = text.length > 320 ? `${text.slice(0, 317).trimEnd()}...` : text;
    if (seen.has(clipped)) {
      continue;
    }
    seen.add(clipped);
    snippets.push(clipped);
  }
  return snippets;
}

function extractPatternSentences(text = '', matcher, maxCount = 3) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const out = [];
  const seen = new Set();
  for (const sentence of sentences) {
    const candidate = clipText(sentence, 220);
    if (!candidate || seen.has(candidate) || !matcher.test(candidate)) {
      continue;
    }
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= maxCount) {
      break;
    }
  }
  return out;
}

function buildTrustedDocDigest({ url = '', html = '' } = {}) {
  const normalized = normalizeTrustedDocSource(url);
  const text = stripHtml(html);
  const paragraphMatches = Array.from(String(html || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi));
  const paragraphSummaries = paragraphMatches
    .map((match) => clipText(stripHtml(match[1]), 260))
    .filter(Boolean);
  const paragraphs = text.split(/\n{2,}/).map((entry) => clipText(entry, 260)).filter(Boolean);
  return {
    url: normalized.url,
    host: normalized.host,
    title: extractTitle(html) || clipText(normalized.host || normalized.url, 120),
    summary: paragraphSummaries[0] || paragraphs[0] || '',
    snippets: extractCodeSnippets(html),
    goodPatterns: extractPatternSentences(text, /(prefer|recommended|best practice|should|use\b)/i),
    avoidPatterns: extractPatternSentences(text, /(avoid|do not|don't|not recommended|deprecated|never)/i),
  };
}

async function fetchTrustedDocDigests(sources = [], options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for trusted docs intake.');
  }
  const digests = [];
  const failures = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const normalized = normalizeTrustedDocSource(source);
    if (!normalized.ok) {
      failures.push({ source: String(source || '').trim(), reason: normalized.reason || 'Unsupported doc source.' });
      continue;
    }
    try {
      const response = await fetchImpl(normalized.url, {
        headers: {
          'user-agent': 'GoSenderr-Engine-CLI/0.1',
          accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
        },
      });
      if (response && response.ok === false) {
        failures.push({ source: normalized.url, reason: `HTTP ${response.status || 'error'}` });
        continue;
      }
      const html = typeof response.text === 'function' ? await response.text() : String(response || '');
      digests.push(buildTrustedDocDigest({ url: normalized.url, html }));
    } catch (error) {
      failures.push({
        source: normalized.url,
        reason: clipText(error instanceof Error ? error.message : 'Unable to fetch trusted doc.', 180) || 'Unable to fetch trusted doc.',
      });
    }
  }
  return { digests, failures };
}

function renderTrustedDocPromptBlock(digests = []) {
  const items = Array.isArray(digests) ? digests.filter((item) => item && typeof item === 'object') : [];
  if (!items.length) {
    return '';
  }
  const lines = ['Trusted online docs:'];
  for (const item of items.slice(0, 3)) {
    lines.push(`- ${item.title || item.host || item.url}`);
    lines.push(`  URL: ${item.url}`);
    if (item.summary) {
      lines.push(`  Summary: ${clipText(item.summary, 220)}`);
    }
    if (Array.isArray(item.goodPatterns) && item.goodPatterns.length > 0) {
      lines.push(`  Good patterns: ${item.goodPatterns.slice(0, 2).join(' | ')}`);
    }
    if (Array.isArray(item.avoidPatterns) && item.avoidPatterns.length > 0) {
      lines.push(`  Avoid patterns: ${item.avoidPatterns.slice(0, 2).join(' | ')}`);
    }
    if (Array.isArray(item.snippets) && item.snippets.length > 0) {
      item.snippets.slice(0, 2).forEach((snippet, index) => {
        lines.push(`  Snippet ${index + 1}: ${snippet}`);
      });
    }
  }
  return lines.join('\n');
}

module.exports = {
  TRUSTED_DOC_HOSTS,
  buildTrustedDocDigest,
  fetchTrustedDocDigests,
  isTrustedDocUrl,
  normalizeTrustedDocSource,
  renderTrustedDocPromptBlock,
};