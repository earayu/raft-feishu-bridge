#!/usr/bin/env node
// feishu-command.mjs — structured command entrypoint for Raft -> Feishu.
//
// Example:
//   echo '{"action":"send_text","reply_to":"om_xxx","text":"hello"}' | node feishu-command.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (body += chunk));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(body));
  });
}

function runNode(script, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
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
      else reject(new Error(`${script} exit=${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(input ?? '');
  });
}

function destinationArgs(command) {
  if (command.reply_to) return ['--reply-to', command.reply_to];
  if (command.chat_id) return ['--chat-id', command.chat_id];
  if (command.open_id) return ['--open-id', command.open_id];
  if (command.user_id) return ['--user-id', command.user_id];
  if (command.email) return ['--email', command.email];
  throw new Error('command must include one destination: reply_to, chat_id, open_id, user_id, or email');
}

async function main() {
  const raw = process.argv.includes('--json')
    ? process.argv[process.argv.indexOf('--json') + 1]
    : await readStdin();
  const command = JSON.parse(raw);
  let out;
  if (command.action === 'send_text') {
    if (!command.text) throw new Error('send_text requires text');
    out = await runNode('send.mjs', [...destinationArgs(command), '--stdin'], command.text);
  } else if (command.action === 'send_image') {
    if (!command.path) throw new Error('send_image requires path');
    out = await runNode('send-image.mjs', [command.path, ...destinationArgs(command)]);
  } else if (command.action === 'send_file') {
    if (!command.path) throw new Error('send_file requires path');
    if (!command.chat_id && !command.reply_to) throw new Error('send_file requires chat_id or reply_to');
    out = await runNode('send-file.mjs', [command.path, command.chat_id || '', command.reply_to || '']);
  } else {
    throw new Error(`unknown action: ${command.action}`);
  }
  process.stdout.write(out + '\n');
}

main().catch((err) => {
  process.stderr.write(`feishu-command failed: ${err?.message || err}\n`);
  process.exit(1);
});
