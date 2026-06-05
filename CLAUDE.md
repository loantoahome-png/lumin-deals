@AGENTS.md

# Working rules (do not skip)

## No guessing — verify before you respond
Before stating a cause, fix, or "what changed," gather the facts first. Do the
research, then answer. Specifically:

- **Diagnose from evidence, not hunches.** Read the actual code, query the real
  data (Supabase), check `vercel logs`, the GHL API, or reproduce the issue
  before naming a root cause. If a claim can be checked, check it.
- **Don't assert a fix worked unless it was verified** (tsc passes, build
  passes, data confirmed, logs/response observed). "Should work" is not done.
- **Separate fact from hypothesis.** If something genuinely cannot be verified
  yet, say so explicitly ("I haven't confirmed this — here's how I'll find
  out") instead of presenting a guess as the answer.
- **When a fix doesn't hold, stop and instrument/investigate** (logs, repro,
  data) rather than shipping another guess. One verified fix beats three
  plausible ones.
- **Prefer reading the source of truth** (the code, the DB row, the API
  response, the log line) over inferring from symptoms or memory.
