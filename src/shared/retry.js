// Retry an async operation with jittered exponential backoff. Defaults are
// tuned for the CTA APIs: 3 attempts spaced ~0.5s, ~1.2s. A single transient
// 5xx or socket reset shouldn't kill a whole detection cycle.
async function withRetry(fn, { attempts = 3, baseMs = 500, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const wait = baseMs * (2 ** i) + Math.floor(Math.random() * baseMs);
      console.warn(`${label} attempt ${i + 1}/${attempts} failed (${e.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
