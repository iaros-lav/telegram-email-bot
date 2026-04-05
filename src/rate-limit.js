export function createRateLimiter({ windowMs, maxHits }) {
  const hitsByKey = new Map();

  return {
    check(key) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const currentHits = (hitsByKey.get(key) || []).filter((hit) => hit > windowStart);

      if (currentHits.length >= maxHits) {
        hitsByKey.set(key, currentHits);
        const retryAfterMs = Math.max(windowMs - (now - currentHits[0]), 0);
        return {
          ok: false,
          retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1000), 1)
        };
      }

      currentHits.push(now);
      hitsByKey.set(key, currentHits);

      return {
        ok: true,
        retryAfterSeconds: 0
      };
    }
  };
}
