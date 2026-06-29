'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { LENDER_SECTIONS, type Lender } from '@/lib/lenders'

export type EditableLender = Lender & { id: string }

// Union of product badges across all sections (1sts + 2nds).
const PRODUCT_OPTIONS = ['CONV', 'VA', 'FHA', '<580', 'Jumbo', 'Agency', 'Non-QM 2nd', 'HELOAN', 'Piggyback 2nd']
const ARIVE_OPTIONS: [string, string][] = [['', '—'], ['Yes', 'Yes'], ['No', 'No'], ['off', 'off']]

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400'

export default function LenderEditModal({
  lender, onSave, onClose, onDelete,
}: {
  lender: EditableLender
  onSave: (l: EditableLender) => void
  onClose: () => void
  onDelete: (l: EditableLender) => void
}) {
  const [form, setForm] = useState<EditableLender>(lender)

  function set<K extends keyof EditableLender>(k: K, v: EditableLender[K]) {
    setForm(f => ({ ...f, [k]: v }))
  }
  function setCategory(key: string) {
    const label = LENDER_SECTIONS.find(s => s.key === key)?.label ?? key
    setForm(f => ({ ...f, category: key, categoryLabel: label }))
  }
  function toggleProduct(p: string) {
    setForm(f => ({ ...f, products: f.products.includes(p) ? f.products.filter(x => x !== p) : [...f.products, p] }))
  }
  function save() {
    if (!form.lender.trim()) return
    onSave({ ...form, lender: form.lender.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 shrink-0">
          <h2 className="text-base font-bold text-slate-900">Edit lender</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 overflow-auto">
          <Field label="Lender name *">
            <input className={inputCls} value={form.lender} onChange={e => set('lender', e.target.value)} autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Section">
              <select className={inputCls} value={form.category} onChange={e => setCategory(e.target.value)}>
                {LENDER_SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="In Arive">
              <select className={inputCls} value={form.inArive} onChange={e => set('inArive', e.target.value)}>
                {ARIVE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="AE / Contact">
              <input className={inputCls} value={form.contact} onChange={e => set('contact', e.target.value)} />
            </Field>
            <Field label="Phone">
              <input className={inputCls} value={form.phone} onChange={e => set('phone', e.target.value)} />
            </Field>
          </div>

          <Field label="Email">
            <input className={inputCls} value={form.email} onChange={e => set('email', e.target.value)} />
          </Field>

          <Field label="Products">
            <div className="flex flex-wrap gap-1.5">
              {PRODUCT_OPTIONS.map(p => {
                const on = form.products.includes(p)
                return (
                  <button
                    key={p} type="button" onClick={() => toggleProduct(p)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                      on ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Min FICO">
              <input className={inputCls} value={form.minFico} onChange={e => set('minFico', e.target.value)} />
            </Field>
            <Field label="Comp (LPC/BPC)">
              <input className={inputCls} value={form.comp} onChange={e => set('comp', e.target.value)} />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              className={`${inputCls} min-h-[90px] resize-y`} value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </Field>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 shrink-0">
          <button
            onClick={() => { if (confirm(`Remove "${form.lender}" from the list?`)) onDelete(form) }}
            className="text-xs font-medium text-red-600 hover:text-red-700 px-2 py-1"
          >
            Delete lender
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm font-medium text-slate-600 hover:text-slate-800 px-3 py-2">
              Cancel
            </button>
            <button
              onClick={save} disabled={!form.lender.trim()}
              className="text-sm font-semibold text-white bg-blue-600 rounded-lg px-4 py-2 hover:bg-blue-700 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
