// ── Shared Arive deep-links ─────────────────────────────────────────────────
// Both LOs share one Arive org, so the loan URL is fully derivable from the
// Arive file number:
//   https://luminlending.myarive.com/app/loans/{fileNo}/loan-center
const ARIVE_BASE = 'https://luminlending.myarive.com/app/loans'

/** Accepts a raw file number OR a pasted full Arive loan URL — returns just the id. */
export function parseAriveFileNo(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/myarive\.com\/app\/loans\/(\d+)/i)
  return m ? m[1] : trimmed
}

/** Build the Arive loan-center URL for a file number, or null when there isn't one. */
export function ariveUrl(fileNo: string | null | undefined): string | null {
  const id = String(fileNo ?? '').trim()
  if (!id) return null
  return `${ARIVE_BASE}/${id}/loan-center`
}
