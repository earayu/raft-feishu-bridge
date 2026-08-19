#!/usr/bin/env node
// bridge.mjs — Feishu WebSocket event bridge.
//
// Reads ./app.json for credentials, connects to Feishu via WebSocket,
// and forwards im.message.receive_v1 events to your agent by either:
//   • running AGENT_HANDLER_CMD (message JSON delivered on stdin), OR
//   • POSTing JSON to AGENT_HANDLER_WEBHOOK
//
// Environment variables:
//   AGENT_HANDLER_CMD      Shell command to run for each message (message JSON on stdin)
//   AGENT_HANDLER_WEBHOOK  HTTP(S) URL to POST message JSON to
//   BRIDGE_DEFAULT_TARGET  Fallback "target" string for chats not in routing.json (default: "default")
//   BRIDGE_MUTED_CHATS     Comma-separated Feishu chat_ids to mute (no delivery)
//
// Mute (no Raft delivery) can also be configured in routing.json:
//   "oc_xxx": "mute"           // per-chat sentinel (also: __mute__ | drop | discard)
//   "_mute": ["oc_xxx", ...]   // bulk list (alias: _muted)
//
// The bridge never sends to Feishu — use send.mjs for outbound.

// Strip localhost-only proxies (Privoxy/Tor) — they break axios with Feishu endpoints.
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  const v = process.env[k];
  if (v && /127\.0\.0\.1|localhost|::1/.test(v)) delete process.env[k];
}

import * as lark from '@larksuiteoapi/node-sdk';
import { readFile, appendFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonStateStore } from './state-store.mjs';
import {
  collectMutedChats,
  isChatMuted,
  isMuteTarget,
  raftChildEnv,
} from './raft-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_FILE = path.join(__dirname, 'app.json');
const ROUTING_FILE = path.join(__dirname, 'routing.json');
const LOG_FILE = path.join(__dirname, 'logs', 'bridge.log');
const STATE_DIR = process.env.BRIDGE_STATE_DIR || path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'bridge-state.json');
const TMP_DIR = path.join(os.tmpdir(), 'feishu-bridge-attachments');
const DEFAULT_TARGET = process.env.BRIDGE_DEFAULT_TARGET || 'default';

const HANDLER_CMD = process.env.AGENT_HANDLER_CMD;
const HANDLER_WEBHOOK = process.env.AGENT_HANDLER_WEBHOOK;
const HEALTH_NOTIFY_TARGET = process.env.BRIDGE_HEALTH_NOTIFY_TARGET;
const RAFT_BIN = process.env.RAFT_BIN || 'raft';
const SEEN_TTL_MS = Number(process.env.BRIDGE_SEEN_TTL_MS || String(7 * 24 * 60 * 60 * 1000));
const store = new JsonStateStore(STATE_FILE, { seenTtlMs: SEEN_TTL_MS });

// --- logging ---
async function log(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  process.stderr.write(line);
  try {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, line);
  } catch {}
}

// --- routing: chat_id -> target string ---
// routing.json may contain `_comment` / `_history` / other underscore-prefixed
// metadata keys for documentation purposes. They are stripped here so that
// resolveTarget() only sees real chat_id -> target mappings. Real Feishu chat
// IDs never start with `_`, so this is safe.
// `_mute` / `_muted` arrays and mute-sentinel values are collected into a Set
// so handleReceive can drop those chats before any download/dispatch work.
async function loadRouting() {
  if (!existsSync(ROUTING_FILE)) {
    return { routing: {}, muted: collectMutedChats({}, process.env) };
  }
  try {
    const raw = JSON.parse(await readFile(ROUTING_FILE, 'utf8'));
    const routing = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_') && typeof v === 'string') routing[k] = v;
    }
    const muted = collectMutedChats(raw, process.env);
    return { routing, muted };
  } catch (e) {
    await log('warn', 'routing.json parse error, using empty map:', e.message);
    return { routing: {}, muted: collectMutedChats({}, process.env) };
  }
}

function resolveTarget(routing, chatId) {
  const t = routing[chatId];
  // Mute sentinels must never fall through as a real Raft target.
  if (isMuteTarget(t)) return DEFAULT_TARGET;
  return t || DEFAULT_TARGET;
}

// --- mention resolution ---
function resolveMentions(text, mentions) {
  if (!text || !Array.isArray(mentions) || !mentions.length) return text;
  let out = text;
  for (const m of mentions) {
    if (!m?.key) continue;
    const name = m.name || m.id?.open_id || m.key;
    while (out.includes(m.key)) {
      out = out.replace(m.key, `@${name}`);
    }
  }
  return out;
}

