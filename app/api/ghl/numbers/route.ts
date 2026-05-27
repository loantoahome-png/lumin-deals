import { NextRequest, NextResponse } from 'next/server'
import { GHL_BASE, resolveApiKey, ghlHeaders } from '@/lib/ghl'

// Lists the SMS-capable phone numbers configured for a GHL sub-account, so the
// reply composer can show a "From" picker (and the team always knows which
// number a text goes out on).
export const dynamic = 'force-dynamic'

type GhlNumber = { sid?: string; value?: string; title?: string }

export async function GET(req: NextRequest) {
  const locationId = new URL(req.url).searchParams.get('locationId')
  if (!locationId) return NextResponse.json({ ok: false, error: 'missing_locationId' }, { status: 400 })

  const apiKey = resolveApiKey(locationId)
  if (!apiKey) return NextResponse.json({ ok: false, error: `no_api_key_for_location:${locationId}` }, { status: 200 })

  try {
    const res = await fetch(`${GHL_BASE}/phone-system/numbers?locationId=${locationId}`, { headers: ghlHeaders(apiKey) })
    if (!res.ok) {
      return NextResponse.json({ ok: false, status: res.status, error: (await res.text()).slice(0, 200) }, { status: 200 })
    }
    const data = await res.json() as { phoneNumbers?: GhlNumber[] }
    const numbers = (data.phoneNumbers ?? [])
      .filter(n => n.value)
      .map(n => ({ value: n.value as string, title: n.title || n.value as string }))
    return NextResponse.json({ ok: true, numbers })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}
