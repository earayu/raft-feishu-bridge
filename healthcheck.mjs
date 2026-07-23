#!/usr/bin/env node
// healthcheck.mjs — startup and cron-friendly checks for the bridge.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { raftChildEnv } from './raft-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args, { input, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function notify(message) {
  const target = process.env.BRIDGE_HEALTH_NOTIFY_TARGET;
  if (!target) return;
  const raft = process.env.RAFT_BIN || 'raft';
  await run(raft, ['message', 'send', '--target', target], {
    input: message,
    env: raftChildEnv(),
  });
}

async function main() {
  const failures = [];
  const appFile = path.join(__dirname, 'app.json');
  if (!existsSync(appFile)) failures.push(`missing ${appFile}`);
  else {
    try {
      const app = JSON.parse(await readFile(appFile, 'utf8'));
      if (!app.app_id || !app.app_secret) failures.push('app.json missing app_id/app_secret');
    } catch (err) {
      failures.push(`app.json parse failed: ${err.message}`);
    }
  }

  const target = process.env.BRIDGE_DEFAULT_TARGET || '';
  if (!target || target === 'default') failures.push('BRIDGE_DEFAULT_TARGET should be a real Raft target, e.g. dm:@飞书');

  const handler = process.env.AGENT_HANDLER_CMD || process.env.AGENT_HANDLER_WEBHOOK || '';
  if (!handler) failures.push('AGENT_HANDLER_CMD or AGENT_HANDLER_WEBHOOK is required for production');

  if (process.env.AGENT_HANDLER_CMD || process.env.RAFT_PROFILE) {
    const raft = process.env.RAFT_BIN || 'raft';
    const who = await run(raft, ['profile', 'show'], { env: raftChildEnv() });
    if (!who.ok) failures.push(`raft auth failed: ${(who.stderr || who.stdout).trim()}`);
  }

  if (failures.length) {
    const message = `🚨 raft-feishu-bridge healthcheck failed\n\n${failures.map((f) => `- ${f}`).join('\n')}`;
    await notify(message);
    process.stderr.write(message + '\n');
    process.exit(1);
  }

  process.stdout.write('raft-feishu-bridge healthcheck OK\n');
}

main().catch(async (err) => {
  const message = `🚨 raft-feishu-bridge healthcheck crashed: ${err?.message || err}`;
  await notify(message);
  process.stderr.write(message + '\n');
  process.exit(1);
});
