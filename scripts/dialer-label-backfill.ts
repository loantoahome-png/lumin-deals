// Label the two dialing numbers that appeared 2026-08-21 as Brianne's, so
// buildDialerNameMap() learns them and every future sweep auto-labels.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
const env = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const LABEL = "Brianne's Number"
const NEW = ['9497732190', '9497389920']

async function main() {
  const dry = process.argv.includes('--dry')
  for (const phone of NEW) {
    const { count: before } = await sb.from('calls').select('*', { count: 'exact', head: true })
      .eq('dialer_number_phone', phone).is('dialer_number_name', null)
    if (dry) { console.log(`DRY ${phone}: would label ${before} rows`); continue }
    const { error, count } = await sb.from('calls')
      .update({ dialer_number_name: LABEL }, { count: 'exact' })
      .eq('dialer_number_phone', phone).is('dialer_number_name', null)
    if (error) throw new Error(`${phone}: ${error.message}`)
    console.log(`${phone}: labelled ${count} rows (was ${before} unlabelled)`)
  }
  const { count: left } = await sb.from('calls').select('*', { count: 'exact', head: true })
    .is('dialer_number_name', null)
  console.log(`unlabelled rows remaining: ${left}`)
}
main()
