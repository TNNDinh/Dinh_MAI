import { AnthropicProvider } from './anthropic'
import { PROVIDER_CATALOG } from './catalog'
import { GeminiProvider } from './gemini'
import { ProviderError } from './http'
import { GeminiImageProvider, OpenAIImageProvider } from './images'
import { OpenAICompatibleProvider } from './openai-compatible'
import type { ChatProvider, ConnectionConfig, ImageProvider } from './types'

/**
 * Build a chat provider for a connection. Missing optional fields are filled
 * from the catalog so callers only have to store what the user changed.
 */
export function createChatProvider(config: ConnectionConfig): ChatProvider {
  const entry = PROVIDER_CATALOG[config.kind]
  if (!entry) throw new ProviderError(`Unknown provider kind "${config.kind}"`, 'unsupported')

  const baseUrl = config.baseUrl || entry.defaultBaseUrl
  if (!baseUrl) throw new ProviderError('A base URL is required for this provider', 'bad_request')
  if (entry.requiresApiKey && !config.apiKey) {
    throw new ProviderError(`${entry.label} requires an API key`, 'auth', { provider: config.kind })
  }

  const resolved: ConnectionConfig = { ...config, baseUrl, headers: { ...entry.headers, ...config.headers } }

  switch (entry.protocol) {
    case 'anthropic':
      return new AnthropicProvider(resolved)
    case 'gemini':
      return new GeminiProvider(resolved)
    case 'openai-compatible':
      return new OpenAICompatibleProvider(resolved, config.kind)
  }
}

/**
 * Build an image provider for a connection. Only providers whose image API is implemented are supported:
 * OpenAI (and OpenAI-compatible servers that opt in), and Google Gemini / Imagen. Everything else is refused with
 * an explicit error rather than approximated.
 */
export function createImageProvider(config: ConnectionConfig): ImageProvider {
  const entry = PROVIDER_CATALOG[config.kind]
  if (!entry) throw new ProviderError(`Unknown provider kind "${config.kind}"`, 'unsupported')
  if (!entry.imageGeneration) {
    throw new ProviderError(`${entry.label} has no image generation API that this app supports. Use OpenAI, Google Gemini, or a custom OpenAI-compatible server for images.`, 'unsupported', { provider: config.kind })
  }
  const baseUrl = config.baseUrl || entry.defaultBaseUrl
  if (!baseUrl) throw new ProviderError('A base URL is required for this provider', 'bad_request')
  if (entry.requiresApiKey && !config.apiKey) throw new ProviderError(`${entry.label} requires an API key`, 'auth', { provider: config.kind })
  const resolved: ConnectionConfig = { ...config, baseUrl, headers: { ...entry.headers, ...config.headers } }
  switch (entry.protocol) {
    case 'gemini':
      return new GeminiImageProvider(resolved)
    case 'openai-compatible':
      return new OpenAIImageProvider(resolved, config.kind)
    default:
      throw new ProviderError(`${entry.label} has no supported image API.`, 'unsupported', { provider: config.kind })
  }
}
