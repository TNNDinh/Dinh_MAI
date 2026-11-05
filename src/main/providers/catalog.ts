import type { ProviderKind, ProviderProtocol } from './types'

/**
 * Static description of every supported provider. The UI renders its
 * "Add connection" form from this, and the registry uses it to pick an adapter.
 * Adding a provider that speaks an existing protocol = one entry here.
 */
export interface ProviderCatalogEntry {
  kind: ProviderKind
  label: string
  protocol: ProviderProtocol
  defaultBaseUrl: string
  requiresApiKey: boolean
  /** True when the base URL must be supplied/edited by the user. */
  customBaseUrl?: boolean
  /** Whether an image-generation adapter exists for this provider (see providers/images.ts). For custom servers it is optional: they must implement POST /images/generations. */
  imageGeneration: boolean
  /** Local providers cost nothing per token. */
  local?: boolean
  docsUrl?: string
  headers?: Record<string, string>
}

export const PROVIDER_CATALOG: Record<ProviderKind, ProviderCatalogEntry> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    imageGeneration: false,
    docsUrl: 'https://docs.anthropic.com'
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    imageGeneration: true,
    docsUrl: 'https://platform.openai.com/docs'
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    imageGeneration: true,
    docsUrl: 'https://ai.google.dev'
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    imageGeneration: false,
    headers: { 'X-Title': 'Multi-AI Development Studio' },
    docsUrl: 'https://openrouter.ai/docs'
  },
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
    imageGeneration: false,
    docsUrl: 'https://api-docs.deepseek.com'
  },
  groq: {
    kind: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    imageGeneration: false,
    docsUrl: 'https://console.groq.com/docs'
  },
  ollama: {
    kind: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    imageGeneration: false,
    local: true,
    docsUrl: 'https://ollama.com'
  },
  custom: {
    kind: 'custom',
    label: 'Custom OpenAI-compatible',
    protocol: 'openai-compatible',
    defaultBaseUrl: '',
    requiresApiKey: false,
    customBaseUrl: true,
    imageGeneration: true
  }
}

export const PROVIDER_KINDS = Object.keys(PROVIDER_CATALOG) as ProviderKind[]
