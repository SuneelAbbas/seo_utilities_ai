/**
 * Claude Provider (Anthropic)
 *
 * 🔧 STUB — Not yet implemented.
 *
 * To implement:
 *   1. Install: npm install @anthropic-ai/sdk
 *   2. Add ANTHROPIC_API_KEY to .env
 *   3. Implement the Anthropic SDK client and web-search equivalent
 *   4. Update this file with the real implementation
 *
 * Claude does not have a built-in web_search tool like OpenAI.
 * You would need to use the Tool Use feature with a custom web search
 * function or use the Messages API with a search-enabled configuration.
 */

import { AIProvider, type WebSearchResult, ProviderError } from '../services/aiProvider.js';

export class ClaudeProvider extends AIProvider {
  private _client: any = null;

  private getClient(): any {
    if (!this._client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey === 'sk-ant-your-anthropic-api-key-here') {
        throw new ProviderError(
          'ANTHROPIC_API_KEY is not configured. Set it in the .env file.',
          500,
        );
      }

      // TODO: Uncomment when @anthropic-ai/sdk is installed
      // const { Anthropic } = require("@anthropic-ai/sdk");
      // this._client = new Anthropic({ apiKey });

      throw new ProviderError(
        'Claude provider is not yet implemented. ' +
          'Install @anthropic-ai/sdk and implement runWebSearch().',
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
      model: 'claude',
    };
  }
}
