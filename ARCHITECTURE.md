# V-Cut Salon ERP — Architecture

> Stakeholder reference for the system design, roles, data model, and major
> workflows. Pair this with **USER_GUIDE.md** for per-screen tutorials.

---

## 1. Executive summary

V-Cut is a multi-branch salon ERP. It handles:

- **Point of Sale** — per-bill invoices, drafts, walk-in numbering, cash/online split, printed receipts.
- **Daily accounting** — one rollup entry per branch per day with reconciliation (expected vs actual cash).
- **Staff** — roster, transfers (home branch changes mid-month), ad-hoc loan of staff across branches for specific bills, salary incentive, target tracking.
- **Customer CRM** — directory, visit history, invoice archive, last-visit prompt during billing.
- **P&L** per branch, leaves, payroll, advance requests.

Stack: **Next.js 16** (App Router) · **React 19** · **Firebase Firestore** · **Tailwind v4**. Deployed as a single Next.js app.

---

## 2. Roles & capability matrix

| Capability                           | Admin | Accountant | Employee |
| ------------------------------------ | :---: | :--------: | :------: |
| Dashboard KPIs                       |   ✓   |     ✓      |    ✓     |
| POS (create invoices, drafts)        |   ✓   |     ✓      |    —     |
| Daily Business Entry (rollup)        |   ✓   |     ✓      |    —     |
| Customers directory                  |   ✓   |     ✓      |    —     |
| Staff master + transfers             |   ✓   |     ✓      |    —     |
| Branches                             |   ✓   |     ✓      |    —     |
| Menu Configuration                   |   ✓   |     ✓      |    —     |
| Materials + stock                    |   ✓   |     ✓      |    —     |
| Expenses                             |   ✓   |     —      |    —     |
| P&L                                  |   ✓   |     —      |    —     |
| Leaves approval                      |   ✓   |     ✓      |    —     |
| Payroll calc + release               |   ✓   |     —      |    —     |
| Master Setup (users, shops, config)  |   ✓   |     —      |    —     |
| My Day Working (self-log services)   |   —   |     —      |    ✓     |
| My Payroll                           |   —   |     —      |    ✓     |
| Apply Leave                          |   —   |     —      |    ✓     |
| My Target                            |   —   |     —      |    ✓     |

Role gate is `useCurrentUser().role`. The sidebar NAV map in `src/app/dashboard/layout.js` is the source of truth for what each role sees.

---

## 3. Page inventory

### Admin + Accountant

| Route | Purpose |
|---|---|
| `/dashboard` | KPI tiles, period selector |
| `/dashboard/branches` | Branch master; revenue/expense summary per period |
| `/dashboard/entry` | **Daily Business Entry** — one rollup doc per branch+date. Staff billing table + expenses + cash reconciliation. Supports Loan Resource. |
| `/dashboard/pos` | **POS Terminal + Bill History**. Two view modes: Terminal (cart, drafts, settle) and History (branch cards → invoice drill-down). |
| `/dashboard/customers` | Directory, detail drawer with lifetime spend + per-invoice history |
| `/dashboard/staff` | Staff roster, transfers, mid-month status changes |
| `/dashboard/menu-config` | Service catalog (groups → items, price, time, icon) |
| `/dashboard/materials` | Material catalog + stock moves |
| `/dashboard/material-master` | Bulk material CRUD |
| `/dashboard/leaves` | Leave requests (approve/reject), attendance view |
| `/dashboard/leaderboard` | Staff ranking by billing / target % |

### Admin-only

| Route | Purpose |
|---|---|
| `/dashboard/expenses` | Monthly fixed + variable expenses per branch |
| `/dashboard/pl` | P&L statement by branch & period |
| `/dashboard/payroll` | Salary calc, advance approval, payslip |
| `/dashboard/users` | **Master Setup** (tabs: Users, Shops, Fixed Exp, Exp Types, Cost Centers, Reviews, Settings, …) |

### Employee

| Route | Purpose |
|---|---|
| `/dashboard` | Personal view |
| `/dashboard/day-working` | Self-log services rendered today, tips, material sales, close day |
| `/dashboard/my-payroll` | Payslip + advance history |
| `/dashboard/apply-leave` | Submit leave request |
| `/dashboard/my-target` | Target progress |
| `/dashboard/payroll-request` | Advance request |

### Master Setup tabs (`/dashboard/users`)