// --- text extraction ---
function extractText(event) {
  const msg = event?.message;
  if (!msg) return '';
  const t = msg.message_type;
  const mentions = msg.mentions || event?.mentions || [];
  if (t === 'text') {
    let text;
    try { text = JSON.parse(msg.content).text || ''; } catch { text = msg.content || ''; }
    return resolveMentions(text, mentions);
  }
  if (t === 'post') {
    try {
      const post = JSON.parse(msg.content);
      let blocks = Array.isArray(post?.content) ? post.content : null;
      if (!blocks) {
        for (const v of Object.values(post)) {
          if (v && typeof v === 'object' && Array.isArray(v.content)) {
            blocks = v.content;
            break;
          }
        }
      }
      blocks = blocks || [];
      const text = blocks
        .flat()
        .map((b) => {
          if (!b) return '';
          if (b.tag === 'at') return b.user_name ? `@${b.user_name}` : '';
          if (b.tag === 'img') return '';
          return b.text || '';
        })
        .filter(Boolean)
        .join(' ');
      return resolveMentions(text || '[post]', mentions);
    } catch { return '[post]'; }
  }
  return `[${t}] ${msg.content || ''}`;
}

// --- image / file resource refs ---
function parseResourceRefs(msg) {
  const t = msg?.message_type;
  if (!t) return [];
  let content;
  try { content = JSON.parse(msg.content || '{}'); } catch { return []; }
  if (t === 'image' && content.image_key) {
    return [{ kind: 'image', file_key: content.image_key, type_param: 'image', filename: `${content.image_key}.jpg` }];
  }
  if (t === 'file' && content.file_key) {
    return [{ kind: 'file', file_key: content.file_key, type_param: 'file', filename: content.file_name || content.file_key }];
  }
  if (t === 'post') {
    let blocks = Array.isArray(content?.content) ? content.content : null;
    if (!blocks) {
      for (const v of Object.values(content)) {
        if (v && typeof v === 'object' && Array.isArray(v.content)) {
          blocks = v.content;
          break;
        }
      }
    }
    const refs = [];
    for (const b of (blocks || []).flat()) {
      if (!b) continue;
      if (b.tag === 'img' && b.image_key) {
        refs.push({ kind: 'image', file_key: b.image_key, type_param: 'image', filename: `${b.image_key}.jpg` });
      } else if (b.tag === 'media' && b.file_key) {
        refs.push({ kind: 'file', file_key: b.file_key, type_param: 'file', filename: b.file_name || b.file_key });
      }
    }
    return refs;
  }
  return [];
}

async function downloadResource(client, messageId, ref) {
  await mkdir(TMP_DIR, { recursive: true });
  const localPath = path.join(TMP_DIR, `${Date.now()}-${ref.filename.replace(/[^\w.\-]/g, '_')}`);
  const res = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: ref.file_key },
    params: { type: ref.type_param },
  });
  await res.writeFile(localPath);
  return localPath;
}

// --- user name cache ---
const USER_CACHE = new Map();
const USER_TTL_MS = 60 * 60 * 1000;

async function resolveUserName(client, openId) {
  if (!openId) return null;
  const hit = USER_CACHE.get(openId);
  if (hit && Date.now() - hit.ts < USER_TTL_MS) return hit.name;
  try {
    const res = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    const name = res?.data?.user?.name || null;
    USER_CACHE.set(openId, { name, ts: Date.now() });
    return name;
  } catch {
    USER_CACHE.set(openId, { name: null, ts: Date.now() });
    return null;
  }
}

// --- dispatch to agent handler ---
function dispatchCmd(cmd, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`handler exit=${code}: ${stderr.trim()}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function dispatchWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${await res.text()}`);
  return await res.text();
}

async function dispatch(payload) {
  if (HANDLER_CMD) {
    return await dispatchCmd(HANDLER_CMD, payload);
  }
  if (HANDLER_WEBHOOK) {
    return await dispatchWebhook(HANDLER_WEBHOOK, payload);
  }
  // Fallback: print to stdout as JSON (useful for piping / testing)
  process.stdout.write(JSON.stringify(payload) + '\n');
  return 'stdout';
}

function notifyHealthFailure(reason) {
  if (!HEALTH_NOTIFY_TARGET) return;
  const body = `🚨 raft-feishu-bridge dispatch failure\n\n${reason}`;
  const child = spawn(RAFT_BIN, ['message', 'send', '--target', HEALTH_NOTIFY_TARGET], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: raftChildEnv(),
  });
  child.stdin.end(body);
}

