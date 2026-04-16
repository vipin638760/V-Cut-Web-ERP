@AGENTS.md

# V-Cut Salon ERP — Codebase Guide

Next.js 16 App Router, React 19, Firebase Firestore, Tailwind v4. App is a salon-chain ERP: POS, daily entry rollups, staff payroll, P&L, customer CRM.

## Project layout

```
src/
  app/                       Next.js App Router
    page.js                  Login screen
    loading.js               Root transition loader (VLoader)
    layout.js                Root HTML + fonts + theme
    dashboard/
      layout.js              Sidebar + top bar + search palette + nav prefetch
      loading.js             Dashboard transition loader
      page.js                Admin/accountant overview (KPIs)
      pos/page.js            POS terminal + history tab
      entry/page.js          Daily Business Entry (accountant)
      customers/page.js      Customer directory + detail drawer
      staff/page.js          Staff roster + transfers + status
      branches/page.js       Branch master + period summaries
      menu-config/page.js    Service menu editor
      materials/page.js      Material catalog + stock moves
      material-master/page.js Bulk material CRUD
      expenses/page.js       Monthly expenses per branch
      pl/page.js             P&L statement
      leaves/page.js         Leave approval (admin/accountant)
      payroll/page.js        Salary calc + release
      payroll-request/page.js Employee advance request
      day-working/page.js    Employee daily service log + close-day
      my-payroll/page.js     Employee payslip
      my-target/page.js      Employee target progress
      apply-leave/page.js    Employee leave request
      leaderboard/page.js    Staff ranking
      users/page.js + users/tabs/*  Master setup (admin only)
  components/
    VLoader.jsx              Pulsing V-Cut loader used everywhere there's a wait
    BillPrintModal.jsx       Reusable printable invoice modal
    SearchPalette.jsx        Cmd-K quick nav
    ui.jsx                   Shared primitives (Card, TH/TD, Modal, Icon, PeriodWidget, useConfirm, useToast, Sidebar, SidebarItem, etc.)
    login-components.jsx     Auth form primitives
  lib/
    firebase.js              Firestore init
    calculations.js          INR formatter, effectiveBranchOnDate, staffStatusForMonth
    constants.js             DEFAULTS_USERS
    currentUser.js           useCurrentUser hook (session-storage backed)
```

## Core domain

### Three roles (`dashboard/layout.js` NAV map)
- **Admin** — all pages including Master Setup
- **Accountant** — entry, pos, customers, staff, materials, menu-config, branches, leaves
- **Employee** — dashboard, day-working, my-payroll, apply-leave

Role gate: `useCurrentUser().role` === "admin" | "accountant" | "employee".

### Entries vs Invoices — rollup relationship
- **`invoices`** — one doc per bill (POS). Statuses: `"draft" | "settled"`. Drafts auto-expire at midnight (subscription filters `date === selDate`). Each settle assigns `invoice_no` = `{BRANCH-PREFIX}-{DDMMYY}-{NNN}` where the sequence is per-branch-per-date.
- **`entries`** — one doc per (`branch_id`, `date`) — the daily rollup. Accountant edits petrol/material_expense/others/actual_cash here. POS settles call `handleSave` with `{ rollup: true }` which auto-targets any existing daily entry (no "Duplicate Detected" prompt).
- **`service_logs`** — per-service lines with `source: "pos" | "manual"` + `invoice_id` + `loan_flag` + `home_branch_id`. Employee's day-working portal reads these.

Settled invoices are never deleted through UI. Treat them as permanent records.

### Loan resource (ad-hoc, per-bill)
Staff from another branch can be "borrowed" for a specific bill or day:
- POS cart staff dropdown groups `This branch` + `Borrow · <home>` optgroups.
- Daily Entry has a `+ Loan Resource` button + search modal (name or branch).
- Every downstream record carries `home_branch_id` + `loan_flag`:
  - `invoices.items[]`, `invoices.staff_split[]`
  - `service_logs`
  - `entries.staff_billing[]` (loan rows appended)
- Intent: **sale attribution** → current branch (loan branch gets incentive + tips). **Salary attribution** → home branch (read `home_branch_id`).
- `LOAN` tag on bill uses `className="no-print"` — customers never see it.

### Walk-in numbering
When `selectedCustomer` is null on POS settle, the invoice gets `walkin_no` = `(count of today's settled walk-ins for this branch) + 1`. Displayed as `Walk-in #NNN` on the bill receipt.

### Customer last-visit
On settle, if bill is linked to a customer, update their doc with `last_visit_date`, `last_visit_at`, `last_visit_invoice`, `last_visit_branch_id`. POS Order Summary shows "last visit N days ago" with tiered colour hint.

## Firestore collections

| Collection | Purpose |
|---|---|
| `users` | Login credentials, role, branch, linked staff_id |
| `branches` | Shop master (name, type: mens/unisex, location) |
| `staff` | Name, role, salary, incentive_pct, join/exit, branch_id |
| `staff_transfers` | Mid-month transfer of home branch |
| `entries` | Daily rollup per branch+date (accountant-editable) |
| `invoices` | Per-bill docs with status draft/settled |
| `service_logs` | Per-service lines (pos + manual) |
| `customers` | Directory + denormalised last_visit_* |
| `menus` | Service menu items (groups → items) |
| `materials`, `material_price_history`, `material_allocations` | Stock |
| `leaves` | Leave records incl. source tag |
| `settings/global` | GST %, incentive rates by branch type |
| `day_closures` | Per-staff per-day locked incentive |

## Conventions

- **Branch/date scoping** — all subscriptions that don't need full history query with `where("date", "==" || ">=" / "<=")`. See POS invoices subscription and P&L.
- **`effectiveBranchOnDate(staff, date, transfers)`** is the truth for "where does this staff work on this date" — always use it, never `staff.branch_id` directly.
- **`staffStatusForMonth(staff, mon)`** — drives `active`/`inactive` filters; respects mid-month status changes.
- **Incentive is always `Math.round(...)`** — at source (`updateStaffRow`) and at display. Ditto mat_incentive, staff_total_inc, totals.
- **No-print class** — `.no-print` hides elements during `window.print()` (CSS in globals.css).
- **Loaders** — every `if (loading) return <VLoader fullscreen label="..." />`. Don't write plain "Loading..." strings.

## Don'ts

- Don't delete settled invoices from the UI — they're permanent audit records.
- Don't bypass `homeBranchOf` / `effectiveBranchOnDate` — transfers break otherwise.
- Don't add negative-number paths to `Actual Cash Counted` — the `onKeyDown` + `onChange` rejects them.
- Don't write "Guest:" on bills — it's "Customer:" (or "Walk-in #NNN").
- Don't print the LOAN tag — it's internal only.
- Don't write docs/comments that just restate what the code does. Only `**Why:**` / `**How to apply:**` lines.

## Running locally

```bash
cd vcut-app
npm run dev       # Next dev server
npm run build
npm run lint      # ESLint
```

## Sessions & docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system architecture for stakeholders.
- [USER_GUIDE.md](USER_GUIDE.md) — per-role walkthroughs and workflows.
