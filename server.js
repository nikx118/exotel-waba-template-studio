#!/usr/bin/env node
/**
 * WABA Template Studio for Exotel — local server
 * Node 18+ · zero dependencies
 *
 *   node server.js
 *
 *   Editor UI + API  → http://localhost:3000           (bound to 127.0.0.1 only — never expose this port)
 *   Webhook listener → http://localhost:3001/webhook/<secret>
 *                      (expose ONLY this port to the internet, e.g. `ngrok http 3001`)
 *
 * Why two ports?  The UI port can submit templates with your Exotel credentials.
 * If you tunnelled that port, anyone with the URL could use your account. The webhook
 * port only accepts status callbacks, so it is the only thing that goes public.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (typeof fetch !== 'function') {
  console.error('This app needs Node.js 18 or newer (for built-in fetch). You have ' + process.version);
  process.exit(1);
}

// ───────────────────────── paths & settings ─────────────────────────
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  registry: path.join(DATA_DIR, 'templates.json'),
  webhooks: path.join(DATA_DIR, 'webhooks.jsonl'),
};
const UI_PORT = Number(process.env.UI_PORT || 3000);
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 3001);
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || '0.0.0.0';
// While a template is waiting for Meta, ask Exotel for its status this often (0 = off).
// This means approvals show up even without a webhook tunnel.
const POLL_MS = Number(process.env.POLL_MINUTES ?? 3) * 60_000;
let webhookPort = WEBHOOK_PORT; // the port actually bound (may move up if WEBHOOK_PORT is busy)

const REGIONS = {
  in: 'https://api.in.exotel.com', // Mumbai cluster (India data residency)
  sg: 'https://api.exotel.com',    // Singapore cluster
};

// Statuses Meta uses for message templates (not message delivery statuses)
const TEMPLATE_STATUSES = new Set([
  'APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'FLAGGED',
  'DELETED', 'ARCHIVED', 'PENDING_DELETION', 'REINSTATED', 'LIMIT_EXCEEDED',
]);
const WAITING_STATUSES = new Set(['PENDING', 'IN_APPEAL']);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────────────────────── small helpers ─────────────────────────
const now = () => new Date().toISOString();

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

/** Visit every object inside `value`. Return false from fn to stop descending into that object. */
function walk(value, fn, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) return;
  if (Array.isArray(value)) { value.forEach(v => walk(v, fn, depth + 1)); return; }
  if (fn(value) === false) return;
  for (const v of Object.values(value)) walk(v, fn, depth + 1);
}

// ───────────────────────── config & account profiles ─────────────────────────
/*
 * data/config.json holds one webhook secret plus any number of Exotel account profiles:
 *   { webhookSecret, activeProfileId, profiles: [{ id, name, apiKey, apiToken, accountSid, wabaId, region, baseUrlOverride }] }
 * Everything that talks to Exotel uses the active profile unless it is handed another one.
 */
const PROFILE_KEYS = ['apiKey', 'apiToken', 'accountSid', 'wabaId', 'region', 'baseUrlOverride'];
const ENV_KEYS = {
  apiKey: 'EXOTEL_API_KEY', apiToken: 'EXOTEL_API_TOKEN', accountSid: 'EXOTEL_ACCOUNT_SID',
  wabaId: 'EXOTEL_WABA_ID', region: 'EXOTEL_REGION', baseUrlOverride: 'EXOTEL_BASE_URL',
};

const blankProfile = name => ({
  id: crypto.randomBytes(4).toString('hex'), name,
  apiKey: '', apiToken: '', accountSid: '', wabaId: '', region: 'in', baseUrlOverride: '',
});

/** The saved file, upgraded in place from the single-account format if needed */
function readStore() {
  const saved = readJSON(FILES.config, {});
  let changed = false;
  if (!Array.isArray(saved.profiles)) {
    // Single-account config from before profiles → it becomes the first profile
    const first = blankProfile('Default');
    for (const k of PROFILE_KEYS) if (saved[k] !== undefined) { first[k] = saved[k]; delete saved[k]; }
    saved.profiles = [first];
    changed = true;
  }
  if (!saved.profiles.length) { saved.profiles = [blankProfile('Default')]; changed = true; }
  if (!saved.profiles.some(p => p.id === saved.activeProfileId)) { saved.activeProfileId = saved.profiles[0].id; changed = true; }
  if (!saved.webhookSecret) { saved.webhookSecret = crypto.randomBytes(12).toString('hex'); changed = true; }
  if (changed) writeJSON(FILES.config, saved, 0o600);
  return saved;
}
const writeStore = saved => writeJSON(FILES.config, saved, 0o600);

