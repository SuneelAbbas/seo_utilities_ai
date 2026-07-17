/**
 * Response Parser
 *
 * Given the raw AI output text and the target company name + domain,
 * performs:
 *   1. Fuzzy-match — does the company appear in the response?
 *   2. Position detection — if a numbered/bulleted list, where in the list?
 *   3. Context extraction — surrounding sentences around the match.
 *
 * Uses simple string heuristics (no heavy NLP libraries needed).
 */

import type { WebSearchResult } from './aiProvider.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface ParsedResult {
  query: string;
  mentioned: boolean;
  position: number | null;
  context: string | null;
  matchSnippet: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize text for comparison: lowercase, strip punctuation.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Simple fuzzy match: returns true if `name` or `domain` appears in `text`
 * considering partial / case-insensitive matching.
 */
export function fuzzyMatch(text: string, companyName: string, companyDomain: string): boolean {
  const normText = normalize(text);

  // Try exact normalized company name
  if (normText.includes(normalize(companyName))) return true;

  // Try domain (without TLD) as a weaker signal
  const domainSlug = companyDomain
    ?.replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .split('.')[0];
  if (domainSlug && normText.includes(domainSlug.toLowerCase())) return true;

  // Try individual significant words from company name (skip common words)
  const skipWords = new Set(['the', 'and', 'a', 'of', 'in', 'at', 'for', 'to', 'is', 'on', 'by']);
  const words = companyName
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !skipWords.has(w) && w.length > 2);

  const matches = words.filter((w) => normText.includes(w));
  // At least 60% of significant words must match
  return words.length > 0 && matches.length / words.length >= 0.6;
}

/**
 * Try to extract a company entry's position within a list in the text.
 * Returns `null` if no list context found.
 *
 * Detects numbered lists (1., 2., …) and bulleted lists (•, -, *).
 */
function detectListPosition(text: string, matchIndex: number): number | null {
  // Look for a numbered list item near the match
  // Get ~500 chars before the match to find the list header
  const before = text.slice(Math.max(0, matchIndex - 500), matchIndex);

  // Try numbered list: pattern like "1. Name\n2. Name\n3. OurCompany"
  const numberedRegex = /^\s*(\d+)\.\s+/gm;
  let match: RegExpExecArray | null;
  let lastNumber: number | null = null;
  let lastIndex = -1;
  while ((match = numberedRegex.exec(before)) !== null) {
    lastNumber = parseInt(match[1]!, 10);
    lastIndex = match.index;
  }

  // If the last numbered item is within 100 chars of our match, use its number
  if (lastNumber !== null && matchIndex - lastIndex < 200) {
    return lastNumber;
  }

  // Try bulleted list: count bullet items before the match
  const bulletCount = (before.match(/^[\s]*[•\-*]\s+/gm) || []).length;
  if (bulletCount > 0) {
    return bulletCount;
  }

  return null;
}

/**
 * Extract surrounding context (≈2 sentences before and after) around a match.
 */
function extractContext(text: string, matchIndex: number, contextChars = 400): string {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + contextChars);
  let snippet = text.slice(start, end);

  // Try to clean up at sentence boundaries
  if (start > 0) {
    const firstPeriod = snippet.indexOf('. ');
    if (firstPeriod > 0 && firstPeriod < 100) {
      snippet = snippet.slice(firstPeriod + 2);
    }
  }
  if (end < text.length) {
    const lastPeriod = snippet.lastIndexOf('.');
    if (lastPeriod > snippet.length - 150) {
      snippet = snippet.slice(0, lastPeriod + 1);
    }
  }

  return snippet.trim();
}

// ─── Main parser ──────────────────────────────────────────────────────

/**
 * Parse a single AI response for company mentions.
 *
 * @param result       — output from runWebSearch()
 * @param companyName  — e.g. "Roto-Rooter"
 * @param companyDomain — e.g. "rotorooter.com"
 * @returns ParsedResult object
 */
export function parseResponse(
  result: WebSearchResult,
  companyName: string,
  companyDomain: string,
): ParsedResult {
  const text = result.raw || '';

  const normName = normalize(companyName);
  const normText = normalize(text);

  // Find the first occurrence (normalized)
  const matchIdx = normText.indexOf(normName);

  if (matchIdx === -1 && !fuzzyMatch(text, companyName, companyDomain)) {
    return {
      query: result.query,
      mentioned: false,
      position: null,
      context: null,
      matchSnippet: null,
    };
  }

  // Calculate the actual character index in the original text
  const rawMatchIdx = text.toLowerCase().indexOf(companyName.toLowerCase());
  const effectiveIdx = rawMatchIdx !== -1 ? rawMatchIdx : matchIdx;

  const position = detectListPosition(text, effectiveIdx);
  const context = extractContext(text, effectiveIdx);

  // Extract a short match snippet (first 120 chars around match)
  const snippetStart = Math.max(0, effectiveIdx - 40);
  const snippetEnd = Math.min(text.length, effectiveIdx + 80);
  const matchSnippet = text.slice(snippetStart, snippetEnd).trim();

  return {
    query: result.query,
    mentioned: true,
    position,
    context,
    matchSnippet,
  };
}
