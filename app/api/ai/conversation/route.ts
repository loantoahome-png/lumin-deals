import { NextRequest, NextResponse } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { GHL_BASE, resolveApiKey } from '@/lib/ghl'
import { getAnthropic, CLAUDE_MODEL } from '@/lib/anthropic'

// AI helpers over a GHL conversation:
//   mode 'draft'   → Claude proposes the loan officer's next SMS reply
//   mode 'summary' → one-line "catch me up" on where the lead stands
//
// Reads the recent message history from GHL, then calls Claude. Requires
// ANTHROPIC_API_KEY in the environment.
export const maxDuration = 30

type GhlMessage = {
  direction?: string
  body?: string
  messageType?: string
  type?: string
  dateAdded?: string
}

function ghlMsgHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-04-15',           // conversations messaging API version
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  }
}

// Resolve the conversation id for a contact when the caller didn't pass one.
async function findConversationId(locationId: string, contactId: string, apiKey: string): Promise<string | null> {
  const res = await fetch(`${GHL_BASE}/conversations/search?locationId=${locationId}&contactId=${contactId}`, { headers: ghlMsgHeaders(apiKey) })
  if (!res.ok) return null
  const j = await res.json() as { conversations?: Array<{ id?: string }> }
  return j.conversations?.[0]?.id ?? null
}

// Pull the recent messages and render a clean transcript for the model.
async function buildTranscript(conversationId: string, apiKey: string): Promise<string> {
  const res = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages`, { headers: ghlMsgHeaders(apiKey) })
  if (!res.ok) return ''
  const j = await res.json() as { messages?: { messages?: GhlMessage[] } | GhlMessage[] }
  const raw = Array.isArray(j.messages) ? j.messages : (j.messages?.messages ?? [])
  const withBody = raw
    .filter(m => (m.body ?? '').trim().length > 0)
    .sort((a, b) => Date.parse(a.dateAdded ?? '') - Date.parse(b.dateAdded ?? ''))
    .slice(-30)   // most recent 30 messages with text
  return withBody
    .map(m => `${m.direction === 'inbound' ? 'Client' : 'Loan Officer'}: ${(m.body ?? '').trim()}`)
    .join('\n')
}

const DRAFT_SYSTEM =
  `You are an assistant to a mortgage loan officer at Lumin Lending. Read the SMS conversation and draft the loan officer's next reply to the client. ` +
  `Rules: keep it concise (1–3 short sentences), warm and professional, and ready to send as-is. ` +
  `Do NOT invent specifics (rates, dollar amounts, dates, approvals) that aren't already in the conversation. ` +
  `No placeholders, no markdown, no preamble — output ONLY the message text.`

const SUMMARY_SYSTEM =
  `You are an assistant to a mortgage loan officer. Summarize this SMS conversation in ONE concise sentence so the officer can catch up at a glance: ` +
  `where things stand and what the client is waiting on or needs next. Output only the sentence, no preamble.`

export async function POST(req: NextRequest) {
  const anthropic = getAnthropic()
  if (!anthropic) {
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 200 })
  }

  let body: { contactId?: string; locationId?: string; conversationId?: string; mode?: 'draft' | 'summary'; leadName?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }

  const { contactId, locationId, mode, leadName } = body
  if (!contactId || !locationId || (mode !== 'draft' && mode !== 'summary')) {
    return NextResponse.json({ ok: false, error: 'missing_contactId_locationId_or_mode' }, { status: 400 })
  }

  const apiKey = resolveApiKey(locationId)
  if (!apiKey) return NextResponse.json({ ok: false, error: `no_api_key_for_location:${locationId}` }, { status: 200 })

  try {
    const conversationId = body.conversationId || await findConversationId(locationId, contactId, apiKey)
    if (!conversationId) return NextResponse.json({ ok: false, error: 'no_conversation_found' }, { status: 200 })

    const transcript = await buildTranscript(conversationId, apiKey)
    if (!transcript) return NextResponse.json({ ok: false, error: 'no_messages_to_read' }, { status: 200 })

    const system = mode === 'draft' ? DRAFT_SYSTEM : SUMMARY_SYSTEM
    const userText = mode === 'draft'
      ? `Conversation${leadName ? ` with ${leadName}` : ''}:\n\n${transcript}\n\nDraft the loan officer's next reply.`
      : `Conversation${leadName ? ` with ${leadName}` : ''}:\n\n${transcript}`

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: mode === 'summary' ? 300 : 600,
      thinking: { type: 'disabled' },          // fast, deterministic for short generation
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: userText }],
    })

    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    return mode === 'draft'
      ? NextResponse.json({ ok: true, draft: text })
      : NextResponse.json({ ok: true, summary: text })
  } catch (err) {
    console.error('[AI conversation] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}