/** Settings for one profile (the active one by default), with the shared webhook secret */
function loadConfig(profileId) {
  const saved = readStore();
  const active = profileId === undefined || profileId === saved.activeProfileId;
  const p = saved.profiles.find(x => x.id === (profileId ?? saved.activeProfileId));
  if (!p) throw new HttpError(404, 'No such account profile.');
  const cfg = { ...blankProfile(''), ...p, profileId: p.id, profileName: p.name, webhookSecret: saved.webhookSecret };
  // Environment variables win over the saved file for the active profile (handy on a single-account VPS)
  if (active) for (const [k, envName] of Object.entries(ENV_KEYS)) if (process.env[envName]) cfg[k] = process.env[envName];
  if (process.env.WEBHOOK_SECRET) cfg.webhookSecret = process.env.WEBHOOK_SECRET;
  return cfg;
}

function saveProfile(id, patch) {
  const saved = readStore();
  const p = saved.profiles.find(x => x.id === id);
  if (!p) throw new HttpError(404, 'No such account profile.');
  Object.assign(p, patch);
  writeStore(saved);
}

function checkProfileName(saved, name, exceptId) {
  if (!name) throw new HttpError(400, 'Give the account a name.');
  if (name.length > 60) throw new HttpError(400, 'Account name is too long (60 characters max).');
  if (saved.profiles.some(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, `There is already an account called “${name}”.`);
  }
}

const isReady = cfg => Boolean(cfg.apiKey && cfg.apiToken && cfg.accountSid && cfg.wabaId);

function apiBase(cfg) {
  if (cfg.baseUrlOverride) return cfg.baseUrlOverride.replace(/\/+$/, '');
  return REGIONS[cfg.region] || REGIONS.in;
}

function publicConfig(cfg = loadConfig()) {
  const saved = readStore();
  return {
    profileId: cfg.profileId,
    profileName: cfg.profileName,
    profiles: saved.profiles.map(p => {
      const c = loadConfig(p.id);
      return { id: c.profileId, name: c.profileName, accountSid: c.accountSid, wabaId: c.wabaId, region: c.region, ready: isReady(c) };
    }),
    apiKey: cfg.apiKey,
    accountSid: cfg.accountSid,
    wabaId: cfg.wabaId,
    region: cfg.region,
    baseUrlOverride: cfg.baseUrlOverride,
    apiTokenSet: Boolean(cfg.apiToken),
    apiTokenHint: cfg.apiToken ? `••••${cfg.apiToken.slice(-4)}` : '',
    ready: isReady(cfg),
    apiBase: apiBase(cfg),
    webhook: {
      path: `/webhook/${cfg.webhookSecret}`,
      localUrl: `http://localhost:${webhookPort}/webhook/${cfg.webhookSecret}`,
      port: webhookPort,
    },
    pollMinutes: POLL_MS / 60_000,
  };
}

// ───────────────────────── Exotel API client ─────────────────────────
async function exotel(method, subPath, { query = {}, json, raw, contentType, cfg = loadConfig() } = {}) {
  const missing = [['apiKey', 'API key'], ['apiToken', 'API token'], ['accountSid', 'Account SID']]
    .filter(([k]) => !cfg[k]).map(([, label]) => label);
  if (missing.length) throw new HttpError(400, `Add the ${missing.join(', ')} for “${cfg.profileName}” in Settings first.`);

  const url = new URL(`${apiBase(cfg)}/v2/accounts/${encodeURIComponent(cfg.accountSid)}${subPath}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  // Same as https://<key>:<token>@host in Exotel's docs — sent as a Basic auth header instead
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64'),
    Accept: 'application/json',
  };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (raw) { headers['Content-Type'] = contentType || 'application/octet-stream'; body = raw; }

  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new HttpError(502, `Could not reach Exotel at ${url.host}: ${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 3000) }; }
  return { ok: res.ok, httpStatus: res.status, data, endpoint: `${method} ${url.pathname}${url.search}` };
}

