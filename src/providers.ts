import type { Config } from "./config";

export type ProviderName = "kilo" | "opencode";

export interface UpstreamTarget {
  provider: ProviderName;
  model: string;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
}

const CAPABILITIES: Record<string, ModelCapabilities> = {
  // OpenCode Zen Models
  "opencode/deepseek-v4-flash": { tools: true, vision: false },
  "opencode/deepseek-v4-flash-free": { tools: true, vision: false },
  "opencode/laguna-s-2.1-free": { tools: true, vision: false },
  "opencode/nemotron-3-ultra-free": { tools: true, vision: false },
  "opencode/nemotron-3.5-lightning-free": { tools: true, vision: false },
  "opencode/mimo-v2.5-free": { tools: true, vision: false },
  "opencode/hy3-free": { tools: true, vision: false },
  "opencode/ling-3.0-flash-free": { tools: true, vision: false },
  "opencode/north-mini-code-free": { tools: true, vision: false },
  "opencode/longcat-2.0-free": { tools: true, vision: false },

  // Kilo Gateway Models
  "kilo/kilo-auto/free": { tools: true, vision: false },
  "kilo/stepfun/step-3.7-flash:free": { tools: true, vision: true },
  "kilo/poolside/laguna-s-2.1:free": { tools: true, vision: false },
  "kilo/poolside/laguna-xs-2.1:free": { tools: true, vision: false },
  "kilo/cohere/north-mini-code:free": { tools: true, vision: false },
  "kilo/nvidia/nemotron-3-ultra-550b-a55b:free": { tools: true, vision: false },
  "kilo/nvidia/nemotron-3-super-120b-a12b:free": { tools: true, vision: false },
  "kilo/nvidia/nemotron-3.5-lightning:free": { tools: true, vision: false },
  "kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { tools: true, vision: true },
  "kilo/tencent/hy3:free": { tools: true, vision: false },
  "kilo/dots-studio/dots-3-note-preview:free": { tools: true, vision: true },
  "kilo/liquid/lfm-2.5-2.6b:free": { tools: true, vision: false },
  "kilo/openrouter/free": { tools: true, vision: true },
};

export function parseTarget(value: string, fallbackProvider: ProviderName = "kilo"): UpstreamTarget {
  const slash = value.indexOf("/");
  if (slash > 0) {
    const prefix = value.slice(0, slash).toLowerCase();
    if (prefix === "kilo" || prefix === "opencode") {
      return { provider: prefix, model: value.slice(slash + 1) };
    }
  }
  return { provider: fallbackProvider, model: value };
}

export function getProvider(config: Config, provider: ProviderName) {
  if (provider === "opencode") {
    return {
      name: provider,
      baseUrl: config.opencodeBaseUrl,
      apiKey: config.opencodeApiKey,
    };
  }
  return {
    name: provider,
    baseUrl: config.kiloBaseUrl,
    apiKey: config.kiloApiKey,
  };
}

/** A provider is enabled when a key exists in config OR arrives with the request. */
export function providerEnabled(
  config: Config,
  provider: ProviderName,
  requestApiKey = "",
): boolean {
  return Boolean(getProvider(config, provider).apiKey || requestApiKey);
}

export function displayTarget(target: UpstreamTarget): string {
  return `${target.provider}/${target.model}`;
}

export function isFreeTarget(target: UpstreamTarget): boolean {
  return target.provider === "opencode"
    ? target.model.endsWith("-free")
    : target.model.endsWith(":free") || target.model === "kilo-auto/free";
}

/**
 * Apply the gateway model prefix (MODEL_PREFIX) to a kilo target. OpenCode Zen
 * models are never prefixed. Prefixing lives here — the single place the
 * upstream model name is decided — so translateRequest stays prefix-free.
 */
export function qualifyModel(target: UpstreamTarget, config: Config): string {
  if (target.provider !== "kilo" || !config.modelPrefix) return target.model;
  return target.model.startsWith(config.modelPrefix)
    ? target.model
    : config.modelPrefix + target.model;
}

export function getCapabilities(target: UpstreamTarget): ModelCapabilities {
  // Unknown free models are allowed for text-only requests, but never assumed
  // to support Claude Code tools or image input.
  return CAPABILITIES[displayTarget(target)] ?? { tools: false, vision: false };
}
