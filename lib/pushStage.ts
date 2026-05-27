// Client-side helper — fire a stage push to GHL after a dashboard status change.
//
// Pattern:  await supabase write ; then  pushStageToGHL(dealId, status)
//
// We don't block the UI on the GHL push — Supabase is our source of truth;
// the dashboard already reflects the change. If GHL is slow or down, the
// user shouldn't have to wait.
//
// If the push fails, we log + (optionally) toast. The next sync will still
// have correct data because the sync route's "only overwrite if changed"
// guard (see syncAccount) prevents stale GHL data from reverting a recent
// dashboard change.

export type PushStageResult = {
  ok: boolean
  pushed?: boolean
  pipelineName?: string
  stageName?: string
  reason?: string
  error?: string
}

export async function pushStageToGHL(
  dealId: string,
  status: string,
): Promise<PushStageResult> {
  try {
    const res = await fetch(`/api/deals/${dealId}/push-stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data: PushStageResult = await res.json().catch(() => ({ ok: false, error: 'bad_json' }))

    if (!data.ok) {
      console.warn(`[GHL push] deal=${dealId} status="${status}" failed:`, data.error)
    } else if (data.pushed === false) {
      console.info(`[GHL push] deal=${dealId} skipped: ${data.reason}`)
    } else {
      console.info(`[GHL push] deal=${dealId} → "${status}" pushed to GHL (${data.pipelineName} / ${data.stageName})`)
    }
    return data
  } catch (e) {
    console.error(`[GHL push] network error for deal=${dealId}:`, e)
    return { ok: false, error: String(e) }
  }
}
