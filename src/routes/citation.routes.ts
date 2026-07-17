import { Router, type Request, type Response, type NextFunction } from 'express';
import { generateQueryVariations } from '../services/promptVariationGenerator.js';
import { createProvider } from '../services/aiProvider.js';
import { parseResponse } from '../services/parser.js';
import { calculateScore } from '../services/scoring.js';

// ─── Router ──────────────────────────────────────────────────────────

const router = Router();

// ─── Request body types ──────────────────────────────────────────────

interface CitationCheckBody {
  companyName?: string;
  companyDomain?: string;
  category?: string;
  location?: string;
  model?: string;
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate the request body and throw a descriptive error if invalid.
 */
function validateBody(body: CitationCheckBody): void {
  const missing: string[] = [];
  if (!body.companyName || typeof body.companyName !== 'string') missing.push('companyName');
  if (!body.category || typeof body.category !== 'string') missing.push('category');
  if (!body.location || typeof body.location !== 'string') missing.push('location');

  if (body.model !== undefined && typeof body.model !== 'string') {
    const err = new Error("model must be a string (e.g. 'openai', 'claude', 'gemini')") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  if (missing.length > 0) {
    const err = new Error(`Missing required fields: ${missing.join(', ')}`) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
}

// ─── POST /api/citation/check ────────────────────────────────────────

router.post('/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { companyName, companyDomain, category, location, model } = req.body as CitationCheckBody;

    validateBody(req.body as CitationCheckBody);

    // Resolve the AI provider from the model field (default: "openai")
    const provider = await createProvider(model || 'openai');

    console.log(`\n━━━ Citation Check ━━━`);
    console.log(`  Company : ${companyName}`);
    console.log(`  Domain  : ${companyDomain || '(not provided)'}`);
    console.log(`  Category: ${category}`);
    console.log(`  Location: ${location}`);
    console.log(`  Model   : ${provider.name}`);

    // ── Step 1: Generate query variations ──────────────────────────
    const queries = generateQueryVariations(category!, location!);
    console.log(`  Queries : ${queries.length} variations`);

    // ── Step 2: Run each query through the selected AI provider ────
    const rawResults = [];
    for (let i = 0; i < queries.length; i++) {
      console.log(`  [${i + 1}/${queries.length}] Searching: "${queries[i]}"`);
      const result = await provider.runWebSearch(queries[i]!);
      rawResults.push(result);
      // Small delay to avoid rate-limiting
      if (i < queries.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // ── Step 3: Parse each response ────────────────────────────────
    const parsedResults = rawResults.map((r) =>
      parseResponse(r, companyName!, companyDomain || ''),
    );

    // ── Step 4: Calculate aggregate score ──────────────────────────
    const score = calculateScore(parsedResults);

    // ── Step 5: Build response ─────────────────────────────────────
    const report = {
      success: true,
      request: { companyName, companyDomain, category, location, model: provider.name },
      score,
      details: parsedResults.map((r) => ({
        query: r.query,
        mentioned: r.mentioned,
        position: r.position,
        context: r.context,
      })),
      rawResponses: rawResults.map((r) => ({
        query: r.query,
        text: r.raw,
        citations: r.citations,
        model: r.model,
      })),
    };

    console.log(`  → Grade: ${score.grade} (${score.mentionRate}% mentions)`);
    console.log(`━━━━━━━━━━━━━━━━━━\n`);

    res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