/** Pull the most useful error message out of an Exotel response */
function exotelError(data) {
  const errs = [];
  walk(data, o => {
    if (o.error_data && typeof o.error_data === 'object') errs.push(o.error_data);
    if (o.error && typeof o.error === 'object') errs.push(o.error);
  });
  const e = errs[0] || data?.RestException || {};
  const parts = [e.message, e.description || e.error_user_msg || e.error_user_title, e.code && `code ${e.code}`]
    .filter(Boolean);
  if (parts.length) return [...new Set(parts)].join(' — ');
  if (data?.message) return String(data.message);
  if (data?.raw) return String(data.raw).slice(0, 300);
  return '';
}

// ───────────────────────── local template registry ─────────────────────────
// Each entry carries the wabaId it lives on, so several accounts can share one list.
let registry = readJSON(FILES.registry, []);
{
  // Lists from before profiles were all for the one account that was configured then
  const wabaId = loadConfig().wabaId;
  const unscoped = registry.filter(e => !e.wabaId);
  if (wabaId && unscoped.length) { for (const e of unscoped) e.wabaId = wabaId; writeJSON(FILES.registry, registry); }
}

function persistRegistry() {
  writeJSON(FILES.registry, registry);
  broadcast('registry', registry);
}

/** Template ids are unique across Meta; names are only unique within one WABA (pass wabaId when known) */
function findEntry({ id, name, language, wabaId }) {
  if (id) {
    const byId = registry.find(e => e.id && e.id === String(id));
    if (byId) return byId;
  }
  if (name) {
    return registry.find(e => e.status !== 'SUBMIT_FAILED' && e.name === name &&
      (!wabaId || !e.wabaId || e.wabaId === wabaId) &&
      (!language || !e.language || e.language === language));
  }
  return undefined;
}

function pushHistory(entry, status, source, note) {
  entry.history = [...(entry.history || []), { at: now(), status, source, ...(note ? { note } : {}) }].slice(-25);
}

const cleanReason = r => (r && String(r).toUpperCase() !== 'NONE' ? String(r) : '');

function applyStatusUpdate(u, source) {
  let entry = findEntry(u);
  if (!entry) {
    entry = {
      key: crypto.randomUUID(), id: u.id, name: u.name || `template_${u.id}`, language: u.language || '',
      category: u.category || '', createdAt: now(), origin: source, ...(u.wabaId ? { wabaId: u.wabaId } : {}),
    };
    registry.unshift(entry);
  }
  if (u.id && !entry.id) entry.id = String(u.id);
  if (u.category && !entry.category) entry.category = u.category;
  const changed = entry.status !== u.status;
  entry.status = u.status;
  if (u.status === 'APPROVED') entry.reason = '';
  else if (cleanReason(u.reason)) entry.reason = cleanReason(u.reason);
  entry.updatedAt = now();
  if (changed) pushHistory(entry, u.status, source, cleanReason(u.reason));
  return entry;
}

// ───────────────────────── live updates to the browser (SSE) ─────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25_000).unref();

