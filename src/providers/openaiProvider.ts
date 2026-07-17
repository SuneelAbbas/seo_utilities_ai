/**
 * OpenAI Provider
 *
 * Uses the OpenAI Responses API with the web_search_preview tool enabled.
 * This allows the model to search the web in real-time and return
 * results as if a user searched for a local business.
 */

import OpenAI from 'openai';
import { AIProvider, type WebSearchResult, ProviderError } from '../services/aiProvider.js';

export class OpenAIProvider extends AIProvider {
  private _client: OpenAI | null = null;

  /**
   * Get (or create) the singleton OpenAI client.
   */
  private getClient(): OpenAI {
    if (!this._client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey || apiKey === 'sk-your-openai-api-key-here') {
        throw new ProviderError(
          'OPENAI_API_KEY is not configured. Set it in the .env file.',
          500,
        );
      }
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  /**
   * Run a single web-search query via ChatGPT (gpt-4o / Responses API).
   */
  async runWebSearch(query: string): Promise<WebSearchResult> {
    const client = this.getClient();

    const response = await client.responses.create({
      model: 'gpt-4o',
      tools: [
        {
          type: 'web_search_preview' as any,
          user_location: {
            type: 'approximate' as any,
            country: 'US',
          },
        },
      ],
      input: query,
      temperature: 0.3,
    });

    // Extract the main output text
    const outputText =
      (response as any).output_text ||
      (response as any).output
        ?.filter((m: any) => m.type === 'message')
        .map((m: any) =>
          m.content
            ?.filter((c: any) => c.type === 'output_text')
            .map((c: any) => c.text)
            .join('\n'),
        )
        .join('\n') || '';

    // Collect any citation / source annotations
    const citations: Array<{ url: string; title: string }> = [];
    if ((response as any).output) {
      for (const msg of (response as any).output) {
        if (msg.type === 'message' && msg.content) {
          for (const c of msg.content) {
            if (c.type === 'output_text' && c.annotations) {
              for (const ann of c.annotations) {
                if (ann.type === 'url_citation') {
                  citations.push({
                    url: ann.url_citation.url,
                    title: ann.url_citation.title || '',
                  });
                }
              }
            }
          }
        }
      }
    }

    return {
      query,
      raw: outputText,
      citations,
      model: 'openai',
    };
  }
}
