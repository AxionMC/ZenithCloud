import type { DatabaseSync } from "node:sqlite";
import { getSetting } from "./database.js";

/**
 * 内置模型计费表（人民币 / 1M tokens，输入与输出分开）。
 * 覆盖 OpenAI、Claude、DeepSeek 常用模型；管理员可用后台 model_pricing 覆盖。
 *
 * 内置价格按 1 美元 ≈ 7.2 元人民币折算（2026-10）。
 * 计费口径：1 个额度 token = 1.08 元 / 1M tokens（与 gpt-4o-mini 输入价对齐）。
 * 扣减额度 = ceil((输入费用 + 输出费用) / 1.08e-6 × billing_markup)。
 */

export interface ModelPricing {
  /** 输入价格（人民币 / 1M tokens）。 */
  inputPerMillion: number;
  /** 输出价格（人民币 / 1M tokens）。 */
  outputPerMillion: number;
}

/** 1 个额度 token 对应的人民币价格（元 / 1M tokens）。 */
const BASE_CNY_PER_MILLION = 1.08;

const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // OpenAI
  "gpt-4o": { inputPerMillion: 18, outputPerMillion: 72 },
  "gpt-4o-mini": { inputPerMillion: 1.08, outputPerMillion: 4.32 },
  "gpt-4.1": { inputPerMillion: 14.4, outputPerMillion: 57.6 },
  "gpt-4.1-mini": { inputPerMillion: 2.88, outputPerMillion: 11.52 },
  "gpt-4.1-nano": { inputPerMillion: 0.72, outputPerMillion: 2.88 },
  "gpt-4-turbo": { inputPerMillion: 72, outputPerMillion: 216 },
  "gpt-4": { inputPerMillion: 216, outputPerMillion: 432 },
  "gpt-3.5-turbo": { inputPerMillion: 3.6, outputPerMillion: 10.8 },
  o1: { inputPerMillion: 108, outputPerMillion: 432 },
  "o1-mini": { inputPerMillion: 7.92, outputPerMillion: 31.68 },
  o3: { inputPerMillion: 14.4, outputPerMillion: 57.6 },
  "o3-mini": { inputPerMillion: 7.92, outputPerMillion: 31.68 },
  "o4-mini": { inputPerMillion: 7.92, outputPerMillion: 31.68 },

  // Anthropic Claude
  "claude-opus-4-1": { inputPerMillion: 108, outputPerMillion: 540 },
  "claude-opus-4": { inputPerMillion: 108, outputPerMillion: 540 },
  "claude-sonnet-4-5": { inputPerMillion: 21.6, outputPerMillion: 108 },
  "claude-sonnet-4": { inputPerMillion: 21.6, outputPerMillion: 108 },
  "claude-3-7-sonnet": { inputPerMillion: 21.6, outputPerMillion: 108 },
  "claude-3-5-sonnet": { inputPerMillion: 21.6, outputPerMillion: 108 },
  "claude-3-5-haiku": { inputPerMillion: 5.76, outputPerMillion: 28.8 },
  "claude-haiku-4-5": { inputPerMillion: 7.2, outputPerMillion: 36 },
  "claude-3-opus": { inputPerMillion: 108, outputPerMillion: 540 },
  "claude-3-haiku": { inputPerMillion: 1.8, outputPerMillion: 9 },

  // DeepSeek
  "deepseek-chat": { inputPerMillion: 2.016, outputPerMillion: 3.024 },
  "deepseek-reasoner": { inputPerMillion: 2.016, outputPerMillion: 3.024 },
  "deepseek-v3": { inputPerMillion: 2.016, outputPerMillion: 3.024 },
  "deepseek-r1": { inputPerMillion: 3.96, outputPerMillion: 15.768 },
};

const PRICING_PATTERNS = Object.keys(DEFAULT_MODEL_PRICING).sort(
  (left, right) => right.length - left.length,
);

/**
 * 支持带日期/版本后缀的模型名，例如 gpt-4o-2024-08-06、claude-3-5-sonnet-20241022。
 * 最长前缀优先，保证 gpt-4o-mini 不会被 gpt-4o 命中。
 */
export function resolveModelPricing(model: string): ModelPricing | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const exact = DEFAULT_MODEL_PRICING[normalized];
  if (exact) return exact;
  for (const pattern of PRICING_PATTERNS) {
    if (
      normalized.startsWith(`${pattern}-`) ||
      normalized.startsWith(`${pattern}:`) ||
      normalized.startsWith(`${pattern}.`)
    ) {
      return DEFAULT_MODEL_PRICING[pattern] ?? null;
    }
  }
  return null;
}

/** 后台自定义价格（人民币 / 1M tokens）：{ "model": { "input": 2, "output": 8 } }。 */
function readPricingOverrides(db: DatabaseSync): Record<string, ModelPricing> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(getSetting(db, "model_pricing", "{}")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const overrides: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const input = Number(record["input"] ?? record["inputPerMillion"]);
    const output = Number(record["output"] ?? record["outputPerMillion"]);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    overrides[key.trim().toLowerCase()] = {
      inputPerMillion: input,
      outputPerMillion: output,
    };
  }
  return overrides;
}

/** 后台价格优先，其次内置价格；两者都支持带日期/版本后缀的模型名。 */
function resolveModelPricingForDb(db: DatabaseSync, model: string): ModelPricing | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const overrides = readPricingOverrides(db);
  const overrideKeys = Object.keys(overrides).sort((left, right) => right.length - left.length);
  const exact = overrides[normalized];
  if (exact) return exact;
  for (const pattern of overrideKeys) {
    if (
      normalized.startsWith(`${pattern}-`) ||
      normalized.startsWith(`${pattern}:`) ||
      normalized.startsWith(`${pattern}.`)
    ) {
      return overrides[pattern] ?? null;
    }
  }
  return resolveModelPricing(model);
}

function readModelRates(db: DatabaseSync): Record<string, number> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(getSetting(db, "relay_model_rates", "{}")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const rates: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (Number.isFinite(numeric) && numeric > 0) rates[key] = numeric;
  }
  return rates;
}

function readBillingMarkup(db: DatabaseSync): number {
  const value = Number.parseFloat(getSetting(db, "billing_markup", "1"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function rateForModel(db: DatabaseSync, model: string): number {
  const rates = readModelRates(db);
  const normalized = model.trim().toLowerCase();
  return rates[normalized] ?? rates[model] ?? rates["default"] ?? 0;
}

/**
 * 显式配置的 relay_model_rates 优先（按总 tokens × 系数，兼容旧配置）；
 * 否则按人民币价格表分别计算输入、输出费用。
 */
export function chargedTokensFor(
  db: DatabaseSync,
  model: string,
  usage: UsageTokens,
): number {
  const totalTokens = Math.max(0, Math.floor(usage.totalTokens));
  const override = rateForModel(db, model);
  if (override > 0) {
    return Math.max(0, Math.ceil(totalTokens * override));
  }

  const pricing = resolveModelPricingForDb(db, model);
  if (!pricing) {
    return totalTokens;
  }

  const costCny =
    (Math.max(0, usage.promptTokens) / 1_000_000) * pricing.inputPerMillion +
    (Math.max(0, usage.completionTokens) / 1_000_000) * pricing.outputPerMillion;
  const credits = costCny / (BASE_CNY_PER_MILLION / 1_000_000);
  return Math.max(0, Math.ceil(credits * readBillingMarkup(db)));
}
