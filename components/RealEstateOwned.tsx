'use client'

import { Plus, Trash2, Home, X } from 'lucide-react'
import type { REOProperty, REOLien } from '@/lib/types'

const inp = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors'
const inpCurrency = 'w-full pl-7 pr-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white hover:border-slate-300 transition-colors tabular-nums'

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

const PROPERTY_TYPES = [
  'Single Family', 'Condo', 'Townhouse', 'Multi-Family (2-4)',
  'Manufactured', 'Land', 'Commercial',
]
const OCCUPANCY_TYPES = ['Primary', 'Second Home', 'Investment / Rental']
const LIEN_TYPES = ['1st Mortgage', '2nd Mortgage', 'HELOC', 'Hard Money', 'Other']

export default function RealEstateOwned({ value, onChange }: {
  value: REOProperty[]
  onChange: (next: REOProperty[]) => void
}) {
  const properties = value || []

  function addProperty() {
    onChange([
      ...properties,
      { id: uid(), address: null, estimated_value: null, property_type: null, occupancy: null, liens: [] },
    ])
  }
  function updateProperty(id: string, updates: Partial<REOProperty>) {
    onChange(properties.map(p => p.id === id ? { ...p, ...updates } : p))
  }
  function deleteProperty(id: string) {
    if (!confirm('Remove this property?')) return
    onChange(properties.filter(p => p.id !== id))
  }

  function addLien(propertyId: string) {
    const p = properties.find(x => x.id === propertyId)
    if (!p) return
    updateProperty(propertyId, {
      liens: [...(p.liens || []), { id: uid(), holder: null, type: null, balance: null }],
    })
  }
  function updateLien(propertyId: string, lienId: string, updates: Partial<REOLien>) {
    const p = properties.find(x => x.id === propertyId)
    if (!p) return
    updateProperty(propertyId, {
      liens: (p.liens || []).map(l => l.id === lienId ? { ...l, ...updates } : l),
    })
  }
  function deleteLien(propertyId: string, lienId: string) {
    const p = properties.find(x => x.id === propertyId)
    if (!p) return
    updateProperty(propertyId, { liens: (p.liens || []).filter(l => l.id !== lienId) })
  }

  return (
    <div>
      {properties.length === 0 ? (
        <p className="text-sm text-slate-400 mb-3">No properties added yet. Click below to add the borrower&apos;s real estate.</p>
      ) : (
        <div className="space-y-3 mb-3">
          {properties.map((p, idx) => {
            const liens = p.liens || []
            const totalLiens = liens.reduce((s, l) => s + (l.balance || 0), 0)
            const hasValue = p.estimated_value != null && p.estimated_value > 0
            const equity = hasValue ? (p.estimated_value as number) - totalLiens : null
            const ltv = hasValue && totalLiens > 0 ? (totalLiens / (p.estimated_value as number) * 100) : null

            return (
              <div key={p.id} className="border border-slate-200 rounded-lg overflow-hidden bg-white">
                {/* Header */}
                <div className="bg-slate-50 px-4 py-2 flex items-center justify-between border-b border-slate-100">
                  <div className="flex items-center gap-2 text-xs text-slate-600 min-w-0">
                    <Home className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                    <span className="font-semibold truncate">
                      {p.address?.trim() || `Property ${idx + 1}`}
                    </span>
                    {p.occupancy && (
                      <span className="text-[10px] uppercase tracking-wider font-medium text-slate-400 shrink-0">
                        · {p.occupancy}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteProperty(p.id)}
                    className="text-slate-400 hover:text-red-500 hover:bg-red-50 rounded p-1 transition"
                    title="Remove property"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Body */}
                <div className="p-4 space-y-3">
                  {/* Address */}
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Property Address</label>
                    <input
                      value={p.address || ''}
                      onChange={e => updateProperty(p.id, { address: e.target.value })}
                      className={inp}
                    />
                  </div>

                  {/* Value / Type / Occupancy */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Est. Value</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">$</span>
                        <input
                          type="number"
                          value={p.estimated_value ?? ''}
                          onChange={e => updateProperty(p.id, { estimated_value: e.target.value ? Number(e.target.value) : null })}
                          className={inpCurrency}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Property Type</label>
                      <select
                        value={p.property_type || ''}
                        onChange={e => updateProperty(p.id, { property_type: e.target.value || null })}
                        className={inp}
                      >
                        <option value="">—</option>
                        {PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Occupancy</label>
                      <select
                        value={p.occupancy || ''}
                        onChange={e => updateProperty(p.id, { occupancy: e.target.value || null })}
                        className={inp}
                      >
                        <option value="">—</option>
                        {OCCUPANCY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Summary stats (only when there's something to compute) */}
                  {(hasValue || totalLiens > 0) && (
                    <div className="flex items-center gap-4 text-xs bg-slate-50 rounded-md px-3 py-2 border border-slate-100">
                      {totalLiens > 0 && (
                        <span className="text-slate-600">
                          <span className="text-slate-400">Total liens</span>{' '}
                          <span className="font-semibold text-slate-800 tabular-nums">${totalLiens.toLocaleString()}</span>
                        </span>
                      )}
                      {equity != null && (
                        <span className="text-slate-600">
                          <span className="text-slate-400">Equity</span>{' '}
                          <span className={`font-semibold tabular-nums ${equity >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            ${equity.toLocaleString()}
                          </span>
                        </span>
                      )}
                      {ltv != null && (
                        <span className="text-slate-600">
                          <span className="text-slate-400">LTV</span>{' '}
                          <span className={`font-semibold tabular-nums ${ltv > 80 ? 'text-amber-700' : 'text-slate-800'}`}>
                            {ltv.toFixed(1)}%
                          </span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Liens */}
                  <div className="border-t border-slate-100 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        Liens {liens.length > 0 && <span className="text-slate-400">({liens.length})</span>}
                      </h4>
                      <button
                        type="button"
                        onClick={() => addLien(p.id)}
                        className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        <Plus className="w-3 h-3" /> Add Lien
                      </button>
                    </div>

                    {liens.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">No liens recorded.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {liens.map(l => (
                          <div key={l.id} className="flex items-center gap-2">
                            <input
                              value={l.holder || ''}
                              onChange={e => updateLien(p.id, l.id, { holder: e.target.value })}
                              placeholder="Lender"
                              className={`${inp} flex-1 placeholder:text-slate-300`}
                            />
                            <select
                              value={l.type || ''}
                              onChange={e => updateLien(p.id, l.id, { type: e.target.value || null })}
                              className={`${inp} w-36 shrink-0`}
                            >
                              <option value="">Type —</option>
                              {LIEN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                            <div className="relative w-36 shrink-0">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">$</span>
                              <input
                                type="number"
                                value={l.balance ?? ''}
                                onChange={e => updateLien(p.id, l.id, { balance: e.target.value ? Number(e.target.value) : null })}
                                placeholder="Balance"
                                className={`${inpCurrency} placeholder:text-slate-300`}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => deleteLien(p.id, l.id)}
                              className="text-slate-400 hover:text-red-500 hover:bg-red-50 rounded p-1.5 shrink-0 transition"
                              title="Remove lien"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <button
        type="button"
        onClick={addProperty}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition"
      >
        <Plus className="w-3.5 h-3.5" /> Add Property
      </button>
    </div>
  )
}
