/**
 * AI Provider Abstraction Layer
 *
 * Defines a base interface that all AI model providers must implement.
 * The factory function `createProvider()` returns the correct provider
 * instance based on the `model` field from the API payload.
 *
 * To add a new provider:
 *   1. Create a new file in src/providers/<name>Provider.ts
 *   2. Implement the `runWebSearch(query)` method
 *   3. Register it in the `createProvider()` switch below
 *   4. Add the corresponding API key to .env
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface WebSearchResult {
  query: string;
  raw: string;
  citations: Array<{ url: string; title: string }>;
  model: string;
}

export interface ProviderConfig {
  [key: string]: string | undefined;
}

// ─── Abstract base class ──────────────────────────────────────────────

/**
 * Abstract base class for AI providers.
 * All providers must extend this and implement `runWebSearch(query)`.
 */
export abstract class AIProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig = {}) {
    this.config = config;
  }

  /**
   * Run a single web-search query using the provider's model.
   */
  abstract runWebSearch(query: string): Promise<WebSearchResult>;

  /**
   * Human-readable provider name (used in logs / responses).
   */
  get name(): string {
    return this.constructor.name.replace('Provider', '').toLowerCase();
  }
}

// ─── Error helper ─────────────────────────────────────────────────────

export class ProviderError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create an AI provider instance for the given model name.
 * Uses lazy dynamic imports to avoid circular-dependency issues.
 *
 * @param model - One of "openai", "claude", "gemini"
 * @returns AIProvider instance
 */
export async function createProvider(model: string = 'openai'): Promise<AIProvider> {
  const key = model.toLowerCase().trim();

  switch (key) {
    case 'openai': {
      const { OpenAIProvider } = await import('../providers/openaiProvider.js');
      return new OpenAIProvider();
    }
    case 'claude': {
      const { ClaudeProvider } = await import('../providers/claudeProvider.js');
      return new ClaudeProvider();
    }
    case 'gemini': {
      const { GeminiProvider } = await import('../providers/geminiProvider.js');
      return new GeminiProvider();
    }
    default:
      throw new ProviderError(
        `Unsupported model: "${model}". Supported models: openai, claude, gemini`,
        400,
      );
  }
}
