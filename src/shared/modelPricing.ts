/**
 * Model pricing lookup for cost estimation.
 * Prices are per token in USD, sourced from public Anthropic pricing.
 * Used as a fallback when direct cost is not available from the provider.
 */

interface ModelPrice {
  input_per_token: number;
  output_per_token: number;
}

// Prices in USD per token (not per million tokens)
const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-4-20250514": { input_per_token: 3e-6, output_per_token: 15e-6 },
  "claude-opus-4-20250514": { input_per_token: 15e-6, output_per_token: 75e-6 },
  "claude-3-5-sonnet-20241022": { input_per_token: 3e-6, output_per_token: 15e-6 },
  "claude-3-5-haiku-20241022": { input_per_token: 0.8e-6, output_per_token: 4e-6 },
  "claude-3-opus-20240229": { input_per_token: 15e-6, output_per_token: 75e-6 },
  "claude-3-haiku-20240307": { input_per_token: 0.25e-6, output_per_token: 1.25e-6 },
};

// Fallback prefixes: match "claude-sonnet-4-*" style model strings
const PREFIX_PRICES: Array<{ prefix: string; price: ModelPrice }> = [
  { prefix: "claude-sonnet-4", price: MODEL_PRICES["claude-sonnet-4-20250514"] },
  { prefix: "claude-opus-4", price: MODEL_PRICES["claude-opus-4-20250514"] },
  { prefix: "claude-3-5-sonnet", price: MODEL_PRICES["claude-3-5-sonnet-20241022"] },
  { prefix: "claude-3-5-haiku", price: MODEL_PRICES["claude-3-5-haiku-20241022"] },
  { prefix: "claude-3-opus", price: MODEL_PRICES["claude-3-opus-20240229"] },
  { prefix: "claude-3-haiku", price: MODEL_PRICES["claude-3-haiku-20240307"] },
];

function findPrice(model: string): ModelPrice | null {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  for (const { prefix, price } of PREFIX_PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

/**
 * Compute estimated cost in USD from token counts and model name.
 * Returns null if the model is unknown.
 */
export function computeTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = findPrice(model);
  if (!price) return null;
  return inputTokens * price.input_per_token + outputTokens * price.output_per_token;
}
