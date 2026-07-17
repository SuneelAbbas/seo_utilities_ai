import type { Request, Response, NextFunction } from 'express';

/**
 * API-key authentication middleware — shared across ALL routes.
 *
 * Clients must provide the key in the `x-api-key` header.
 * The expected key is read from the `CRAWLER_API_KEY` environment variable.
 *
 * If `CRAWLER_API_KEY` is not set, the middleware returns a 503 to indicate
 * the server is misconfigured (rather than silently allowing all traffic).
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.CRAWLER_API_KEY;

  // If no API key is configured, refuse to serve (misconfiguration)
  if (!apiKey || apiKey === 'change-me-to-a-random-secret') {
    res.status(503).json({
      success: false,
      error: 'Server misconfiguration: CRAWLER_API_KEY is not set. Please configure it in your environment.',
    });
    return;
  }

  const providedKey = req.headers['x-api-key'] as string | undefined;

  if (!providedKey) {
    res.status(401).json({
      success: false,
      error: 'Missing authentication. Provide your API key via the x-api-key header.',
    });
    return;
  }

  if (providedKey !== apiKey) {
    res.status(403).json({
      success: false,
      error: 'Invalid API key.',
    });
    return;
  }

  next();
}
