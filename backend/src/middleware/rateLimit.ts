import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redis } from '../lib/redis.js';

const PUBLIC_POINTS = 100;
const PUBLIC_DURATION_SEC = 60;
const DEFAULT_PARTNER_POINTS = 1000;
const PARTNER_DURATION_SEC = 60;

const publicLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:public',
  points: PUBLIC_POINTS,
  duration: PUBLIC_DURATION_SEC,
});

// Default partner limiter — used when no per-key override is needed
const defaultPartnerLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:partner',
  points: DEFAULT_PARTNER_POINTS,
  duration: PARTNER_DURATION_SEC,
});

/** Returns a per-key limiter when the key has a custom rateLimit value. */
function getPartnerLimiter(_keyId: string, points: number): RateLimiterRedis {
  if (points === DEFAULT_PARTNER_POINTS) return defaultPartnerLimiter;
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:partner:${points}`,
    points,
    duration: PARTNER_DURATION_SEC,
  });
}

function getRateLimitKey(req: Request): string {
  if (req.authenticated && req.authenticatedKeyId) {
    return `apikey:${req.authenticatedKeyId}`;
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Tiered rate limit:
 *   - Public (unauthenticated): 100 req/min by IP
 *   - Partner (authenticated API key): per-key rateLimit from DB (default 1000 req/min)
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = getRateLimitKey(req);

  let limiter: RateLimiterRedis;
  if (req.authenticated && req.authenticatedKeyId) {
    const points = req.apiKeyRateLimit ?? DEFAULT_PARTNER_POINTS;
    limiter = getPartnerLimiter(req.authenticatedKeyId, points);
  } else {
    limiter = publicLimiter;
  }

  limiter
    .consume(key)
    .then(() => next())
    .catch((rejRes) => {
      if (rejRes instanceof Error) {
        res.status(503).json({
          error: 'Rate limit unavailable',
          message: 'Service temporarily unable to check rate limit. Try again later.',
        });
        return;
      }
      const secs = Math.round(((rejRes as { msBeforeNext?: number }).msBeforeNext ?? 1000) / 1000) || 1;
      res.set('Retry-After', String(secs));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${secs} seconds.`,
      });
    });
}