// ───────────────────────── template actions ─────────────────────────
async function createTemplate(template) {
  if (!template || typeof template !== 'object') throw new HttpError(400, 'Missing template');
  if (!/^[a-z0-9_]{1,512}$/.test(template.name || '')) {
    throw new HttpError(400, 'Template name must use only lowercase letters, numbers and underscores.');
  }
  const cfg = loadConfig();
  if (!cfg.wabaId) throw new HttpError(400, `Add the WABA ID for “${cfg.profileName}” in Settings first.`);

  const body = { whatsapp: { templates: [{ template }] } };
  const r = await exotel('POST', '/templates', { query: { waba_id: cfg.wabaId }, json: body, cfg });

  const item = r.data?.response?.whatsapp?.templates?.[0];
  const accepted = r.ok && Boolean(item) &&
    (String(item.status).toLowerCase() === 'success' || [200, 201].includes(Number(item.code)));
  const reason = accepted ? '' : (exotelError(r.data) || `HTTP ${r.httpStatus}`);

  let entry;
  if (accepted) {
    const id = item?.data?.id ? String(item.data.id) : undefined;
    entry = (id && registry.find(e => e.id === id)) || null;
    if (!entry) { entry = { key: crypto.randomUUID(), createdAt: now(), origin: 'studio' }; registry.unshift(entry); }
    Object.assign(entry, {
      id, name: template.name, language: template.language, category: template.category,
      status: item?.data?.status ? String(item.data.status).toUpperCase() : 'PENDING',
      reason: '', payload: template, wabaId: cfg.wabaId, submittedAt: now(), updatedAt: now(),
    });
    pushHistory(entry, entry.status, 'submitted');
  } else {
    // Keep one failed draft per name+language so retries don't pile up
    registry = registry.filter(e => !(e.status === 'SUBMIT_FAILED' && e.name === template.name &&
      e.language === template.language && e.wabaId === cfg.wabaId));
    entry = {
      key: crypto.randomUUID(), name: template.name, language: template.language, category: template.category,
      status: 'SUBMIT_FAILED', reason, payload: template, wabaId: cfg.wabaId,
      createdAt: now(), updatedAt: now(), origin: 'studio',
    };
    pushHistory(entry, 'SUBMIT_FAILED', 'submitted', reason);
    registry.unshift(entry);
  }
  persistRegistry();
  return { accepted, httpStatus: r.httpStatus, endpoint: r.endpoint, entry, reason, exotel: r.data };
}

/** Find template-looking objects (name + status) anywhere in a GET /templates response */
function extractTemplateList(data) {
  const out = new Map();
  walk(data, o => {
    if (typeof o.name === 'string' && typeof o.status === 'string' && (o.language || o.components || o.category)) {
      const t = {
        id: o.id != null ? String(o.id) : undefined,
        name: o.name, language: o.language || '', category: o.category || '',
        status: o.status.toUpperCase(), reason: cleanReason(o.rejected_reason),
        components: o.components,
      };
      out.set(t.id || `${t.name}|${t.language}`, t);
      return false; // don't descend into its components
    }
  });
  return [...out.values()];
}

function findPagingAfter(data) {
  let after;
  walk(data, o => {
    if (o.paging && typeof o.paging === 'object' && o.paging.next && o.paging.cursors?.after) {
      after = o.paging.cursors.after; return false;
    }
  });
  return after;
}

async function syncTemplates(cfg = loadConfig()) {
  if (!cfg.wabaId) throw new HttpError(400, `Add the WABA ID for “${cfg.profileName}” in Settings first.`);
  const all = [];
  let after; let pages = 0; let last;
  do {
    const r = await exotel('GET', '/templates', { query: { waba_id: cfg.wabaId, limit: 100, after }, cfg });
    last = r;
    if (!r.ok) throw new HttpError(r.httpStatus, `Exotel: ${exotelError(r.data) || `HTTP ${r.httpStatus}`}`, r.data);
    const batch = extractTemplateList(r.data);
    all.push(...batch);
    const next = findPagingAfter(r.data);
    after = next && next !== after && batch.length ? next : undefined;
  } while (after && ++pages < 20);

  let added = 0; let changed = 0; const changes = [];
  for (const t of all) {
    let entry = findEntry({ ...t, wabaId: cfg.wabaId });
    if (!entry) {
      entry = { key: crypto.randomUUID(), createdAt: now(), origin: 'sync', wabaId: cfg.wabaId };
      registry.push(entry);
      added++;
    } else if (entry.status !== t.status) {
      changed++;
      changes.push({ id: t.id, name: t.name, status: t.status, reason: t.status === 'APPROVED' ? '' : t.reason });
    }
    const statusChanged = entry.status !== t.status;
    Object.assign(entry, {
      id: t.id || entry.id, wabaId: cfg.wabaId, name: t.name, language: t.language || entry.language,
      category: t.category || entry.category, status: t.status,
      reason: t.status === 'APPROVED' ? '' : (t.reason || entry.reason || ''),
      components: t.components || entry.components, syncedAt: now(), updatedAt: now(),
    });
    if (statusChanged) pushHistory(entry, t.status, 'sync');
  }
  persistRegistry();
  return { found: all.length, added, changed, changes, ...(all.length ? {} : { rawResponse: last?.data }) };
}

