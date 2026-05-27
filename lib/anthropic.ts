import Anthropic from '@anthropic-ai/sdk'

// Lazily-constructed Anthropic client. Returns null when ANTHROPIC_API_KEY
// isn't configured so callers can surface a clear "not set up" message instead
// of throwing at import time.
let client: Anthropic | null = null

export function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!client) client = new Anthropic()   // reads ANTHROPIC_API_KEY from env
  return client
}

export const CLAUDE_MODEL = 'claude-opus-4-7'
