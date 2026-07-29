import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNativeWakeMention,
  collectMutedChats,
  isChatMuted,
  isMuteTarget,
  raftChildEnv,
  withRetry,
} from '../raft-utils.mjs';

test('isMuteTarget recognizes mute sentinels case-insensitively', () => {
  assert.equal(isMuteTarget('mute'), true);
  assert.equal(isMuteTarget('MUTE'), true);
  assert.equal(isMuteTarget('__mute__'), true);
  assert.equal(isMuteTarget('drop'), true);
  assert.equal(isMuteTarget('discard'), true);
  assert.equal(isMuteTarget('dm:@飞书'), false);
  assert.equal(isMuteTarget(null), false);
});

test('collectMutedChats unions env, _mute list, and mute-target entries', () => {
  const muted = collectMutedChats(
    {
      _mute: ['oc_from_list'],
      _muted: ['oc_from_alias'],
      oc_mapped: 'mute',
      oc_live: 'dm:@飞书',
      _comment: 'ignored',
    },
    { BRIDGE_MUTED_CHATS: 'oc_from_env, oc_from_list' },
  );
  assert.deepEqual(
    [...muted].sort(),
    ['oc_from_alias', 'oc_from_env', 'oc_from_list', 'oc_mapped'].sort(),
  );
});

test('isChatMuted checks set and routing sentinel', () => {
  const muted = new Set(['oc_a']);
  const routing = { oc_b: 'mute', oc_c: 'dm:@x' };
  assert.equal(isChatMuted('oc_a', routing, muted), true);
  assert.equal(isChatMuted('oc_b', routing, muted), true);
  assert.equal(isChatMuted('oc_c', routing, muted), false);
  assert.equal(isChatMuted('unknown', routing, muted), false);
});

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
