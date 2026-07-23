import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStateStore } from '../state-store.mjs';

test('releases a dedupe reservation after a failed dispatch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'raft-feishu-state-'));
  const file = path.join(dir, 'state.json');
  const store = new JsonStateStore(file, { flushDelayMs: 60_000 });

  assert.equal(store.isDuplicate('om_test'), false);
  assert.equal(store.isDuplicate('om_test'), true);

  store.releaseSeen('om_test');
  await store.flush();

  assert.equal(store.isDuplicate('om_test'), false);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.seen_messages.om_test, undefined);

  store.releaseSeen('om_test');
  await store.flush();
});