/**
 * Background check: only runs for accounts with something waiting for Meta, so it costs
 * nothing otherwise. Every profile is checked, not just the active one.
 */
let polling = false;
async function pollPending() {
  if (polling) return;
  const waiting = new Set(registry.filter(e => WAITING_STATUSES.has(e.status)).map(e => e.wabaId));
  if (!waiting.size) return;
  polling = true;
  try {
    const seen = new Set();
    for (const { id } of readStore().profiles) {
      const cfg = loadConfig(id);
      if (!isReady(cfg) || !waiting.has(cfg.wabaId) || seen.has(cfg.wabaId)) continue;
      seen.add(cfg.wabaId);
      try {
        const { changes } = await syncTemplates(cfg);
        for (const c of changes) console.log(`  [${cfg.profileName}] ${c.name}: ${c.status}${c.reason ? ` — ${c.reason}` : ''}`);
        if (changes.length) broadcast('status', changes);
      } catch (e) {
        console.error(`Automatic status check failed for “${cfg.profileName}”: ${e.message}`);
      }
    }
  } finally { polling = false; }
}

function findHandle(data) {
  let handle;
  walk(data, o => {
    if (handle) return false;
    // Exotel answers { file_handle: [{ status, data: { id: "4::…" } }] }; older/other shapes are flatter
    const pick = x => (typeof x === 'string' ? x : x && (x.data?.id || x.data?.h || x.id || x.h));
    const fh = o.file_handle;
    if (Array.isArray(fh) && fh[0]) handle = pick(fh[0]);
    else if (fh && typeof fh === 'object') handle = pick(fh);
    else if (typeof fh === 'string') handle = fh;
    else if (typeof o.h === 'string') handle = o.h;
  });
  return handle;
}

const SAMPLE_TYPES = new Set(['image/jpeg', 'image/png', 'video/mp4', 'application/pdf']);

async function uploadSample(buf, fileType) {
  if (!buf.length) throw new HttpError(400, 'The file is empty.');
  if (!SAMPLE_TYPES.has(fileType)) throw new HttpError(400, `Unsupported file type "${fileType}". Use JPG, PNG, MP4 or PDF.`);
  const r = await exotel('POST', '/templates/sample', {
    query: { file_length: buf.length, file_type: fileType }, raw: buf, contentType: fileType,
  });
  const handle = findHandle(r.data);
  if (!r.ok || !handle) {
    throw new HttpError(r.ok ? 502 : r.httpStatus,
      `Sample upload failed: ${exotelError(r.data) || 'no file handle in the response'}`, r.data);
  }
  return { handle, exotel: r.data };
}

// ───────────────────────── webhook processing ─────────────────────────
let webhookEvents = [];
try {
  webhookEvents = fs.readFileSync(FILES.webhooks, 'utf8').trim().split('\n').filter(Boolean)
    .slice(-200).map(l => JSON.parse(l)).reverse();
} catch { /* first run */ }

/**
 * Exotel doesn't publish the exact template-status payload, so this looks for any object
 * that carries a *template* status (APPROVED/REJECTED/…) plus an id or name. It covers
 * Meta's native shape (entry[].changes[].value.event / message_template_id) and flat
 * Exotel-style shapes (template_id / name / status).
 */
function extractTemplateUpdates(payload) {
  const found = new Map();
  walk(payload, o => {
    const raw = [o.event, o.statusUpdateEvent, o.template_status, o.status].find(v => typeof v === 'string');
    const status = raw && raw.toUpperCase();
    if (!status || !TEMPLATE_STATUSES.has(status)) return;
    // Message delivery statuses (statuses[] with a wamid / recipient_id) can also say "deleted"
    if (o.recipient_id || /^wamid\./.test(String(o.id ?? ''))) return;
    const id = o.message_template_id ?? o.template_id ?? o.templateId ?? o.id;
    const name = o.message_template_name ?? o.template_name ?? o.templateName ?? o.name;
    if (id == null && !name) return;
    const u = {
      id: id != null ? String(id) : undefined, name, status,
      language: o.message_template_language ?? o.language,
      category: o.message_template_category ?? o.category,
      reason: o.reason ?? o.rejected_reason ?? o.rejection_reason ?? o.other_info?.description,
    };
    found.set(`${u.id || ''}|${u.name || ''}`, u);
  });
  return [...found.values()];
}

