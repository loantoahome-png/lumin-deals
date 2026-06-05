import { NextResponse } from 'next/server'

// Receives client-side crash reports from the error boundaries and logs them
// server-side so they show up in `vercel logs` (client crashes otherwise never
// reach the server). Public (whitelisted in middleware) and best-effort.
export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    console.error('[CLIENT-ERROR]', JSON.stringify(body))
  } catch {
    console.error('[CLIENT-ERROR] (unparseable body)')
  }
  return NextResponse.json({ ok: true })
}
