import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNativeWakeMention,
  raftChildEnv,
  withRetry,
} from '../raft-utils.mjs';

test('adds a stable Raft handle for a configured Feishu display-name mention', () => {
  assert.equal(
    addNativeWakeMention('@张一鸣 请处理', {
      wakeHandle: '@飞书',
      wakeNames: '张一鸣,Bridge Bot',
    }),
    '@飞书\n@张一鸣 请处理',
  );
});

test('does not alter ordinary text or duplicate an existing native handle', () => {
  assert.equal(
    addNativeWakeMention('普通讨论', {
      wakeHandle: '@飞书',
      wakeNames: '张一鸣',
    }),
    '普通讨论',
  );
  assert.equal(
    addNativeWakeMention('@飞书\n@张一鸣 请处理', {
      wakeHandle: '@飞书',
      wakeNames: '张一鸣',
    }),
    '@飞书\n@张一鸣 请处理',
  );
});

test('adds RAFT_HTTP_PROXY only to the Raft child environment', () => {
  const env = raftChildEnv({
    RAFT_HTTP_PROXY: 'http://127.0.0.1:8118',
    HTTPS_PROXY: '',
  });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:8118');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8118');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:8118');
});

test('retries with the configured delays and returns the successful result', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error(`transient-${calls}`);
      return 'ok';
    },
    {
      delaysMs: [0, 1, 3],
      sleep: async (ms) => sleeps.push(ms),
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1, 3]);
});
