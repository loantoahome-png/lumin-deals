import { NextRequest, NextResponse } from 'next/server'
import { GHL_BASE, resolveApiKey, ghlHeaders } from '@/lib/ghl'
import { LOCATION_TOKEN_RE, applyTokens } from '@/lib/mergeFields'

// The team's real GHL text snippets ("Snippets" in the GHL Conversations UI —
// "templates" in the API), so the deal-page composer offers what Moe and Matt
// actually wrote instead of three strings hardcoded in the component.
//
// ⚠️ GOTCHA — `originId` is documented as REQUIRED and must be OMITTED.
// The OpenAPI spec marks it required, but passing it (we tried the location id)
// returns {"templates":[],"totalCount":0} with HTTP 200 — a silent empty list,
// no error. Omitting it returns all 22. Verified live on both sub-accounts
// 2026-07-31. Do not "fix" the missing required param.
//
// ⚠️ SECURITY — location custom values are resolved HERE, on the server, and the
// raw list never reaches the browser. Custom values hold secrets (Moe's location
// stores a Monday API token in one), so we look up ONLY the tokens a snippet
// actually references and substitute them into the body. Contact/user tokens
// ({{contact.first_name}}, {{user.first_name}}) are left for the client, which
// knows the borrower and the LO.
export const dynamic = 'force-dynamic'

type GhlTemplate = {
  id?: string
  name?: string
  type?: string
  template?: { body?: string; attachments?: unknown[] }
}
type GhlCustomValue = { fieldKey?: string; value?: string | null; name?: string }

export type Snippet = { id: string; name: string; body: string; hasAttachments: boolean }

export async function GET(req: NextRequest) {
  const locationId = new URL(req.url).searchParams.get('locationId')
  if (!locationId) return NextResponse.json({ ok: false, error: 'missing_locationId' }, { status: 400 })

  const apiKey = resolveApiKey(locationId)
  if (!apiKey) return NextResponse.json({ ok: false, error: `no_api_key_for_location:${locationId}` }, { status: 200 })

  try {
    // NOTE: templates use Version 2021-07-28 (ghlHeaders), NOT the 2021-04-15
    // the conversations/messages endpoints use.
    const res = await fetch(`${GHL_BASE}/locations/${locationId}/templates?type=sms&limit=200`, {
      headers: { ...ghlHeaders(apiKey), Accept: 'application/json' },
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, status: res.status, error: (await res.text()).slice(0, 200) }, { status: 200 })
    }
    const data = await res.json() as { templates?: GhlTemplate[] }
    const raw = (data.templates ?? []).filter(t => t.template?.body)

    // Only fetch custom values if a snippet actually references one — most
    // don't, and this keeps a secret-bearing list out of the request path.
    const needsCustomValues = raw.some(t => LOCATION_TOKEN_RE.test(t.template?.body ?? ''))
    const values = needsCustomValues ? await fetchCustomValues(locationId, apiKey) : {}

    const snippets: Snippet[] = raw.map((t, i) => ({
      id: t.id || `snippet-${i}`,
      name: t.name?.trim() || 'Untitled snippet',
      body: applyTokens(t.template!.body!, values),
      hasAttachments: (t.template?.attachments?.length ?? 0) > 0,
    })).sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({ ok: true, snippets })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}

/** fieldKey comes back as the literal token — "{{ custom_values.company_name }}" —
 *  so it keys the substitution map directly. `value` is absent on custom values
 *  nobody filled in (6 of Moe's 30); those stay unresolved on purpose and the
 *  composer refuses to send them. */
async function fetchCustomValues(locationId: string, apiKey: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${GHL_BASE}/locations/${locationId}/customValues`, {
      headers: { ...ghlHeaders(apiKey), Accept: 'application/json' },
    })
    if (!res.ok) return {}
    const data = await res.json() as { customValues?: GhlCustomValue[] }
    const map: Record<string, string> = {}
    for (const cv of data.customValues ?? []) {
      if (cv.fieldKey && typeof cv.value === 'string' && cv.value.trim()) map[cv.fieldKey] = cv.value
    }
    return map
  } catch {
    return {}
  }
}
