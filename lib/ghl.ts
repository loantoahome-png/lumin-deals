// ── Shared GHL helpers (used by sync + push routes) ───────────────────────────

export const GHL_BASE = 'https://services.leadconnectorhq.com'

export type GHLAccount = { label: string; apiKey: string; locationId: string }

/** Read all configured GHL accounts from env. Order: primary, matt, extra. */
export function getAccounts(): GHLAccount[] {
  const accounts: GHLAccount[] = []
  if (process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
    accounts.push({ label: 'primary', apiKey: process.env.GHL_API_KEY, locationId: process.env.GHL_LOCATION_ID })
  }
  if (process.env.GHL_API_KEY_MATT && process.env.GHL_LOCATION_ID_MATT) {
    accounts.push({ label: 'matt', apiKey: process.env.GHL_API_KEY_MATT, locationId: process.env.GHL_LOCATION_ID_MATT })
  }
  if (process.env.GHL_API_KEY_2 && process.env.GHL_LOCATION_ID_2) {
    accounts.push({ label: 'extra', apiKey: process.env.GHL_API_KEY_2, locationId: process.env.GHL_LOCATION_ID_2 })
  }
  return accounts
}

/** Look up which account owns a given GHL locationId. */
export function resolveApiKey(locationId: string | null | undefined): string | null {
  if (!locationId) return null
  return getAccounts().find(a => a.locationId === locationId)?.apiKey ?? null
}

export function ghlHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  }
}

// ── Dashboard status ↔ GHL stage name (inverse of GHL_STAGE_MAP in sync route)
// Used to translate a dashboard status into a name we can look up in a
// location's pipeline tree to get the actual pipelineStageId.
export const STATUS_TO_GHL_STAGE_NAME: Record<string, string> = {
  'New Lead':                    'new lead',
  'Attempted Contact':           'attempted contact',
  'Ghosted':                     'ghosted',
  'Responded':                   'responded',
  'Pitching':                    'pitching',
  'Appointment Booked':          'appointment booked',
  'Arive Lead':                  'arive lead',
  'App Intake':                  'app intake',
  'Qualification':               'qualification',
  'Pre-Approved':                'pre-approved',
  'Loan Setup':                  'loan setup',
  'Disclosed':                   'disclosed',
  'Submitted to UW':             'submitted to uw',
  'Approved w/ Conditions':      'approved w/ conditions',
  'Re-Submittal':                're-submittal',
  'Clear to Close':              'clear to close',
  'Docs Out':                    'docs out',
  'Docs Signed':                 'docs signed',
  'Loan Funded':                 'loan funded',
  'Broker Check Received':       'broker check received',
  'Loan Finalized':              'loan finalized',
  'Not Qualified - Credit':      'not qualified - credit',
  'Not Qualified - Income':      'not qualified - income',
  'Not Ready - Timeframe':       'not ready - timeframe',
  'DND - SMS':                   'dnd - sms',
  'Not Ready - Rate':            'not ready - rate',
  'Lost to Competitor':          'lost to competitor',
  'Non-Responsive':              'non-responsive',
  'Remove from All Automations': 'remove from all automations',
  'STOP':                        'stop',
}

// ── Stage-index cache ────────────────────────────────────────────────────────
// Per-location inverse index: lower(stage_name) → {pipelineId, pipelineStageId}.
// Built once per Vercel instance, refreshed every 5 min. Pipelines change rarely.
type StageRef = {
  pipelineId: string
  pipelineStageId: string
  pipelineName: string
  stageName: string
}
const stageIndexCache = new Map<string, { built: number; index: Map<string, StageRef> }>()
const STAGE_INDEX_TTL_MS = 5 * 60 * 1000

export async function getStageIndex(
  locationId: string,
  apiKey: string,
): Promise<Map<string, StageRef>> {
  const cached = stageIndexCache.get(locationId)
  if (cached && Date.now() - cached.built < STAGE_INDEX_TTL_MS) return cached.index

  const res = await fetch(
    `${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`,
    { headers: ghlHeaders(apiKey) },
  )
  if (!res.ok) throw new Error(`GHL pipelines fetch failed (${res.status})`)

  const data = await res.json() as {
    pipelines?: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>
  }

  const index = new Map<string, StageRef>()
  for (const pipeline of data.pipelines || []) {
    for (const stage of pipeline.stages || []) {
      const key = stage.name.toLowerCase().trim()
      // First match wins — handles the rare case of duplicate stage names
      // across pipelines. Our dashboard statuses don't collide in practice.
      if (!index.has(key)) {
        index.set(key, {
          pipelineId: pipeline.id,
          pipelineStageId: stage.id,
          pipelineName: pipeline.name,
          stageName: stage.name,
        })
      }
    }
  }
  stageIndexCache.set(locationId, { built: Date.now(), index })
  return index
}

// ── Push a stage change to GHL ───────────────────────────────────────────────
export type PushStageResult =
  | { ok: true;  pushed: true;  pipelineName: string; stageName: string }
  | { ok: true;  pushed: false; reason: string }   // intentional skip
  | { ok: false; error: string }

/**
 * Update an opportunity's pipeline stage in GHL. Idempotent — safe to call
 * multiple times. No-ops cleanly when the deal isn't linked to GHL.
 */
export async function pushOpportunityStage(args: {
  locationId: string | null
  opportunityId: string | null
  status: string
}): Promise<PushStageResult> {
  const { locationId, opportunityId, status } = args

  if (!locationId)    return { ok: true, pushed: false, reason: 'no_ghl_location_on_deal' }
  if (!opportunityId) return { ok: true, pushed: false, reason: 'no_ghl_opportunity_id' }
  const apiKey = resolveApiKey(locationId)
  if (!apiKey)        return { ok: false, error: `no_api_key_for_location:${locationId}` }

  const ghlStageName = STATUS_TO_GHL_STAGE_NAME[status]
  if (!ghlStageName)  return { ok: false, error: `no_ghl_mapping_for_status:${status}` }

  let index: Map<string, StageRef>
  try {
    index = await getStageIndex(locationId, apiKey)
  } catch (e) {
    return { ok: false, error: `pipeline_lookup_failed:${String(e)}` }
  }
  const ref = index.get(ghlStageName)
  if (!ref) return { ok: false, error: `stage_not_in_ghl_location:${ghlStageName}` }

  try {
    const res = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, {
      method: 'PUT',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({
        pipelineId: ref.pipelineId,
        pipelineStageId: ref.pipelineStageId,
        // 'open' keeps the opp active (vs. won/lost which archive it).
        // Moving stages always means the deal is in progress.
        status: 'open',
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `ghl_put_${res.status}:${body.slice(0, 200)}` }
    }
    return { ok: true, pushed: true, pipelineName: ref.pipelineName, stageName: ref.stageName }
  } catch (e) {
    return { ok: false, error: `ghl_request_failed:${String(e)}` }
  }
}
