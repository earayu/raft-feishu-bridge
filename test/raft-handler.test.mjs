import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runHandler(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['raft-handler.mjs'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('raft handler emits the native wake handle in the forwarded message', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'raft-handler-test-'));
  const capture = path.join(dir, 'stdin.txt');
  const fakeRaft = path.join(dir, 'raft');
  await writeFile(
    fakeRaft,
    `#!/bin/sh\ncat > '${capture}'\necho 'Message sent'\n`,
  );
  await chmod(fakeRaft, 0o755);

  const result = await runHandler(
    {
      target: 'dm:@飞书',
      chat_id: 'oc_test',
      chat_type: 'group',
      message_id: 'om_test',
      sender_name: 'Tester',
      sender_open_id: 'ou_test',
      text: '@张一鸣 请处理',
      attachments: [],
    },
    {
      RAFT_BIN: fakeRaft,
      BRIDGE_WAKE_HANDLE: '@飞书',
      BRIDGE_WAKE_NAMES: '张一鸣',
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(capture, 'utf8'), /@飞书\n@张一鸣 请处理/);
});
