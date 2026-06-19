import { ShieldCheck, AlertTriangle, Phone, MessageSquare, ListChecks } from 'lucide-react'

// Static, read-only reference — no data fetching, prerenders as a static page.
// Mirrors docs/compliance-quick-reference.md. Plain-English cheat sheet, NOT legal advice.

export const metadata = { title: 'Compliance — Lumin' }

const OK = <span className="text-emerald-600 font-bold">OK</span>
const NO = <span className="text-red-600 font-bold">No</span>

export default function CompliancePage() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-blue-600" /> Calling &amp; Texting Compliance
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">Quick reference for Efrain, Matt &amp; Moe · last updated Jun 18, 2026</p>
        </div>

        {/* Disclaimer */}
        <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            <b>Not legal advice.</b> A plain-English cheat sheet for day-to-day outreach. TCPA/DNC
            violations run <b>$500–$1,500 per call or text</b> — confirm your actual policy with
            compliance counsel. State rules vary by where the borrower lives.
          </p>
        </div>

        {/* Core mental model */}
        <Section title="Calls and texts are TWO different rule sets" icon={<ListChecks className="w-4 h-4" />}>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Phone calls</th>
                  <th className="px-3 py-2">Automated texts / robocalls</th>
                </tr>
              </thead>
              <tbody className="[&_td]:px-3 [&_td]:py-2 [&_td]:border-b [&_td]:border-slate-100 [&_td]:align-top">
                <tr><td className="font-semibold text-slate-600">Governed by</td><td>DNC Registry + inquiry/EBR exemptions</td><td>TCPA prior express written consent (PEWC)</td></tr>
                <tr><td className="font-semibold text-slate-600">The “3-month” clock</td><td className="text-emerald-700">Applies</td><td className="text-red-700 font-medium">Does NOT apply — wrong yardstick</td></tr>
                <tr><td className="font-semibold text-slate-600">What lets you contact</td><td>An exemption, or not on the DNC list</td><td>Valid written consent — lasts until revoked</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-slate-600 mt-2">Do <b>not</b> use the 3-month window to decide whether you can text. They&apos;re unrelated.</p>
        </Section>

        {/* Calls */}
        <Section title="Calls — the DNC windows" icon={<Phone className="w-4 h-4" />}>
          <p className="text-sm text-slate-600 mb-2">A number on the National DNC Registry is <b>still callable</b> if an exemption applies:</p>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-5">
            <li><b>Inquiry exemption — 3 months.</b> Borrower submitted a mortgage inquiry → you may call for 3 months even if they&apos;re on the DNC list.</li>
            <li><b>Established Business Relationship — 18 months.</b> Borrower actually transacted with you → 18 months from the last transaction.</li>
            <li><b>After the window:</b> the exemption lapses. If they&apos;re on the DNC list, <b>stop calling</b> unless you have separate consent.</li>
          </ul>
          <p className="text-sm font-semibold text-slate-700 mt-3">Always overrides any exemption:</p>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-5 mt-1">
            <li><b>Company-specific DNC</b> — if they told <i>us</i> to stop, that&apos;s <b>permanent</b>.</li>
            <li><b>State DNC lists</b> — some of our states are stricter than federal.</li>
          </ul>
          <p className="text-xs text-slate-500 italic mt-3">
            We don&apos;t currently run a DNC scrubber (deferred — cost). So: keep cold calls inside the
            inquiry window, honor every opt-out, and treat aged leads (past 3 months) as higher-risk until we can scrub.
          </p>
        </Section>

        {/* Texts */}
        <Section title="Texts (and autodialed/robocalls) — TCPA consent" icon={<MessageSquare className="w-4 h-4" />}>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-5">
            <li>Automated marketing texts to a cell need <b>valid prior express written consent (PEWC)</b>.</li>
            <li><b>PEWC does not expire at 3 months</b> — it lasts <b>until the borrower revokes it</b>. So: valid consent + not opted out = you can keep texting, past 3 months.</li>
          </ul>
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 mt-3 text-sm text-slate-700">
            <p className="font-semibold text-slate-800">The catch — an inquiry is NOT automatically consent to text.</p>
            <p className="mt-1">PEWC requires the lead form to have had clear written language agreeing to <b>automated marketing texts</b>, naming who&apos;s contacting them, by a checkbox/signature.</p>
            <p className="mt-2"><span className="text-emerald-700 font-bold">Action:</span> confirm our vendors (FRU, Lendgo, LMB, Lending Tree, LeadPoint, OwnUp) capture PEWC and can produce a <b>TrustedForm or Jornaya certificate</b> per lead. No cert = no defensible texting consent.</p>
          </div>
        </Section>

        {/* Always applies */}
        <Section title="Always applies (consent or not)" icon={<ShieldCheck className="w-4 h-4" />}>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-5">
            <li><b>Honor opt-outs made any reasonable way</b> — not just &ldquo;STOP&rdquo; (includes &ldquo;please stop&rdquo; on a call). Honor within ~10 business days.</li>
            <li><b>A2P 10DLC</b> registration for texting campaigns (carrier requirement, separate from TCPA).</li>
            <li><b>Quiet hours:</b> no contact before 8am / after 9pm the borrower&apos;s local time.</li>
            <li><b>Identify yourself</b> (name + company) on calls and texts.</li>
            <li><b>State mini-TCPAs</b> (Florida FTSA, Washington, Oklahoma, etc.) — some stricter than federal.</li>
          </ul>
        </Section>

        {/* Decision cheat */}
        <Section title="Quick decision cheat" icon={<ListChecks className="w-4 h-4" />}>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                  <th className="px-3 py-2">Situation</th>
                  <th className="px-3 py-2 text-right">OK?</th>
                </tr>
              </thead>
              <tbody className="[&_td]:px-3 [&_td]:py-2 [&_td]:border-b [&_td]:border-slate-100">
                <tr><td>Manual call, fresh lead, inquired &lt; 3 mo ago</td><td className="text-right">{OK} <span className="text-slate-400 text-xs">lowest risk</span></td></tr>
                <tr><td>Manual call, inquired &gt; 3 mo ago, on DNC</td><td className="text-right">{NO}</td></tr>
                <tr><td>Automated text, valid PEWC cert, not opted out</td><td className="text-right">{OK}</td></tr>
                <tr><td>Automated text, only an inquiry but no PEWC cert</td><td className="text-right">{NO}</td></tr>
                <tr><td>Anyone who told us to stop (any channel, any way)</td><td className="text-right">{NO} <span className="text-slate-400 text-xs">permanent</span></td></tr>
              </tbody>
            </table>
          </div>
        </Section>

        {/* What protects us today */}
        <Section title="What protects us today" icon={<ShieldCheck className="w-4 h-4" />}>
          <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-5">
            <li><b>GHL DND flags</b> surface opt-outs in the dashboard (the red DND badge).</li>
            <li><b>Inquiry window</b> covers fresh-lead cold calls.</li>
            <li><b>Vendor consent certs</b> (verify we&apos;re getting them) cover texting.</li>
            <li><b>Not yet in place:</b> a DNC scrubber (federal/state list + litigator check) — revisit when budget allows.</li>
          </ul>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <h2 className="text-base font-bold text-slate-800 flex items-center gap-2 mb-3">
        <span className="text-blue-600">{icon}</span> {title}
      </h2>
      {children}
    </div>
  )
}
