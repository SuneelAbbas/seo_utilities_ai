import type { Request, Response, NextFunction } from 'express';

/**
 * Central error-handling middleware — shared across ALL routes.
 *
 * Catches any thrown or next(err) errors and returns a consistent JSON shape.
 * Attach a `statusCode` property to your error to control the HTTP status.
 */
export function errorHandler(
  err: Error & { statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  console.error(`[ERROR] ${statusCode} — ${message}`);
  if (statusCode === 500) {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  });
}
