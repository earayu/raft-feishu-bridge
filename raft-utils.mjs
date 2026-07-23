const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

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