function handleWebhookPayload(payload, source = 'webhook') {
  const updates = extractTemplateUpdates(payload);
  // Meta's shape names the WABA as entry[].id; that keeps name-only matches on the right account
  const wabaId = [payload?.waba_id, payload?.object === 'whatsapp_business_account' && payload?.entry?.[0]?.id]
    .find(v => typeof v === 'string' || typeof v === 'number');
  const applied = updates.map(u => applyStatusUpdate(wabaId != null ? { ...u, wabaId: String(wabaId) } : u, source));
  const evt = {
    at: now(), source,
    type: payload?.type || payload?.entry?.[0]?.changes?.[0]?.field || payload?.event_type || 'unknown',
    updates: updates.map(({ id, name, status, reason }) => ({ id, name, status, reason: cleanReason(reason) })),
    payload,
  };
  fs.appendFileSync(FILES.webhooks, JSON.stringify(evt) + '\n');
  webhookEvents.unshift(evt);
  if (webhookEvents.length > 200) webhookEvents.length = 200;
  broadcast('webhook', evt);
  if (applied.length) persistRegistry();
  return evt;
}

// ───────────────────────── HTTP plumbing ─────────────────────────
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
/** Answer with the config and tell other open windows, so their account switcher stays in step */
function sendConfig(res) {
  const cfg = publicConfig();
  broadcast('config', cfg);
  send(res, 200, cfg);
}
function sendError(res, e) {
  const status = e instanceof HttpError ? e.status : 500;
  if (status >= 500 && !(e instanceof HttpError)) console.error(e);
  if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong', details: e.details });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  // A real JSON content type forces a CORS preflight, so other websites can't send it
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send the body as application/json');
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}
function parseLoose(buf) {
  const text = buf.toString('utf8');
  try { return JSON.parse(text); } catch { /* not JSON */ }
  if (text.includes('=')) return Object.fromEntries(new URLSearchParams(text));
  return { raw: text };
}

