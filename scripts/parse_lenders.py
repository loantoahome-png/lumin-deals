#!/usr/bin/env python3
"""Generate lib/lenders.ts from an "Approved Lumin Lenders" CSV export.

The source sheet is a living doc (lenders added/removed, Arive-setup status,
pricing notes change). When it changes: export the sheet to CSV and re-run:

    python3 scripts/parse_lenders.py "/path/to/Approved Lumin Lenders X.X.csv"

That overwrites lib/lenders.ts in place. Commit + redeploy as usual.

The export is ISO-8859-1 with several stacked tables (each its own banner +
'Lender' header row), differing column schemas, and NBSP (\\xa0) mojibake.
This normalizes everything into one flat, typed record shape.
"""
import csv, json, sys, re, os

DEFAULT_SRC = "/Users/efrainramirez/Downloads/Approved Lumin Lenders 9.4.csv"
TS_OUT = os.path.join(os.path.dirname(__file__), "..", "lib", "lenders.ts")

# Ordered section banners exactly as they appear in any cell of a banner row.
SECTIONS = [
    "Agency/Jumbo",
    "500-580 FHA/VA Govie Lenders",
    "NON-QM",
    "No Income/No Ratio",
    "Agency 2nds and Non-QM 2nds",
    "Private Money Lenders (Max 55-65% LTV)",
    "Bridge Loans (Buy B4 Sell)",
    "Home Equity Conversion Mortgage (Reverse)",
    "SBA Loans",
    "Home Equity Investments",
]
STANDARD = {"Agency/Jumbo", "500-580 FHA/VA Govie Lenders", "NON-QM",
            "No Income/No Ratio", "SBA Loans", "Home Equity Investments"}
SECONDS = {"Agency 2nds and Non-QM 2nds"}
SPARSE = {"Private Money Lenders (Max 55-65% LTV)", "Bridge Loans (Buy B4 Sell)",
          "Home Equity Conversion Mortgage (Reverse)"}

# Friendlier display labels for the sidebar/filter chips.
LABEL = {
    "Agency/Jumbo": "Agency / Jumbo",
    "500-580 FHA/VA Govie Lenders": "500-580 Govie",
    "NON-QM": "Non-QM",
    "No Income/No Ratio": "No Income / No Ratio",
    "Agency 2nds and Non-QM 2nds": "2nds (Agency & Non-QM)",
    "Private Money Lenders (Max 55-65% LTV)": "Private Money",
    "Bridge Loans (Buy B4 Sell)": "Bridge (Buy-B4-Sell)",
    "Home Equity Conversion Mortgage (Reverse)": "Reverse (HECM)",
    "SBA Loans": "SBA",
    "Home Equity Investments": "Home Equity Investment",
}


def clean(s):
    s = (s or "").replace("\xa0", " ").replace("​", "")
    s = re.sub(r"\s*[\r\n]+\s*", " / ", s)   # multi-line cells -> ' / '
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip(" /").strip()


def is_x(s):
    return clean(s).lower() == "x"


def parse(src):
    with open(src, encoding="cp1252") as fh:
        rows = list(csv.reader(fh))

    records, section, last, orphan_notes = [], None, None, []

    for r in rows:
        cells = [clean(c) for c in r]
        if not any(cells):
            continue
        banner = next((s for s in SECTIONS if s in cells), None)
        if banner:
            section, last = banner, None
            continue
        if section is None:
            continue
        if cells and cells[0] == "Lender":
            continue

        def g(i):
            return cells[i] if len(cells) > i else ""

        lender = g(0)

        if section in SECONDS:
            prodmap = [(5, "Agency"), (6, "Non-QM 2nd"), (7, "HELOAN"), (8, "Piggyback 2nd")]
            products = [lab for i, lab in prodmap if is_x(g(i))]
            nq, fd = g(9), g(10)
            fico = " / ".join(p for p in [f"{nq} NQ" if nq else "", f"{fd} Full" if fd else ""] if p)
            comp, notes = g(11), g(12)
        elif section in STANDARD:
            prodmap = [(5, "CONV"), (6, "VA"), (7, "FHA"), (8, "<580"), (9, "Jumbo")]
            products = [lab for i, lab in prodmap if is_x(g(i))]
            fico, comp, notes = g(10), g(11), g(12)
        else:  # SPARSE
            products, fico, comp = [], "", ""
            notes = " — ".join(p for p in [g(5), g(12)]
                               if p and p not in ("Website", "Pricing", "NOTES", "Notes"))

        # Orphan continuation row (no lender name) -> stash to previous lender.
        if not lender:
            bits = [c for c in cells[1:] if c and c.lower() not in ("no", "yes", "off")]
            if bits and last is not None:
                orphan_notes.append(" ".join(bits))
                last["_orphans"] = orphan_notes[:]
            continue
        orphan_notes = []

        rec = {
            "category": section, "categoryLabel": LABEL[section], "lender": lender,
            "inArive": g(1), "contact": g(2), "phone": g(3), "email": g(4),
            "products": products, "minFico": fico, "comp": comp, "notes": notes,
        }
        records.append(rec)
        last = rec

    for rec in records:
        orph = rec.pop("_orphans", None)
        if orph:
            rec["notes"] = (rec["notes"] + "  [Additional notes (verify owner): "
                            + " · ".join(orph) + "]").strip()
    return records


def emit_ts(records, path):
    sections_ts = ",\n  ".join(
        f'{{ key: {json.dumps(s)}, label: {json.dumps(LABEL[s])} }}' for s in SECTIONS)
    rows_ts = ",\n  ".join(json.dumps(r, ensure_ascii=False) for r in records)
    ts = f'''// AUTO-GENERATED from an "Approved Lumin Lenders" CSV export.
// Do not edit by hand — regenerate with: python3 scripts/parse_lenders.py <csv>

export interface Lender {{
  /** Raw section key from the sheet (stable identifier). */
  category: string
  /** Human-friendly section label for chips/headers. */
  categoryLabel: string
  lender: string
  /** Set up in Arive? 'Yes' | 'No' | 'off' | '' (raw from sheet). */
  inArive: string
  contact: string
  phone: string
  email: string
  /** Eligibility badges that were marked for this lender. */
  products: string[]
  /** Min FICO (for 2nds: "<nq> NQ / <fd> Full"). */
  minFico: string
  /** Comp — LPC/BPC. */
  comp: string
  notes: string
}}

export const LENDER_SECTIONS: {{ key: string; label: string }}[] = [
  {sections_ts},
]

export const LENDERS: Lender[] = [
  {rows_ts},
]
'''
    with open(path, "w") as fh:
        fh.write(ts)


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    recs = parse(src)
    from collections import Counter
    counts = Counter(r["category"] for r in recs)
    print("Parsed lenders by section:")
    for s in SECTIONS:
        print(f"  {counts.get(s, 0):>3}  {s}")
    print(f"  ---\n  {len(recs):>3}  TOTAL")
    out = os.path.normpath(TS_OUT)
    emit_ts(recs, out)
    print(f"\nWrote {out} ({len(recs)} records)")
