import { NextResponse } from 'next/server'

// ── Fetch 10-year Treasury yield from FRED (Federal Reserve, no API key needed)
async function fetchYieldData() {
  // FRED DGS10 = Daily 10-Year Treasury Constant Maturity Rate
  const res = await fetch(
    'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10',
    { next: { revalidate: 3600 } } // cache 1 hour
  )
  if (!res.ok) throw new Error('FRED fetch failed')
  const text = await res.text()

  const lines = text.trim().split('\n').slice(1) // skip header
  const valid = lines.filter(l => {
    const [, v] = l.split(',')
    return v && v.trim() !== '.' && !isNaN(parseFloat(v))
  })

  if (valid.length < 2) throw new Error('Insufficient data')

  // Last 30 trading days for sparkline
  const recent = valid.slice(-30)
  const last   = recent[recent.length - 1]
  const prev   = recent[recent.length - 2]
  const week   = recent[recent.length - 6] // ~5 trading days ago

  const [date, value] = last.split(',')
  const current  = parseFloat(value)
  const previous = parseFloat(prev.split(',')[1])
  const weekAgo  = parseFloat(week?.split(',')[1] ?? value)

  const sparkline = recent.map(l => {
    const [d, v] = l.split(',')
    return { date: d, value: parseFloat(v) }
  })

  return {
    current:       parseFloat(current.toFixed(3)),
    date,
    dayChange:     parseFloat((current - previous).toFixed(3)),
    weekChange:    parseFloat((current - weekAgo).toFixed(3)),
    sparkline,
  }
}

export async function GET() {
  try {
    const data = await fetchYieldData()
    return NextResponse.json(data)
  } catch (err) {
    console.error('[Treasury API]', err)
    return NextResponse.json({ error: 'Failed to fetch yield data' }, { status: 500 })
  }
}
