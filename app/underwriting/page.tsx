'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Brain, ChevronDown, ChevronRight, Upload, X, Send,
  Calculator, FileText, DollarSign, Loader2, Copy, Check,
  Users, Zap,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────
type Role = 'user' | 'assistant'
type Message = { id: string; role: Role; content: string; fileNames?: string[] }
type FilePayload = { name: string; type: string; data: string }

// ── File → base64 helper ───────────────────────────────────────────────────────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
type ActiveTool = 'dti' | 'condition' | 'fee' | null

// ── Constants ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert mortgage underwriting assistant for Lumin Lending, a mortgage brokerage. You support loan assistants and loan officers — specifically Efrain (loan assistant), Moe Sefati (LO), and Matt (LO) — in their daily mortgage work.

Your expertise covers:
- Fannie Mae (FNMA) and Freddie Mac (FHLMC) conventional loan guidelines (DU/LP)
- FHA guidelines (HUD Handbook 4000.1)
- VA loan guidelines (VA Lender Handbook)
- USDA Rural Development guidelines
- Rocket Mortgage broker channel guidelines and overlays
- Rocket Mortgage specialty programs: ONE+, BorrowSmart Access, Purchase Plus
- Income analysis: W2, self-employed (Schedule C, 1120S, 1065), rental income, retirement, alimony/child support, commission, bonus
- Asset documentation and sourcing requirements
- Credit analysis: credit scores, tradelines, derogatory events, waiting periods
- Debt-to-income ratio calculations
- Appraisal guidelines, property eligibility, condo warrantability
- Title, escrow, and closing requirements

Communication style:
- Professional but concise — this is a working tool, not a lecture
- Use markdown headers and bullet points for structured answers
- Flag critical issues with ⚠️ and approvals with ✅ and denials with ❌
- Always cite which guideline/agency applies (e.g., "Per Fannie Mae B3-3.1-06...")
- When uncertain about a specific Rocket overlay, say so and suggest confirming with Rocket's broker support line`

const QUICK_ACTIONS = [
  { label: 'DTI Analysis', prompt: 'Run a DTI analysis for a borrower with $8,500/month gross income, $450 car payment, $1,200 proposed mortgage PITI, and $200 minimum credit card payments.' },
  { label: 'Loan Guidelines', prompt: 'What are the Rocket Mortgage conventional loan guidelines for a borrower with a 680 credit score, 20% down, and a W2 income?' },
  { label: 'Gift Letter Rules', prompt: 'Explain what a gift letter needs to contain for FHA and conventional loans, and any sourcing requirements.' },
  { label: 'Self-Employed Income', prompt: 'What are the self-employment income documentation requirements for a 2-year self-employed borrower applying for a conventional loan?' },
  { label: 'Reserve Requirements', prompt: 'What are the reserve requirements for a conventional purchase with 10% down and a 720 credit score?' },
  { label: 'FHA vs Conv vs VA', prompt: 'Summarize the key differences between FHA, Conventional, and VA loan programs for a first-time buyer with a 640 credit score.' },
]

const ROCKET_PROGRAMS = [
  { label: 'ONE+ Program', prompt: 'What are Rocket Mortgage ONE+ program requirements and how does it help low-down-payment borrowers?' },
  { label: 'BorrowSmart Access', prompt: 'What is the BorrowSmart Access program from Rocket Mortgage and who qualifies?' },
  { label: 'Purchase Plus', prompt: 'Explain Rocket Mortgage Purchase Plus program and its appraisal guarantee.' },
]

const WELCOME_CHIPS = [
  { label: '📄 File checklist', prompt: 'What documents do I need for a complete purchase loan file?' },
  { label: '🧮 1099 income calc', prompt: 'How do I calculate qualifying income from 1099 and Schedule C?' },
  { label: '🏢 Condo warrantability', prompt: 'What are the condo warrantability requirements for conventional loans?' },
  { label: '💼 Employment history', prompt: 'Explain the 2-year employment history rule and what exceptions exist.' },
  { label: '🤝 Seller concessions', prompt: 'What is the max seller concession for FHA with less than 10% down?' },
]

// ── Markdown renderer ──────────────────────────────────────────────────────────
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-slate-100 text-slate-700 px-1 rounded text-xs font-mono">{part.slice(1, -1)}</code>
    return <span key={i}>{part}</span>
  })
}

