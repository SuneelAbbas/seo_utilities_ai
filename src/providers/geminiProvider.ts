/**
 * Gemini Provider (Google)
 *
 * 🔧 STUB — Not yet implemented.
 *
 * To implement:
 *   1. Install: npm install @google/generative-ai
 *   2. Add GEMINI_API_KEY to .env
 *   3. Implement the Google AI SDK client with Google Search grounding
 *   4. Update this file with the real implementation
 *
 * Gemini supports "google_search" grounding in the GenerateContent API,
 * which can be used as an alternative to OpenAI's web_search_preview.
 */

import { AIProvider, type WebSearchResult, ProviderError } from '../services/aiProvider.js';

export class GeminiProvider extends AIProvider {
  private _client: any = null;

  private getClient(): any {
    if (!this._client) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'your-gemini-api-key-here') {
        throw new ProviderError(
          'GEMINI_API_KEY is not configured. Set it in the .env file.',
          500,
        );
      }

      // TODO: Uncomment when @google/generative-ai is installed
      // const { GoogleGenerativeAI } = require("@google/generative-ai");
      // this._client = new GoogleGenerativeAI(apiKey);

      throw new ProviderError(
        'Gemini provider is not yet implemented. ' +
          'Install @google/generative-ai and implement runWebSearch().',
        501,
      );
    }
    return this._client;
  }

  async runWebSearch(query: string): Promise<WebSearchResult> {
    this.getClient(); // Will throw 501 until implemented

    return {
      query,
      raw: '',
      citations: [],
      model: 'gemini',
    };
  }
}
