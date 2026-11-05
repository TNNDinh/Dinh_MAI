import type { ModelPricing, TokenUsage } from './types'

/**
 * Estimated cost in USD, or `null` when the price is unknown.
 *
 * Prices are deliberately NOT hardcoded: they change often and a wrong number
 * presented as fact is worse than "unknown". Pricing comes from (a) the provider
 * itself when it publishes it (OpenRouter), or (b) the user-editable
 * `model_pricing` table. Local models (Ollama) are passed `{0, 0}` by the caller.
 */
export function estimateCostUsd(usage: TokenUsage, pricing: ModelPricing | undefined | null): number | null {
  if (!pricing) return null
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) || undefined
  }
}