function MarkdownContent({ text }: { text: string }) {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      nodes.push(
        <pre key={i} className="bg-slate-900 text-green-300 rounded-lg p-3 text-xs overflow-x-auto my-2 font-mono leading-relaxed">
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
    } else if (line.startsWith('### ')) {
      nodes.push(<h3 key={i} className="font-semibold text-slate-800 text-sm mt-3 mb-1">{renderInline(line.slice(4))}</h3>)
    } else if (line.startsWith('## ')) {
      nodes.push(<h2 key={i} className="font-semibold text-slate-900 mt-4 mb-1.5">{renderInline(line.slice(3))}</h2>)
    } else if (line.startsWith('# ')) {
      nodes.push(<h1 key={i} className="font-bold text-slate-900 text-base mt-4 mb-2">{renderInline(line.slice(2))}</h1>)
    } else if (line.trim() === '---') {
      nodes.push(<hr key={i} className="border-slate-200 my-3" />)
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      const items: React.ReactNode[] = []
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('• '))) {
        items.push(<li key={i}>{renderInline(lines[i].slice(2))}</li>)
        i++
      }
      nodes.push(<ul key={`ul-${i}`} className="list-disc ml-5 space-y-0.5 my-1.5 text-sm">{items}</ul>)
      continue
    } else if (/^\d+\.\s/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(<li key={i}>{renderInline(lines[i].replace(/^\d+\.\s/, ''))}</li>)
        i++
      }
      nodes.push(<ol key={`ol-${i}`} className="list-decimal ml-5 space-y-0.5 my-1.5 text-sm">{items}</ol>)
      continue
    } else if (line.trim() === '') {
      if (nodes.length > 0) nodes.push(<div key={i} className="h-1.5" />)
    } else {
      nodes.push(<p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>)
    }
    i++
  }

  return <div className="space-y-0.5">{nodes}</div>
}

// ── Collapsible sidebar section ────────────────────────────────────────────────
function SidebarSection({
  title, icon: Icon, children, defaultOpen = true,
}: {
  title: string
  icon?: React.ElementType
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-slate-100">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5" />}
          {title}
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 rounded-lg text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors border border-transparent hover:border-indigo-100"
    >
      {label}
    </button>
  )
}

