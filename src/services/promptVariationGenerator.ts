/**
 * Prompt-Variation Generator
 *
 * Given a category (e.g. "Emergency Plumber") and location (e.g. "Atlanta"),
 * produces 3–5 different phrasings that mimic how real users search.
 * These are used as queries for the AI web_search tool.
 */

/**
 * Generate query variations from a category + location pair.
 *
 * @param category  — e.g. "Emergency Plumber"
 * @param location  — e.g. "Atlanta"
 * @returns array of 3–5 query strings
 */
export function generateQueryVariations(category: string, location: string): string[] {
  const queries = new Set<string>();

  // 1. Direct "[category] in [location]"
  queries.add(`${category} in ${location}`);

  // 2. "Best [category] in [location]"
  queries.add(`Best ${category} in ${location}`);

  // 3. "Top-rated [category] near [location]"
  queries.add(`Top-rated ${category} near ${location}`);

  // 4. "[category] [location] — reviews"
  queries.add(`${category} ${location} reviews`);

  // 5. "Affordable ${category} ${location}"
  queries.add(`Affordable ${category} ${location}`);

  // 6. "[location] [category] services"
  queries.add(`${location} ${category} services`);

  // 7. "Who offers ${category.toLowerCase()} in ${location}?"
  queries.add(`Who offers ${category.toLowerCase()} in ${location}`);

  return Array.from(queries).slice(0, 5);
}