`UsersTab`, `ShopsTab`, `FixedExpTab`, `ExpTypesTab`, `CostCenterTab`, `EmployeeSetupTab`, `LeaveTab`, `PayrollTab`, `ReviewsTab`, `SalaryTab`, `SettingsTab`, `ShopsTab`, `TxnSetupTab`.

---

## 4. Data model (Firestore collections)

### `users`
`{ uid, name, role: "admin" | "accountant" | "employee", staff_id?, branch_id? }`

### `branches`
`{ name, type: "mens" | "unisex", location?, code? }`

### `staff`
`{ name, role, branch_id, incentive_pct, join, exit_date?, target?, salary_basic?, ... }` + inactive spans, target configs.

### `staff_transfers`
`{ staff_id, from_branch_id, to_branch_id, start_date, end_date? }` — `effectiveBranchOnDate(staff, date, transfers)` resolves the home branch for any given date.

### `invoices` (per-bill)
```
{
  invoice_no: "ARE-150426-003",   // branch prefix + DDMMYY + 3-digit seq
  walkin_no: 5,                    // only when no customer_id
  branch_id, branch_name, date,
  items: [
    { cart_id, name, price, staff_id, staff_name,
      home_branch_id, loan_flag, menu_id, menu_type, group, icon }
  ],
  staff_split: [{ staff_id, staff_name, billing, home_branch_id, loan_flag }],
  customer_id?, customer_name?, customer_phone?,
  subtotal, gst_pct, gst_amount, cash, online, total,
  status: "draft" | "settled",
  cashier_name, created_by,
  created_at, settled_at?, updated_at?
}
```

### `entries` (daily rollup per branch+date)
```
{
  branch_id, date,
  online, cash, mat_expense, others, petrol, cash_in_hand,
  staff_billing: [
    { staff_id, billing, material, incentive, mat_incentive, tips,
      tip_in, tip_paid, present, staff_total_inc,
      home_branch_id, loan_flag }
  ],
  actual_cash, cash_diff, tips_in_cash, tips_paid_cash,
  global_gst_pct, total_gst,
  customer_id?, customer_name?, customer_phone?,
  activity_log: [{ time, user, action, notes }],
  created_at, updated_at?, created_by, updated_by?
}
```

### `service_logs`
Per-service line with both sources:
```
{
  staff_id, staff_name, branch_id, home_branch_id, loan_flag,
  date, service_name, service_group, menu_id, menu_type,
  amount, standard_price, custom_price, price_note,
  tip, tip_in, material_sale, material_name,
  source: "pos" | "manual",
  invoice_id?, invoice_no?, pos_cart_id?,   // POS-source only
  customer_id?, customer_name?,
  created_by, created_at
}
```

### `day_closures`
Keyed `{staff_id}_{date}`. Locks a staff's incentive for the day.

### `customers`
```
{
  name, phone?, email?, address?, birthdate?, marriage_date?, notes?,
  last_visit_date?, last_visit_at?, last_visit_invoice?, last_visit_branch_id?,
  created_at, created_by, updated_at?, updated_by?
}
```

### Other
`menus`, `materials`, `material_price_history`, `material_allocations`, `leaves`, `salary_history`, `staff_status_log`, `staff_advances`, `fixed_expenses`, `expense_types`, `monthly_expenses`, `cost_centers`, `transactions`, `payroll_releases`, `settings/global`.

---

## 5. Key workflows — data flow

### A. POS Preview & Settle

```
User adds services → cart (in-memory)
                  |
                  ▼
        "Preview & Settle" tapped
                  |
                  ▼
openBillPreview():
  - compute invoice_no (branch prefix + DDMMYY + seq)
  - compute walkin_no if no customer
  - stash billPreview { items, staffs (with loan_flag), totals, ... }
                  |
                  ▼
Modal shows: Bill #, customer, items table, totals, payment
Three buttons: Back to Edit | Settle | Settle & Print
                  |
                  ▼
confirmPrintAndSave({ print }):
  1. addDoc/updateDoc invoices with status="settled" + invoice_no (+ walkin_no)
  2. addDoc per service_logs (source=pos, loan_flag, home_branch_id, invoice_no, invoice_id)
  3. updateDoc customer.last_visit_* (if customer linked)
  4. handleSave({ rollup: true }) → upsert entries doc for branch+date,
     auto-targets existing day-rollup, skips duplicate guard
  5. window.print() if Settle & Print
```

