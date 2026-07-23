#!/usr/bin/env node
// raft-handler.mjs — official Feishu -> Raft handler.
//
// Reads the normalized bridge payload from stdin, uploads any downloaded
// Feishu attachments to Raft, then posts a compact message to the payload's
// target using the configured external-agent profile.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  addNativeWakeMention,
  raftChildEnv,
  withRetry,
} from './raft-utils.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (body += chunk));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(body));
  });
}

function run(cmd, args, { input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exit=${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function raftEnv() {
  const env = raftChildEnv();
  if (process.env.RAFT_PROFILE) env.RAFT_PROFILE = process.env.RAFT_PROFILE;
  return env;
}

function raftBin() {
  return process.env.RAFT_BIN || 'raft';
}

async function runRaftWithRetry(args, options = {}) {
  return await withRetry(
    () => run(raftBin(), args, { ...options, env: raftEnv() }),
    {
      onError: async (error, attempt, total) => {
        process.stderr.write(
          `raft-handler retry ${attempt}/${total} failed: ${error.message}\n`,
        );
      },
    },
  );
}

function extractAttachmentId(output) {
  const match = output.match(/Attachment ID:\s*([0-9a-f-]{36})/i);
  return match?.[1] || null;
}

function messageBody(payload) {
  const sender = payload.sender_name
    ? `${payload.sender_name} (\`${payload.sender_open_id || 'unknown'}\`)`
    : `\`${payload.sender_open_id || 'unknown'}\``;
  const chatKind = payload.chat_type || 'chat';
  const text = addNativeWakeMention(payload.text || '[empty]');
  const lines = [
    `📨 来自飞书 (${chatKind} \`${payload.chat_id || 'unknown'}\`)`,
    `发件人: ${sender}`,
    `原消息: \`${payload.message_id || 'unknown'}\`  (回复用 \`node send.mjs --reply-to ${payload.message_id || '<om_xxx>'}\`)`,
    '',
    text,
  ];
  return lines.join('\n');
}

async function uploadAttachments(payload, target) {
  const ids = [];
  for (const attachment of payload.attachments || []) {
    const localPath = attachment.local_path;
    if (!localPath || !existsSync(localPath)) continue;
    const args = ['attachment', 'upload', '--path', localPath, '--target', target];
    if (attachment.mime_type) args.push('--mime-type', attachment.mime_type);
    const res = await runRaftWithRetry(args);
    const id = extractAttachmentId(`${res.stdout}\n${res.stderr}`);
    if (id) ids.push(id);
  }
  return ids;
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw);
  const target = payload.target || process.env.BRIDGE_DEFAULT_TARGET || 'dm:@飞书';
  const attachmentIds = await uploadAttachments(payload, target);
  const args = ['message', 'send', '--target', target];
  for (const id of attachmentIds) args.push('--attachment-id', id);
  const res = await runRaftWithRetry(args, { input: messageBody(payload) });
  process.stdout.write((res.stdout || res.stderr).trim() + '\n');
}

main().catch((err) => {
  process.stderr.write(`raft-handler failed: ${err?.message || err}\n`);
  process.exit(1);
});
