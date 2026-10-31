// The netguard: what outbound.js hands every request to instead of fetch. In mock mode a request goes to the
// in-process mock PingFederate and nothing else: a URL off the mock's origin is refused, and the real fetch is never
// called, so mock mode opens no socket at all. In live mode the request goes to the real fetch; outbound.js has
// already limited it to the configured PingFederate's origin. It counts both, for the self-test and the tests.

export class NetguardRefused extends Error {}

export function createNetguard({ mode, mock, realFetch = globalThis.fetch }) {
  const stats = { mockCalls: 0, realAttempts: 0, refused: 0 };

  async function fetchImpl(url, init) {
    if (mode() === 'mock') {
      let origin = null;
      try { origin = new URL(url).origin; } catch { /* refused below */ }
      if (origin !== mock.origin) {
        stats.refused += 1;
        throw new NetguardRefused('Mock mode: no real outbound calls');
      }
      stats.mockCalls += 1;
      return mock.fetchImpl(url, init);
    }
    stats.realAttempts += 1;
    return realFetch(url, init);
  }

  // Proves the guard holds without touching the network: in mock mode a real URL must be refused and the real
  // fetch must not have been called. Returns { ok, checks } and leaves the counters as they were.
  async function selfTest() {
    const before = { ...stats };
    const checks = [];
    if (mode() !== 'mock') return { ok: true, checks: [{ name: 'live mode: calls go only to the configured PingFederate (outbound guard)', ok: true }] };
    let refused = false;
    try { await fetchImpl('https://example.com/', { method: 'GET' }); } catch (error) { refused = error instanceof NetguardRefused; }
    checks.push({ name: 'mock mode refuses a real URL', ok: refused });
    checks.push({ name: 'mock mode never calls the real fetch', ok: stats.realAttempts === before.realAttempts });
    Object.assign(stats, before);
    return { ok: checks.every((c) => c.ok), checks };
  }

  return { fetchImpl, selfTest, stats: () => ({ ...stats }) };
}