Drafts subscription is scoped to `(branch_id == selBranch, date == selDate)`, so drafts naturally expire at midnight when the date changes. Drafts don't bump `entries.staff_billing` — `addToCart` bumps `staffRows`, but `saveDraft` rolls that back before clearing the cart. Resuming a draft re-applies the bump.

### B. Daily Entry (accountant)

```
Pick branch + date → branchStaff list loads
                  |
                  ▼
(optional) "+ Loan Resource" → modal searches allActiveStaffOnDate
           (home branch != selBranch) → adds to loanStaffIds Set
                  |
                  ▼
Edit billing/material/tips/incentive per row → staffRows state
(incentive auto-rounds; mat_incentive = 5% of material; totals auto-compute)
                  |
                  ▼
Add expenses, petrol, actual cash counted
                  |
                  ▼
Save → entries doc:
  - staff_billing = branchStaff rows + loan rows (with home_branch_id + loan_flag)
  - activity_log entry (Create or Update with diff notes)
```

### C. Employee day-working

```
Employee logs service → addDoc service_logs { staff_id, branch_id, amount, source: "manual" }
                  |
                  ▼
At end of shift → Close Day → setDoc day_closures/{staff_id}_{date}
                  |
                  ▼
Portal aggregates service_logs for date (source=pos + source=manual combined),
showing incentive from every branch they worked at (loan included).
```

### D. Loan resource attribution (design intent)

| Flow | Where it lives | Read by |
|---|---|---|
| Sale (billing, material, GST) | `invoices.branch_id`, `entries.branch_id` = loan branch | P&L of the loan branch |
| Incentive + tips | Same — credited to the loan branch | P&L, staff_total_inc in entries |
| Salary / attendance | `staff_billing[].home_branch_id` — salary expense posts to the home branch | Payroll (future) |
| Employee portal | `service_logs.staff_id` — shows combined view regardless of branch | Day Working, My Target |

---

## 6. Component architecture

| Component | Responsibility |
|---|---|
| `VLoader` | Pulsing V-Cut logo + bouncing dots. Used on every `if (loading) return ...` and for route transitions (`app/loading.js`, `app/dashboard/loading.js`). |
| `BillPrintModal` | Print-ready invoice modal. Same layout used by POS reprint and Customers → per-invoice PDF. `no-print` hides LOAN tags on paper. |
| `SearchPalette` | Cmd-K nav. Fed with lazy-loaded branches + staff context. |
| `Sidebar` + `SidebarItem` (in `ui.jsx`) | Memoised; click + hover-prefetch. |
| `PeriodWidget` (in `ui.jsx`) | Month / Year filter used across History, P&L, Payroll. |
| `useConfirm`, `useToast` (in `ui.jsx`) | Dialogs + transient messages. |

---

## 7. Performance notes

- **Route prefetch on hover** in dashboard sidebar (was aggressive at mount → moved to hover/focus).
- **Firestore listeners scoped** by period or branch+date to avoid pulling global collections.
- **Per-customer invoice** loads only when the detail drawer opens.
- **`SidebarItem` is `React.memo`** and `handleNav` / `handlePrefetch` are `useCallback`-stable.
- **`VLoader` is shown during every wait** (login, route, page boot) so users always get feedback.

---

## 8. Running & deploying

```bash
npm install
npm run dev       # localhost:3000
npm run build
npm run lint
```

Configuration:

- Firebase: `src/lib/firebase.js` reads Firebase config from env vars (`NEXT_PUBLIC_FIREBASE_*`).
- Fonts: loaded via `next/font/google` in `src/app/layout.js`.

---

## 9. Audit & compliance posture

- **Invoices are permanent** — no delete action in any UI surface. Auditable via `invoice_no` scheme (branch-prefixed, date-stamped, gapless sequence per branch+day).
- **Activity log** on daily entries — every update appends a `{ time, user, action, notes }` item with field-level diffs.
- **Staff transfers** and **status log** preserve history (don't overwrite `branch_id`; add a transfer record with start/end).
- **Source tagging** on `service_logs` (`pos` vs `manual`) keeps bill origin traceable.

---

## 10. Roadmap / TODO

- Daily Entry → also show per-staff invoice reconciliation (compare `entries.staff_billing[].billing` vs sum of `invoices.staff_split` for that date).
- Payroll / P&L to read `home_branch_id` and split salary (home) vs sale (loan) attribution.
- Per-staff loan incentive breakdown in the employee portal.
- Customer birthday / anniversary reminders on the dashboard.

---

*Generated from the codebase. For per-screen tutorials see [USER_GUIDE.md](USER_GUIDE.md).*