// --- attachment local paths (passed in payload) ---
async function handleReceive(client, routing, mutedSet, data) {
  const tmpFiles = [];
  let currentMessageId = null;
  try {
    const msg = data?.message || {};
    const chatId = msg.chat_id || 'unknown';
    const chatType = msg.chat_type || '?';
    const messageId = msg.message_id;
    currentMessageId = messageId;

    // Mute first: no download, no state write, no handler dispatch.
    if (isChatMuted(chatId, routing, mutedSet)) {
      await log('info', `muted: skip delivery chat=${chatId} msg=${messageId}`);
      return;
    }

    if (store.isDuplicate(messageId)) {
      await log('info', `dedup: skipping already-seen message_id=${messageId}`);
      return;
    }

    const text = extractText(data);
    const senderId = data?.sender?.sender_id?.open_id || null;
    const senderName = await resolveUserName(client, senderId);
    const target = resolveTarget(routing, chatId);

    // Download attachments (image/file) to local temp files
    const refs = parseResourceRefs(msg);
    const localAttachments = [];
    for (const ref of refs) {
      try {
        const localPath = await downloadResource(client, messageId, ref);
        tmpFiles.push(localPath);
        localAttachments.push({ kind: ref.kind, local_path: localPath, filename: ref.filename, file_key: ref.file_key });
        await log('info', `downloaded ${ref.kind} ${ref.file_key} -> ${localPath}`);
      } catch (e) {
        await log('warn', `resource download failed (${ref.kind} ${ref.file_key}): ${e.message}`);
      }
    }

    // Build normalized payload for the agent handler
    const payload = {
      event: 'message',
      target,
      chat_id: chatId,
      chat_type: chatType,
      message_id: messageId,
      sender_open_id: senderId,
      sender_name: senderName,
      text,
      attachments: localAttachments,
      timestamp: new Date().toISOString(),
      raw: data,
    };
    store.recordInbound(payload);

    const result = await dispatch(payload);
    store.recordHealthPatch({
      last_dispatch_ok_at: new Date().toISOString(),
      last_dispatch_error: null,
      last_message_id: messageId,
      last_target: target,
    });
    await log('info', `dispatched chat=${chatId} target=${target} msg=${messageId} -> ${String(result).split('\n')[0]}`);
  } catch (e) {
    if (currentMessageId) {
      store.releaseSeen(currentMessageId);
      await store.flush();
    }
    store.recordHealthPatch({
      last_dispatch_failed_at: new Date().toISOString(),
      last_dispatch_error: e.message,
    });
    await log('error', 'dispatch failed:', e.message);
    notifyHealthFailure(e.message);
  } finally {
    // Note: agent handler is responsible for consuming attachment files before they're cleaned up.
    // Set KEEP_ATTACHMENTS=1 to skip cleanup.
    if (!process.env.KEEP_ATTACHMENTS) {
      for (const f of tmpFiles) {
        try { await unlink(f); } catch {}
      }
    }
  }
}

async function main() {
  if (!existsSync(APP_FILE)) {
    await log('fatal', 'app.json missing. Run `npm run register` first.');
    process.exit(1);
  }
  const { app_id, app_secret } = JSON.parse(await readFile(APP_FILE, 'utf8'));
  const { routing, muted: mutedSet } = await loadRouting();
  await store.load();

  if (!HANDLER_CMD && !HANDLER_WEBHOOK) {
    await log('warn', 'No AGENT_HANDLER_CMD or AGENT_HANDLER_WEBHOOK set — messages will be printed to stdout as JSON.');
  }

  await log('info', `bridge starting. app_id=${app_id} default_target=${DEFAULT_TARGET} state_file=${STATE_FILE}`);
  await log('info', `routing has ${Object.keys(routing).length} entries, muted=${mutedSet.size}`);
  if (mutedSet.size) {
    await log('info', `muted chats: ${[...mutedSet].join(', ')}`);
  }
  if (HANDLER_CMD) await log('info', `handler: CMD = ${HANDLER_CMD}`);
  if (HANDLER_WEBHOOK) await log('info', `handler: WEBHOOK = ${HANDLER_WEBHOOK}`);

  const wsClient = new lark.WSClient({
    appId: app_id,
    appSecret: app_secret,
    loggerLevel: lark.LoggerLevel.info,
  });

  const apiClient = new lark.Client({
    appId: app_id,
    appSecret: app_secret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => handleReceive(apiClient, routing, mutedSet, data),
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // Flush the seen-messages cache on shutdown so we don't re-process
      // already-seen messages after a restart.
      store.flush()
        .finally(() => log('info', `received ${sig}, exiting`))
        .finally(() => process.exit(0));
    });
  }

  await wsClient.start({ eventDispatcher: dispatcher });
  await log('info', 'wsClient.start returned (normally only happens after disconnect)');
}

main().catch(async (e) => {
  await log('fatal', 'bridge crashed:', e?.message || e);
  process.exit(1);
});