const isLocalHost = host => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host || '');
const isLocalOrigin = origin => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin || '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ───────────────────────── UI + API server (local only) ─────────────────────────
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/config' && m === 'GET') return send(res, 200, publicConfig());
  if (p === '/api/config' && m === 'POST') { // edits the active profile; regenerateSecret is shared by all
    const b = await readJSONBody(req);
    const cfg = loadConfig();
    const patch = {};
    for (const k of ['apiKey', 'accountSid', 'wabaId', 'baseUrlOverride']) if (typeof b[k] === 'string') patch[k] = b[k].trim();
    if (typeof b.apiToken === 'string' && b.apiToken.trim()) patch.apiToken = b.apiToken.trim(); // blank = keep existing
    if (b.region && REGIONS[b.region]) patch.region = b.region;
    if (typeof b.name === 'string') { patch.name = b.name.trim(); checkProfileName(readStore(), patch.name, cfg.profileId); }
    if (patch.baseUrlOverride && !/^https?:\/\//.test(patch.baseUrlOverride)) throw new HttpError(400, 'Base URL must start with http:// or https://');
    saveProfile(cfg.profileId, patch);
    if (b.regenerateSecret) writeStore({ ...readStore(), webhookSecret: crypto.randomBytes(12).toString('hex') });
    return sendConfig(res);
  }

  if (p === '/api/profiles' && m === 'POST') { // add an account and switch to it
    const b = await readJSONBody(req);
    const saved = readStore();
    const name = String(b.name || '').trim();
    checkProfileName(saved, name);
    const profile = blankProfile(name);
    saved.profiles.push(profile);
    saved.activeProfileId = profile.id;
    writeStore(saved);
    return sendConfig(res);
  }
  const prof = p.match(/^\/api\/profiles\/([\w-]+)(\/activate)?$/);
  if (prof && m === 'POST' && prof[2]) {
    const saved = readStore();
    if (!saved.profiles.some(x => x.id === prof[1])) throw new HttpError(404, 'No such account profile.');
    writeStore({ ...saved, activeProfileId: prof[1] });
    return sendConfig(res);
  }
  if (prof && m === 'DELETE' && !prof[2]) { // forgets the saved credentials only; its templates stay in the list
    const saved = readStore();
    if (!saved.profiles.some(x => x.id === prof[1])) throw new HttpError(404, 'No such account profile.');
    if (saved.profiles.length === 1) throw new HttpError(400, 'You need at least one account. Edit this one instead.');
    saved.profiles = saved.profiles.filter(x => x.id !== prof[1]);
    if (saved.activeProfileId === prof[1]) saved.activeProfileId = saved.profiles[0].id;
    writeStore(saved);
    return sendConfig(res);
  }

  if (p === '/api/test-connection' && m === 'POST') {
    const cfg = loadConfig();
    if (!cfg.wabaId) throw new HttpError(400, `Add the WABA ID for “${cfg.profileName}” in Settings first.`);
    let r = await exotel('GET', '/templates', { query: { waba_id: cfg.wabaId, limit: 1 }, cfg });
    let message = r.ok ? 'Connected — Exotel accepted your credentials and WABA ID.' : (exotelError(r.data) || `HTTP ${r.httpStatus}`);
    // A 401 often just means the account lives on the other cluster (Mumbai vs Singapore) — try it
    if (r.httpStatus === 401 && !cfg.baseUrlOverride) {
      const other = cfg.region === 'sg' ? 'in' : 'sg';
      const r2 = await exotel('GET', '/templates', { query: { waba_id: cfg.wabaId, limit: 1 }, cfg: { ...cfg, region: other } });
      if (r2.ok) {
        r = r2;
        saveProfile(cfg.profileId, { region: other });
        broadcast('config', publicConfig());
        message = `Connected — your account is on the ${other === 'sg' ? 'Singapore (api.exotel.com)' : 'India — Mumbai (api.in.exotel.com)'} cluster, so Region was switched to that.`;
      } else {
        message += ' — the key/token were refused on both the Mumbai and Singapore clusters. Re-copy them from my.exotel.com → API Settings.';
      }
    }
    return send(res, 200, { ok: r.ok, httpStatus: r.httpStatus, endpoint: r.endpoint, message, exotel: r.data, config: publicConfig() });
  }

  if (p === '/api/templates' && m === 'GET') return send(res, 200, registry);
  if (p === '/api/templates' && m === 'POST') {
    const b = await readJSONBody(req);
    return send(res, 200, await createTemplate(b.template));
  }
  const del = p.match(/^\/api\/templates\/([\w-]+)$/);
  if (del && m === 'DELETE') { // removes from the LOCAL list only — nothing is deleted at Exotel/Meta
    const before = registry.length;
    registry = registry.filter(e => e.key !== del[1]);
    if (registry.length === before) throw new HttpError(404, 'Not in local list');
    persistRegistry();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/sync' && m === 'POST') return send(res, 200, await syncTemplates());

  if (p === '/api/upload-sample' && m === 'POST') {
    const type = url.searchParams.get('type') || req.headers['content-type'];
    const buf = await readBody(req, 100 * 1024 * 1024);
    return send(res, 200, await uploadSample(buf, type));
  }

  if (p === '/api/webhooks' && m === 'GET') return send(res, 200, webhookEvents);
  if (p === '/api/webhook-test' && m === 'POST') {
    const b = await readJSONBody(req);
    return send(res, 200, handleWebhookPayload(b.payload || {}, 'test'));
  }

  throw new HttpError(404, `No route for ${m} ${p}`);
}

const uiServer = http.createServer(async (req, res) => {
  try {
    // Blocks DNS-rebinding tricks: only answer requests addressed to localhost
    if (!isLocalHost(req.headers.host)) return send(res, 403, { error: 'This UI only answers on localhost.' });
    // Blocks CSRF: browsers always send Origin on cross-site POST/DELETE, so only the editor itself gets through
    if (req.method !== 'GET' && req.headers.origin !== undefined && !isLocalOrigin(req.headers.origin)) {
      return send(res, 403, { error: 'Requests from other websites are not allowed.' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(res, url.pathname);
  } catch (e) { sendError(res, e); }
});

// ───────────────────────── Webhook server (the only public part) ─────────────────────────
const webhookServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://webhook.local');
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    const cfg = loadConfig();
    if (url.pathname !== `/webhook/${cfg.webhookSecret}`) return send(res, 404, { error: 'Not found' });

    if (req.method === 'GET') {
      // Meta-style verification handshake — harmless if Exotel never uses it
      const challenge = url.searchParams.get('hub.challenge') || url.searchParams.get('challenge');
      return challenge ? sendText(res, 200, challenge) : send(res, 200, { ok: true, listening: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

    const payload = parseLoose(await readBody(req, 2 * 1024 * 1024));

    const sids = readStore().profiles.map(p => loadConfig(p.id).accountSid).filter(Boolean);
    if (payload?.account_sid && sids.length && !sids.includes(payload.account_sid)) {
      return send(res, 403, { error: 'account_sid does not match any saved account' });
    }
    if (payload?.type === 'verification' && payload.challenge) {
      send(res, 200, { challenge: payload.challenge });
    } else {
      send(res, 200, { ok: true }); // acknowledge fast; Exotel retries if we are slow
    }
    setImmediate(() => {
      try { handleWebhookPayload(payload, 'webhook'); } catch (e) { console.error('Webhook processing failed:', e); }
    });
  } catch (e) { sendError(res, e); }
});

// ───────────────────────── start ─────────────────────────
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* ignore */ }
}

/** Listen on `port`; if it's taken, try the next one (up to `tries` more). Resolves with the port used. */
function listen(server, port, host, tries) {
  return new Promise((resolve, reject) => {
    const onError = e => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(server, port + 1, host, tries - 1));
      else reject(e);
    };
    const onListening = () => { server.off('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** True if this app is already answering on that port (e.g. the launcher was double-clicked twice) */
async function studioRunningOn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    return r.ok && 'apiBase' in (await r.json());
  } catch { return false; }
}

(async () => {
  if (await studioRunningOn(UI_PORT)) {
    console.log(`WABA Template Studio is already running — opening http://localhost:${UI_PORT}`);
    openBrowser(`http://localhost:${UI_PORT}`);
    return;
  }
  // Only hop to another port when the user didn't ask for a specific one
  const uiPort = await listen(uiServer, UI_PORT, '127.0.0.1', process.env.UI_PORT ? 0 : 10);
  webhookPort = await listen(webhookServer, WEBHOOK_PORT, WEBHOOK_HOST, process.env.WEBHOOK_PORT ? 0 : 10);
  const cfg = loadConfig();
  console.log(`
  WABA Template Studio is running

  Editor   →  http://localhost:${uiPort}
  Webhook  →  http://localhost:${webhookPort}/webhook/${cfg.webhookSecret}   (optional)

  ${POLL_MS ? `Pending templates are re-checked with Exotel every ${POLL_MS / 60_000} min, so you'll see
  approvals here even without the webhook. For instant updates, make the webhook public:` : 'To receive approval/rejection updates, make the webhook public:'}
     ngrok http ${webhookPort}        (or: cloudflared tunnel --url http://localhost:${webhookPort})
  and paste  https://<your-tunnel>/webhook/${cfg.webhookSecret}
  into Exotel Dashboard → WhatsApp → Settings → Webhooks.

  Keep this window open while you work. Press Ctrl+C (or close the window) to stop.
`);
  openBrowser(`http://localhost:${uiPort}`);
  if (POLL_MS) {
    setInterval(pollPending, POLL_MS).unref();
    setTimeout(pollPending, 5_000).unref();
  }
})().catch(e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${e.port} is already in use. Close the other app or set UI_PORT / WEBHOOK_PORT.`);
  else console.error(e);
  process.exit(1);
});
