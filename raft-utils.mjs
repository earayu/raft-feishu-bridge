const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/** routing.json target values that mean "do not deliver to Raft". */
export const MUTE_TARGETS = new Set(['mute', '__mute__', 'drop', 'discard']);

export function isMuteTarget(target) {
  return typeof target === 'string' && MUTE_TARGETS.has(target.trim().toLowerCase());
}

/**
 * Collect muted Feishu chat_ids from env + routing.json document.
 *
 * Sources (union):
 *   - BRIDGE_MUTED_CHATS env: comma-separated chat_ids
 *   - routing.json "_mute" / "_muted" array
 *   - routing entries whose value is a mute sentinel (mute|__mute__|drop|discard)
 */
export function collectMutedChats(routingDoc = {}, env = process.env) {
  const muted = new Set();
  for (const id of String(env.BRIDGE_MUTED_CHATS || '').split(',')) {
    const t = id.trim();
    if (t) muted.add(t);
  }
  for (const key of ['_mute', '_muted']) {
    const list = routingDoc?.[key];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (typeof id === 'string' && id.trim()) muted.add(id.trim());
    }
  }
  if (routingDoc && typeof routingDoc === 'object') {
    for (const [k, v] of Object.entries(routingDoc)) {
      if (k.startsWith('_')) continue;
      if (isMuteTarget(v)) muted.add(k);
    }
  }
  return muted;
}

export function isChatMuted(chatId, routing = {}, mutedSet = new Set()) {
  if (!chatId || chatId === 'unknown') return false;
  if (mutedSet.has(chatId)) return true;
  return isMuteTarget(routing[chatId]);
}

export function raftChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const proxy = baseEnv.RAFT_HTTP_PROXY || '';
  if (proxy) {
    for (const key of PROXY_KEYS) env[key] = proxy;
  }
  return env;
}

export function addNativeWakeMention(
  text,
  {
    wakeHandle = process.env.BRIDGE_WAKE_HANDLE || '',
    wakeNames = process.env.BRIDGE_WAKE_NAMES || '',
  } = {},
) {
  if (!text || !wakeHandle || !wakeNames) return text;
  const names = String(wakeNames)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const explicitlyAddressed = names.some((name) => text.includes(`@${name}`));
  if (!explicitlyAddressed || text.includes(wakeHandle)) return text;
  return `${wakeHandle}\n${text}`;
}

export async function withRetry(
  operation,
  {
    delaysMs = [0, 1000, 3000, 10000],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onError = async () => {},
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt]) await sleep(delaysMs[attempt]);
    try {
      return await operation(attempt + 1);
    } catch (error) {
      lastError = error;
      await onError(error, attempt + 1, delaysMs.length);
    }
  }
  throw lastError;
}
