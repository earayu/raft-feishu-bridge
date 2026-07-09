import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class JsonStateStore {
  constructor(filePath, { seenTtlMs = 10 * 60 * 1000, flushDelayMs = 2000 } = {}) {
    this.filePath = filePath;
    this.seenTtlMs = seenTtlMs;
    this.flushDelayMs = flushDelayMs;
    this.state = {
      version: 1,
      seen_messages: {},
      message_map: {},
      attachments: {},
      health: {},
    };
    this.dirty = false;
    this.flushTimer = null;
  }

  async load() {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    this.state = {
      version: 1,
      seen_messages: raw.seen_messages && typeof raw.seen_messages === 'object' ? raw.seen_messages : {},
      message_map: raw.message_map && typeof raw.message_map === 'object' ? raw.message_map : {},
      attachments: raw.attachments && typeof raw.attachments === 'object' ? raw.attachments : {},
      health: raw.health && typeof raw.health === 'object' ? raw.health : {},
    };
    this.pruneSeen(Date.now());
  }

  pruneSeen(now) {
    for (const [id, ts] of Object.entries(this.state.seen_messages)) {
      if (typeof ts !== 'number' || now - ts > this.seenTtlMs) {
        delete this.state.seen_messages[id];
        this.dirty = true;
      }
    }
  }

  isDuplicate(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    this.pruneSeen(now);
    if (this.state.seen_messages[messageId]) return true;
    this.state.seen_messages[messageId] = now;
    this.markDirty();
    return false;
  }

  recordInbound(payload) {
    const messageId = payload?.message_id;
    if (!messageId) return;
    this.state.message_map[messageId] = {
      chat_id: payload.chat_id,
      chat_type: payload.chat_type,
      target: payload.target,
      sender_open_id: payload.sender_open_id,
      sender_name: payload.sender_name,
      received_at: payload.timestamp,
      text_preview: String(payload.text || '').slice(0, 240),
    };
    for (const attachment of payload.attachments || []) {
      if (!attachment.file_key) continue;
      this.state.attachments[attachment.file_key] = {
        message_id: messageId,
        kind: attachment.kind,
        filename: attachment.filename,
        last_local_path: attachment.local_path,
        seen_at: payload.timestamp,
      };
    }
    this.markDirty();
  }

  recordHealthPatch(patch) {
    this.state.health = {
      ...this.state.health,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, this.flushDelayMs);
  }

  async flush() {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    this.dirty = false;
  }
}
