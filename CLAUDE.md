@AGENTS.md

# V-Cut Salon ERP — Codebase Guide

Next.js 16 App Router, React 19, Firebase Firestore, Tailwind v4. Salon-chain ERP: POS, daily entry rollups, staff payroll, P&L, customer CRM.

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
- **`invoices`** — one doc per bill (POS). Statuses: `"draft" | "settled"`. Drafts auto-expire at midnight (subscription filters `date === selDate`). Each settle assigns `invoice_no` = `{BRANCH-PREFIX}-{DDMMYY}-{NNN}`, sequence per-branch-per-date.
- **`entries`** — one doc per (`branch_id`, `date`) — daily rollup. Accountant edits petrol/material_expense/others/actual_cash here. POS settles call `handleSave` with `{ rollup: true }` — auto-targets existing daily entry (no "Duplicate Detected" prompt).
- **`service_logs`** — per-service lines with `source: "pos" | "manual"` + `invoice_id` + `loan_flag` + `home_branch_id`. Day-working portal reads these.

Settled invoices never deleted via UI. Permanent records.

### Loan resource (ad-hoc, per-bill)
Staff from another branch borrowed for specific bill or day:
- POS cart staff dropdown groups `This branch` + `Borrow · <home>` optgroups.
- Daily Entry has `+ Loan Resource` button + search modal (name or branch).
- Every downstream record carries `home_branch_id` + `loan_flag`:
  - `invoices.items[]`, `invoices.staff_split[]`
  - `service_logs`
  - `entries.staff_billing[]` (loan rows appended)
- Intent: **sale attribution** → current branch (loan branch gets incentive + tips). **Salary attribution** → home branch (read `home_branch_id`).
- `LOAN` tag on bill uses `className="no-print"` — customers never see it.

### Walk-in numbering
When `selectedCustomer` is null on POS settle, invoice gets `walkin_no` = `(count of today's settled walk-ins for this branch) + 1`. Displayed as `Walk-in #NNN` on bill receipt.

### Customer last-visit
On settle, if bill linked to customer, update doc with `last_visit_date`, `last_visit_at`, `last_visit_invoice`, `last_visit_branch_id`. POS Order Summary shows "last visit N days ago" with tiered colour hint.

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

- **Branch/date scoping** — subscriptions that don't need full history query with `where("date", "==" || ">=" / "<=")`. See POS invoices subscription and P&L.
- **`effectiveBranchOnDate(staff, date, transfers)`** is truth for "where does this staff work on this date" — always use it, never `staff.branch_id` directly.
- **`staffStatusForMonth(staff, mon)`** — drives `active`/`inactive` filters; respects mid-month status changes.
- **Incentive always `Math.round(...)`** — at source (`updateStaffRow`) and display. Same for mat_incentive, staff_total_inc, totals.
- **No-print class** — `.no-print` hides elements during `window.print()` (CSS in globals.css).
- **Loaders** — every `if (loading) return <VLoader fullscreen label="..." />`. No plain "Loading..." strings.
- **Card glow** — `Card` and `StatCard` in `components/ui.jsx` render with coloured halo (`box-shadow` + tinted border). Branch cards: green glow for `n > 0`, red for `n <= 0` (zero-net counts as not-profitable, not neutral). Keep `n > 0` convention for new P&L-coloured surfaces — never `n >= 0`.
- **Branch `n` = Full Net P&L** — in dashboard and branches `branchData`, `n` subtracts variable + fixed + salary + GST estimate (`iOnline * gst_pct / 100`). Matches detail view's Full Net P&L KPI, so card border / Profit-Loss filter / table column agree. Don't compute GST-less "gross net" for UI colouring.
- **Operational Expenses tabs** — three views: Fixed (editable grid, 6-column `CORE_COLS` + `expense_types` where `category === "fixed"`), Variable (read-only, `expense_types` where `category !== "fixed"`, cells aggregate `daily_expenses` by branch × month × category, click opens drill-down modal), Total (Fixed + Variable + Salary). Edit in Variable drill-down is admin-only — accountant sees entries read-only. Salary never exposed to non-admin: mask in aggregate KPIs, network-row totals, per-branch row totals. `CORE_COLS` locked to six master-setup fields every branch has (Shop/Room Rent, Shop/Room Elec, Water, WiFi) — any other fixed cost is opt-in `expense_types` row via "+ Add Column" button (admin only, tags with current tab's category).
- **Branches → Summary view** — third entry in view toggle (alongside Cards / Table). Two sub-tabs: "Summary View" (Excel-like Income + Expense pair of tables with Grand P&L card) and "Daily Cash & Online" (two day × branch pivot tables, one online one cash). Salary and final P&L stay admin-only (masked with `•••••` for accountant).
- **Dashboard daily chart** — inline SVG bar chart in `DailyBusinessChart` (no chart lib dep). Shows network-wide `online + cash + material_sale` per day for selected month. Only renders in month mode to avoid 365-bar clutter.
- **Taskpedia** — shared Kanban (To Do / In Progress / Done) in `dashboard/taskpedia/page.js`. Collection `taskpedia` with fields: title, description, image_url, assignee_id, assigned_by_id, due_date, status, started_at, completed_at, date_changes[], read_by_assignee. Anyone (admin + accountant + employee) creates and assigns tasks to anyone. Image uploads to Firebase Storage `taskpedia/{ts}-{name}`. Due-date edits require reason — old → new change pushed to `date_changes` with author + timestamp. Clicking task card from assignee's view marks `read_by_assignee = true`, clears Bell badge. Bell subscribes to `taskpedia where assignee_id == currentUser.id` and filters client-side for unread + not-done — no composite index needed.
- **BellNotifications sort** — `requested_at` / `created_at` may be Firestore `Timestamp` objects (from `serverTimestamp()` writes) OR ISO strings (from `new Date().toISOString()`). Never call `.localeCompare` directly on these — always go through `sortKey()` helper in `BellNotifications.jsx` which coerces Timestamp / Date / number / string to sortable ISO string. Calling `localeCompare` on Timestamp throws `localeCompare is not a function` and blanks dashboard.

## Don'ts

- Don't delete settled invoices from UI — permanent audit records.
- Don't bypass `homeBranchOf` / `effectiveBranchOnDate` — transfers break.
- Don't add negative-number paths to `Actual Cash Counted` — `onKeyDown` + `onChange` reject them.
- Don't write "Guest:" on bills — it's "Customer:" (or "Walk-in #NNN").
- Don't print LOAN tag — internal only.
- Don't write docs/comments that restate what code does. Only `**Why:**` / `**How to apply:**` lines.

## Running locally

```bash
cd vcut-app
npm run dev       # Next dev server
npm run build
npm run lint      # ESLint
```

## Workflow

- **Always merge to `main` after pushing.** Once a feature branch is committed and pushed, open a PR via `mcp__github__create_pull_request` and immediately merge it (squash) via `mcp__github__merge_pull_request` — don't leave changes sitting on the feature branch. The Vercel production deployment builds from `main`, so unmerged work isn't visible in the deployed app.

## Sessions & docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system architecture for stakeholders.
- [USER_GUIDE.md](USER_GUIDE.md) — per-role walkthroughs and workflows.
