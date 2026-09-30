\# Studio Karol Duarte: new system



\## Stack

Vite + React + TypeScript + Tailwind. Supabase (Postgres, Auth, Edge Functions). Deploy: Vercel via GitHub.



\## Hard rules

\- Money = integer cents. Time = timestamptz, TZ America/Sao\_Paulo.

\- Every write goes through rpc\_\*. UI and agent call the same rpc\_\*. Never rename an rpc\_\* or error code.

\- No stored status or counters. Derive in views.

\- Nothing ships unwired: each feature connects to agenda, ledger, CRM and agent, with a test and an invariant in check\_invariants().

\- Dates: never new Date(x) on unvalidated input. Use src/lib/datetime.ts.

\- Financial screens and rules are out of scope until told.

\- Never read or write .env\*. Never commit keys. Never push or link a remote unless told.

- Money visibility: professionals never receive ledger-derived money (spend, totals). Gate in the DB, not only the UI.
- Agent: model proposes, code disposes. Every agent write passes a code gate. Ownership is checked in code, never in the prompt.
- Finance is owner-only. Every money number comes from v_ledger through rpc_finance_*. No screen queries ledger tables directly.

\## Workflow

\- Do only the current task. No refactors outside it. No features not in the prompt.

\- Read only files you need. Do not re-read files you just wrote.

\- Test scripts print failures and a one-line summary only.

\- Same error fails twice: stop and report the exact error and what you tried. Do not loop.

\- If HANDOFF.md exists, read it first.

\- End of task: run tests, print summary, commit locally, stop.

\- Prompt conflicts with these rules: stop and ask.