// ── DTI Calculator ─────────────────────────────────────────────────────────────
function DTICalculator({ onSendToChat }: { onSendToChat: (msg: string) => void }) {
  const [form, setForm] = useState({ income: '', piti: '', car: '', student: '', creditCard: '', other: '' })
  const [result, setResult] = useState<{ front: number; back: number } | null>(null)

  const inp = 'w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white'

  function calculate() {
    const income = parseFloat(form.income) || 0
    if (!income) return
    const piti = parseFloat(form.piti) || 0
    const debts = ['car', 'student', 'creditCard', 'other'].reduce(
      (sum, k) => sum + (parseFloat(form[k as keyof typeof form]) || 0), 0
    )
    setResult({ front: (piti / income) * 100, back: ((piti + debts) / income) * 100 })
  }

  function getStatus(back: number) {
    if (back <= 36) return { label: 'Strong', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: '✅' }
    if (back <= 43) return { label: 'Acceptable (Conventional)', color: 'text-yellow-700 bg-yellow-50 border-yellow-200', icon: '🟡' }
    if (back <= 50) return { label: 'FHA/VA only — AUS required', color: 'text-orange-700 bg-orange-50 border-orange-200', icon: '⚠️' }
    return { label: 'Exceeds standard guidelines', color: 'text-red-700 bg-red-50 border-red-200', icon: '❌' }
  }

  function sendToChat() {
    if (!result) return
    const st = getStatus(result.back)
    const debts = ['car', 'student', 'creditCard', 'other'].reduce(
      (sum, k) => sum + (parseFloat(form[k as keyof typeof form]) || 0), 0
    )
    onSendToChat(
      `**DTI Calculator Results**\n\n` +
      `**Borrower Profile:**\n` +
      `- Gross Monthly Income: $${Number(form.income).toLocaleString()}\n` +
      `- Proposed PITI: $${Number(form.piti).toLocaleString()}\n` +
      `- Car Payment: $${Number(form.car || '0').toLocaleString()}\n` +
      `- Student Loans: $${Number(form.student || '0').toLocaleString()}\n` +
      `- Credit Card Minimums: $${Number(form.creditCard || '0').toLocaleString()}\n` +
      `- Other Monthly Debts: $${Number(form.other || '0').toLocaleString()}\n` +
      `- Total Monthly Obligations: $${debts.toLocaleString()}\n\n` +
      `**Calculated Ratios:**\n` +
      `- Front-End DTI: ${result.front.toFixed(1)}%\n` +
      `- Back-End DTI: ${result.back.toFixed(1)}%\n` +
      `- Status: ${st.icon} ${st.label}\n\n` +
      `Please provide a full analysis: which loan programs are viable, any compensating factors that could help, and strategies to improve this DTI.`
    )
  }

  const fields = [
    { label: 'Gross Monthly Income ($)', key: 'income' },
    { label: 'Proposed PITI ($)', key: 'piti' },
    { label: 'Car Payment ($)', key: 'car' },
    { label: 'Student Loans ($)', key: 'student' },
    { label: 'Credit Card Minimums ($)', key: 'creditCard' },
    { label: 'Other Monthly Debts ($)', key: 'other' },
  ]

  return (
    <div className="space-y-2">
      {fields.map(({ label, key }) => (
        <div key={key}>
          <label className="block text-xs text-slate-500 mb-0.5">{label}</label>
          <input
            type="number"
            value={form[key as keyof typeof form]}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            className={inp}
            placeholder="0"
          />
        </div>
      ))}
      <button
        onClick={calculate}
        className="w-full py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
      >
        Calculate DTI
      </button>
      {result && (() => {
        const st = getStatus(result.back)
        return (
          <div className={`rounded-lg border p-3 ${st.color}`}>
            <div className="flex justify-between text-xs font-medium mb-1">
              <span>Front-End DTI</span><span>{result.front.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between text-xs font-bold mb-2">
              <span>Back-End DTI</span><span>{result.back.toFixed(1)}%</span>
            </div>
            <div className="text-xs font-semibold">{st.icon} {st.label}</div>
            <button
              onClick={sendToChat}
              className="mt-2 w-full py-1 bg-white/60 border border-current text-xs font-medium rounded-md hover:bg-white/80 transition-colors"
            >
              Send to Chat →
            </button>
          </div>
        )
      })()}
    </div>
  )
}

// ── Condition Letter Drafter ───────────────────────────────────────────────────
function ConditionDrafter({ onSendToChat }: { onSendToChat: (msg: string) => void }) {
  const [form, setForm] = useState({
    borrower: '', loanNo: '', condition: '', explanation: '', documents: '',
    date: new Date().toISOString().split('T')[0],
  })
  const [loading, setLoading] = useState(false)
  const [letter, setLetter] = useState('')
  const [copied, setCopied] = useState(false)

  const inp = 'w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white'

  async function draftLetter() {
    if (!form.condition.trim() || !form.borrower.trim()) return
    setLoading(true)
    setLetter('')
    try {
      const res = await fetch('/api/underwriting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Draft a professional letter of explanation/condition response with these details:\n\nBorrower: ${form.borrower}\nLoan #: ${form.loanNo || 'N/A'}\nDate: ${form.date}\nUW Condition: ${form.condition}\nExplanation: ${form.explanation || 'N/A'}\nSupporting Docs: ${form.documents || 'See attached'}\n\nWrite a complete, formal, ready-to-submit letter.`,
          }],
          systemPrompt: 'You are a mortgage loan assistant drafting professional letters of explanation (LOE) and condition response letters for underwriters. Write formal letters with proper salutation, body paragraphs, and closing. Keep it factual, concise, and professional. Do not use markdown — format as plain text exactly as a real business letter would appear.',
        }),
      })
      const data = await res.json()
      setLetter(data.content || data.error || '')
    } finally {
      setLoading(false)
    }
  }

  function copyLetter() {
    navigator.clipboard.writeText(letter)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-2">
      <input placeholder="Borrower Name *" value={form.borrower}
        onChange={e => setForm(f => ({ ...f, borrower: e.target.value }))} className={inp} />
      <input placeholder="Loan Number" value={form.loanNo}
        onChange={e => setForm(f => ({ ...f, loanNo: e.target.value }))} className={inp} />
      <input type="date" value={form.date}
        onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={inp} />
      <textarea placeholder="UW Condition (as written) *" value={form.condition} rows={2}
        onChange={e => setForm(f => ({ ...f, condition: e.target.value }))} className={inp + ' resize-none'} />
      <textarea placeholder="Borrower's explanation" value={form.explanation} rows={2}
        onChange={e => setForm(f => ({ ...f, explanation: e.target.value }))} className={inp + ' resize-none'} />
      <input placeholder="Supporting documents being provided" value={form.documents}
        onChange={e => setForm(f => ({ ...f, documents: e.target.value }))} className={inp} />
      <button
        onClick={draftLetter}
        disabled={loading || !form.condition.trim() || !form.borrower.trim()}
        className="w-full py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
      >
        {loading ? <><Loader2 className="w-3 h-3 animate-spin" />Drafting…</> : 'Draft with AI'}
      </button>
      {letter && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">{letter}</pre>
          <div className="flex gap-1.5 mt-2 pt-2 border-t border-slate-200">
            <button onClick={copyLetter}
              className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded px-2 py-1 hover:bg-white transition-colors">
              {copied ? <><Check className="w-3 h-3" />Copied!</> : <><Copy className="w-3 h-3" />Copy</>}
            </button>
            <button
              onClick={() => onSendToChat(`Here is the drafted condition response letter for ${form.borrower}:\n\n${letter}\n\nPlease review this letter and suggest any improvements or flag any issues before we submit to underwriting.`)}
              className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded px-2 py-1 hover:bg-indigo-50 transition-colors"
            >
              <Send className="w-3 h-3" />Send to Chat
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Fee Sheet Builder ──────────────────────────────────────────────────────────
function FeeSheetBuilder({ onSendToChat }: { onSendToChat: (msg: string) => void }) {
  const [form, setForm] = useState({
    loanAmount: '', purchasePrice: '', interestRate: '', term: '30',
    origination: '', appraisal: '', titleInsurance: '', escrow: '',
    recording: '', prepaids: '', initialEscrow: '',
    extras: [{ label: '', amount: '' }, { label: '', amount: '' }],
  })
  const [sheet, setSheet] = useState('')

  const inp = 'w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white'

  function buildSheet() {
    const n = (k: string) => parseFloat((form as Record<string, string>)[k]) || 0
    const la = n('loanAmount'), pp = n('purchasePrice')
    const sA = n('origination')
    const sB = n('appraisal') + n('titleInsurance')
    const sC = n('escrow') + n('recording')
    const prepaids = n('prepaids') + n('initialEscrow')
    const extraTotal = form.extras.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
    const totalCC = sA + sB + sC + prepaids + extraTotal
    const downPmt = pp ? pp - la : null
    const cashToClose = pp ? (downPmt ?? 0) + totalCC : null

    const lines = [
      '═══════════════════════════════════════',
      '       LOAN FEE SUMMARY',
      '═══════════════════════════════════════',
      `Loan Amount:       $${la.toLocaleString()}`,
      form.interestRate ? `Interest Rate:     ${form.interestRate}%  (${form.term}-yr fixed)` : '',
      pp ? `Purchase Price:    $${pp.toLocaleString()}` : '',
      '',
      'SECTION A — Origination Charges',
      `  Origination Fee:          $${n('origination').toLocaleString()}`,
      `  ─────────────────────────────────────`,
      `  Section A Total:          $${sA.toLocaleString()}`,
      '',
      'SECTION B — Services (Cannot Shop)',
      `  Appraisal Fee:            $${n('appraisal').toLocaleString()}`,
      `  Title Insurance:          $${n('titleInsurance').toLocaleString()}`,
      `  ─────────────────────────────────────`,
      `  Section B Total:          $${sB.toLocaleString()}`,
      '',
      'SECTION C — Services (Can Shop)',
      `  Escrow / Settlement:      $${n('escrow').toLocaleString()}`,
      `  Recording Fees:           $${n('recording').toLocaleString()}`,
      `  ─────────────────────────────────────`,
      `  Section C Total:          $${sC.toLocaleString()}`,
      '',
      'PREPAIDS & INITIAL ESCROW',
      `  Prepaid Interest:         $${n('prepaids').toLocaleString()}`,
      `  Initial Escrow Impound:   $${n('initialEscrow').toLocaleString()}`,
      ...form.extras.filter(e => e.label && e.amount).map(
        e => `  ${e.label.padEnd(24)}$${Number(e.amount).toLocaleString()}`
      ),
      '',
      '═══════════════════════════════════════',
      `TOTAL CLOSING COSTS:       $${totalCC.toLocaleString()}`,
      ...(cashToClose != null ? [
        `DOWN PAYMENT:              $${(downPmt ?? 0).toLocaleString()}`,
        `EST. CASH TO CLOSE:        $${cashToClose.toLocaleString()}`,
      ] : []),
      '═══════════════════════════════════════',
    ].filter(l => l !== undefined)

    setSheet(lines.join('\n'))
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {[
          { label: 'Loan Amount ($)', key: 'loanAmount', placeholder: '450000' },
          { label: 'Purchase Price ($)', key: 'purchasePrice', placeholder: 'optional' },
          { label: 'Rate (%)', key: 'interestRate', placeholder: '6.75' },
        ].map(({ label, key, placeholder }) => (
          <div key={key} className={key === 'loanAmount' ? 'col-span-2' : ''}>
            <label className="block text-xs text-slate-500 mb-0.5">{label}</label>
            <input type="number" step="0.125" placeholder={placeholder}
              value={(form as Record<string, string>)[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className={inp} />
          </div>
        ))}
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">Term (yrs)</label>
          <select value={form.term} onChange={e => setForm(f => ({ ...f, term: e.target.value }))} className={inp}>
            <option value="30">30</option>
            <option value="15">15</option>
            <option value="20">20</option>
          </select>
        </div>
      </div>

      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider pt-1">Fees</div>
      {[
        { label: 'Origination ($)', key: 'origination' },
        { label: 'Appraisal ($)', key: 'appraisal' },
        { label: 'Title Insurance ($)', key: 'titleInsurance' },
        { label: 'Escrow/Settlement ($)', key: 'escrow' },
        { label: 'Recording ($)', key: 'recording' },
        { label: 'Prepaid Interest ($)', key: 'prepaids' },
        { label: 'Initial Escrow ($)', key: 'initialEscrow' },
      ].map(({ label, key }) => (
        <div key={key} className="flex items-center gap-2">
          <label className="text-xs text-slate-500 w-32 shrink-0">{label}</label>
          <input type="number" placeholder="0"
            value={(form as Record<string, string>)[key]}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            className={inp} />
        </div>
      ))}

      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider pt-1">Other Fees</div>
      {form.extras.map((ex, idx) => (
        <div key={idx} className="flex gap-1.5">
          <input placeholder="Fee name" value={ex.label}
            onChange={e => setForm(f => ({ ...f, extras: f.extras.map((x, i) => i === idx ? { ...x, label: e.target.value } : x) }))}
            className={inp} />
          <input type="number" placeholder="$" value={ex.amount}
            onChange={e => setForm(f => ({ ...f, extras: f.extras.map((x, i) => i === idx ? { ...x, amount: e.target.value } : x) }))}
            className={inp + ' w-20 shrink-0'} />
        </div>
      ))}

      <button
        onClick={buildSheet}
        className="w-full py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
      >
        Build Fee Sheet
      </button>

      {sheet && (
        <div className="bg-slate-900 rounded-lg p-3">
          <pre className="text-xs text-green-300 font-mono whitespace-pre leading-relaxed overflow-x-auto max-h-56 overflow-y-auto">{sheet}</pre>
          <button
            onClick={() => onSendToChat(`Here is the fee sheet I built:\n\`\`\`\n${sheet}\n\`\`\`\n\nPlease review these closing costs and flag anything that looks off, is missing, or seems high for a standard transaction.`)}
            className="mt-2 flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <Send className="w-3 h-3" /> Send to Chat
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function UnderwritingPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [activeTool, setActiveTool] = useState<ActiveTool>(null)
  const [isDragging, setIsDragging] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || loading) return

    // Encode any attached files to base64 before clearing state
    const attachedFiles = files.slice()
    const fileNames = attachedFiles.map(f => f.name)

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      fileNames: fileNames.length ? fileNames : undefined,
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = '24px'
    setFiles([])
    setLoading(true)
    setActiveTool(null)

    try {
      // Convert files to base64 payloads
      const filePayloads: FilePayload[] = await Promise.all(
        attachedFiles.map(async f => ({
          name: f.name,
          type: f.type,
          data: await fileToBase64(f),
        }))
      )

      const res = await fetch('/api/underwriting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          files: filePayloads,
          systemPrompt: SYSTEM_PROMPT,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.content || (data.error ? `⚠️ ${data.error}` : 'No response received.'),
      }])
    } catch {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '⚠️ Connection error. Please check your API key configuration and try again.',
      }])
    } finally {
      setLoading(false)
    }
  }, [messages, loading, files])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return
    const allowed = Array.from(fileList).filter(f =>
      ['application/pdf', 'image/png', 'image/jpeg'].includes(f.type)
    )
    setFiles(prev => [...prev, ...allowed].slice(0, 5))
  }

  function toggleTool(tool: ActiveTool) {
    setActiveTool(prev => prev === tool ? null : tool)
  }

  return (
    <div className="h-full flex overflow-hidden bg-white">

      {/* ── UW Tool Sidebar ─────────────────────────────────────────── */}
      <div className="w-72 border-r border-slate-200 flex flex-col overflow-y-auto bg-slate-50 shrink-0">

        {/* Header */}
        <div className="px-4 py-4 border-b border-slate-200 bg-white shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center">
              <Brain className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">AI Underwriter</p>
              <p className="text-xs text-slate-500">Lumin Lending · Powered by Claude</p>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <SidebarSection title="Quick Actions" icon={Zap}>
          <div className="space-y-0.5">
            {QUICK_ACTIONS.map(a => (
              <ActionBtn key={a.label} label={a.label} onClick={() => sendMessage(a.prompt)} />
            ))}
          </div>
        </SidebarSection>

        {/* Rocket Programs */}
        <SidebarSection title="Rocket Programs" defaultOpen={false}>
          <div className="space-y-0.5">
            {ROCKET_PROGRAMS.map(a => (
              <ActionBtn key={a.label} label={a.label} onClick={() => sendMessage(a.prompt)} />
            ))}
          </div>
        </SidebarSection>

        {/* Tools */}
        <SidebarSection title="Tools" icon={Calculator}>
          <div className="space-y-1.5">

            {/* DTI Calculator */}
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <button
                onClick={() => toggleTool('dti')}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Calculator className="w-3.5 h-3.5 text-indigo-500" />
                  DTI Calculator
                </div>
                {activeTool === 'dti' ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
              </button>
              {activeTool === 'dti' && (
                <div className="px-3 pb-3 pt-1 border-t border-slate-100">
                  <DTICalculator onSendToChat={msg => sendMessage(msg)} />
                </div>
              )}
            </div>

            {/* Condition Drafter */}
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <button
                onClick={() => toggleTool('condition')}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-purple-500" />
                  Condition Letter Drafter
                </div>
                {activeTool === 'condition' ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
              </button>
              {activeTool === 'condition' && (
                <div className="px-3 pb-3 pt-1 border-t border-slate-100">
                  <ConditionDrafter onSendToChat={msg => sendMessage(msg)} />
                </div>
              )}
            </div>

            {/* Fee Sheet Builder */}
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <button
                onClick={() => toggleTool('fee')}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <DollarSign className="w-3.5 h-3.5 text-emerald-500" />
                  Fee Sheet Builder
                </div>
                {activeTool === 'fee' ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
              </button>
              {activeTool === 'fee' && (
                <div className="px-3 pb-3 pt-1 border-t border-slate-100">
                  <FeeSheetBuilder onSendToChat={msg => sendMessage(msg)} />
                </div>
              )}
            </div>

          </div>
        </SidebarSection>

        {/* Document Upload */}
        <SidebarSection title="Document Upload" icon={Upload} defaultOpen={false}>
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files) }}
            onClick={() => fileInputRef.current?.click()}
            className={`rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${
              isDragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 hover:bg-white'
            }`}
          >
            <Upload className="w-5 h-5 text-slate-400 mx-auto mb-1.5" />
            <p className="text-xs text-slate-500 font-medium">Drop files or click to upload</p>
            <p className="text-xs text-slate-400 mt-0.5">Pay stubs · W2s · Bank statements · Tax returns</p>
            <input ref={fileInputRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg"
              className="hidden" onChange={e => handleFiles(e.target.files)} />
          </div>
          {files.length > 0 && (
            <div className="mt-2 space-y-1">
              {files.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-3 py-1.5">
                  <span className="text-xs text-slate-600 truncate">📎 {file.name}</span>
                  <button onClick={() => setFiles(f => f.filter((_, i) => i !== idx))}
                    className="ml-2 text-slate-400 hover:text-red-500 shrink-0 transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SidebarSection>

        {/* Team */}
        <SidebarSection title="Team" icon={Users} defaultOpen={false}>
          <div className="space-y-2">
            {[
              { name: 'Moe Sefati', role: 'Loan Officer', initials: 'MS', color: 'bg-blue-100 text-blue-700' },
              { name: 'Matt', role: 'Loan Officer', initials: 'M', color: 'bg-emerald-100 text-emerald-700' },
              { name: 'Randy Mathis', role: 'Loan Officer', initials: 'RM', color: 'bg-violet-100 text-violet-700' },
              { name: 'Efrain', role: 'Loan Assistant', initials: 'E', color: 'bg-indigo-100 text-indigo-700' },
            ].map(({ name, role, initials, color }) => (
              <div key={name} className="flex items-center gap-2.5 px-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${color}`}>
                  {initials}
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-700">{name}</p>
                  <p className="text-xs text-slate-400">{role}</p>
                </div>
              </div>
            ))}
          </div>
        </SidebarSection>

      </div>

      {/* ── Chat Area ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Messages / Welcome */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center mb-5 shadow-lg shadow-indigo-200">
                <Brain className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900 mb-2">Welcome back, Efrain</h1>
              <p className="text-slate-500 text-sm max-w-md leading-relaxed mb-8">
                Your AI underwriting assistant for Lumin Lending. Ask anything about loan guidelines,
                income analysis, document review, or borrower scenarios.
              </p>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {WELCOME_CHIPS.map(chip => (
                  <button
                    key={chip.label}
                    onClick={() => sendMessage(chip.prompt)}
                    className="px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 transition-colors shadow-sm"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-6 py-6 space-y-5 max-w-3xl mx-auto">
              {messages.map(msg => (
                <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                      <Brain className="w-4 h-4 text-white" />
                    </div>
                  )}
                  <div className={`max-w-[78%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-tr-sm'
                      : 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm shadow-sm'
                  }`}>
                    {msg.role === 'user' ? (
                      <>
                        {msg.fileNames && msg.fileNames.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {msg.fileNames.map(name => (
                              <span key={name} className="flex items-center gap-1 text-xs bg-indigo-500 text-indigo-100 rounded-full px-2.5 py-0.5">
                                📎 {name}
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      </>
                    ) : (
                      <MarkdownContent text={msg.content} />
                    )}
                  </div>
                </div>
              ))}

              {/* Typing indicator */}
              {loading && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5">
                    <Brain className="w-4 h-4 text-white" />
                  </div>
                  <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3.5 shadow-sm">
                    <div className="flex gap-1.5 items-center h-4">
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-300ms]" />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-150ms]" />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Attached files bar */}
        {files.length > 0 && (
          <div className="px-6 py-2 flex gap-2 flex-wrap border-t border-slate-100 bg-slate-50 shrink-0">
            {files.map((f, i) => (
              <span key={i} className="flex items-center gap-1.5 text-xs bg-white border border-slate-200 rounded-full px-3 py-1 text-slate-600">
                📎 {f.name}
                <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-red-500 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input bar */}
        <div className="border-t border-slate-200 bg-white px-6 py-4 shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 focus-within:border-indigo-300 focus-within:bg-white transition-colors">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px'
                }}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Ask about guidelines, income analysis, borrower scenarios… (Shift+Enter for newline)"
                className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 resize-none focus:outline-none leading-6"
                style={{ minHeight: '24px' }}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || loading}
                className="w-9 h-9 bg-indigo-600 text-white rounded-xl flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-center text-slate-400 mt-2">
              Rocket Mortgage · Fannie Mae · Freddie Mac · FHA · VA guidelines
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
