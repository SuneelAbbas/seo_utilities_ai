/**
 * Scoring Module
 *
 * Aggregates results across multiple query variations and produces:
 *   - mention-rate (% of queries where the company appeared)
 *   - average-position (mean list position across mentions)
 *   - simple grade (Excellent / Good / Weak / Not Visible)
 */

import type { ParsedResult } from './parser.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface ScoreResult {
  mentionRate: number;
  averagePosition: number | null;
  grade: string;
  totalQueries: number;
  mentions: number;
}

// ─── Scoring ──────────────────────────────────────────────────────────

/**
 * Calculate the overall score from a set of per-query results.
 */
export function calculateScore(parsedResults: ParsedResult[]): ScoreResult {
  const totalQueries = parsedResults.length;
  const mentionedResults = parsedResults.filter((r) => r.mentioned);
  const mentions = mentionedResults.length;

  // ── Mention rate (%) ────────────────────────────────────────────────
  const mentionRate = totalQueries > 0 ? (mentions / totalQueries) * 100 : 0;

  // ── Average position (only from mentions that had a list position) ──
  const positions = mentionedResults
    .map((r) => r.position)
    .filter((p): p is number => p !== null && p !== undefined);

  const averagePosition =
    positions.length > 0
      ? positions.reduce((sum, p) => sum + p, 0) / positions.length
      : null;

  // ── Grade ───────────────────────────────────────────────────────────
  let grade: string;
  if (mentionRate === 0) {
    grade = 'Not Visible';
  } else if (mentionRate >= 75 && averagePosition !== null && averagePosition <= 3) {
    grade = 'Excellent';
  } else if (mentionRate >= 50) {
    grade = 'Good';
  } else if (mentionRate >= 25) {
    grade = 'Weak';
  } else {
    grade = 'Not Visible';
  }

  return {
    mentionRate: Math.round(mentionRate * 100) / 100,
    averagePosition: averagePosition !== null ? Math.round(averagePosition * 100) / 100 : null,
    grade,
    totalQueries,
    mentions,
  };
}
