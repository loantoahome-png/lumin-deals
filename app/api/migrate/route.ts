// TEMPORARY migration endpoint — will be deleted after running once
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== 'lumin-migrate-2026') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { Client } = await import('pg')

  // Try both connection methods
  const connStrings = [
    `postgresql://postgres.tkftvvocddbtymfuzzuo:dR3GB6ecJlhiH8Fd@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres.tkftvvocddbtymfuzzuo:dR3GB6ecJlhiH8Fd@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:dR3GB6ecJlhiH8Fd@db.tkftvvocddbtymfuzzuo.supabase.co:5432/postgres`,
  ]

  const sql = `
    ALTER TABLE deals
      ADD COLUMN IF NOT EXISTS rate_watch_active     BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS rate_watch_target     NUMERIC,
      ADD COLUMN IF NOT EXISTS rate_watch_notes      TEXT,
      ADD COLUMN IF NOT EXISTS rate_watch_alerted_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS deals_rate_watch_active_idx
      ON deals (rate_watch_active)
      WHERE rate_watch_active = TRUE;
  `

  for (const connString of connStrings) {
    const client = new Client({
      connectionString: connString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    })
    try {
      await client.connect()
      await client.query(sql)
      await client.end()
      const host = connString.split('@')[1]?.split('/')[0]
      return NextResponse.json({
        success: true,
        message: 'Migration complete — rate_watch columns added!',
        connection: host,
      })
    } catch (err: unknown) {
      await client.end().catch(() => {})
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('Tenant') && !msg.includes('not found') && !msg.includes('ENOTFOUND')) {
        return NextResponse.json({ error: msg, connString }, { status: 500 })
      }
      // Try next connection string
    }
  }

  return NextResponse.json({
    error: 'All connection methods failed — please run the SQL manually in Supabase SQL Editor',
    sql,
  }, { status: 500 })
}
