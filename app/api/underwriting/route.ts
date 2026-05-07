import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

type FilePayload = { name: string; type: string; data: string }

type TextBlock   = { type: 'text'; text: string }
type ImageBlock  = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type DocBlock    = { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title: string }
type ContentBlock = TextBlock | ImageBlock | DocBlock

type ApiMessage = {
  role: string
  content: string | ContentBlock[]
}

export async function POST(req: NextRequest) {
  // ── Auth check: must be a signed-in user ─────────────────────────────────
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => req.cookies.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it in Vercel → Settings → Environment Variables.' },
      { status: 500 }
    )
  }

  const { messages, files, systemPrompt } = await req.json() as {
    messages: ApiMessage[]
    files?: FilePayload[]
    systemPrompt: string
  }

  // Build the final messages array — attach files to the last user message
  const apiMessages: ApiMessage[] = messages.map(m => ({ role: m.role, content: m.content }))

  const hasPdfs = files?.some(f => f.type === 'application/pdf') ?? false

  if (files && files.length > 0) {
    const lastMsg = apiMessages[apiMessages.length - 1]
    if (lastMsg && lastMsg.role === 'user') {
      const blocks: ContentBlock[] = []

      for (const file of files) {
        if (file.type === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: file.data },
            title: file.name,
          })
        } else if (file.type.startsWith('image/')) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: file.type, data: file.data },
          })
        }
      }

      // Append the user's text after the document/image blocks
      blocks.push({ type: 'text', text: lastMsg.content as string })
      lastMsg.content = blocks
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // PDF support requires the beta header
      ...(hasPdfs ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: systemPrompt,
      messages: apiMessages,
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    console.error('[UW API] Anthropic error:', JSON.stringify(data))
    return NextResponse.json(
      { error: data.error?.message ?? 'Anthropic API error' },
      { status: res.status }
    )
  }

  return NextResponse.json({ content: data.content?.[0]?.text ?? '' })
}
