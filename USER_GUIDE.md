# V-Cut Salon ERP — User Guide

> Role-by-role walkthroughs. Pair with **ARCHITECTURE.md** for the system
> design. Screenshots slots are marked `(screenshot: …)` — drop PNGs into
> `docs/screenshots/` and replace the markers when you have them.

---

## Table of contents

1. [Signing in](#1-signing-in)
2. [Admin — daily playbook](#2-admin--daily-playbook)
3. [Accountant — daily playbook](#3-accountant--daily-playbook)
4. [Employee — daily playbook](#4-employee--daily-playbook)
5. [Workflow: Create & settle a bill](#5-workflow-create--settle-a-bill)
6. [Workflow: Save a draft and resume](#6-workflow-save-a-draft-and-resume)
7. [Workflow: Loan a stylist from another branch](#7-workflow-loan-a-stylist-from-another-branch)
8. [Workflow: Reprint any bill / view invoice PDF](#8-workflow-reprint-any-bill--view-invoice-pdf)
9. [Workflow: Customer lookup & billing history](#9-workflow-customer-lookup--billing-history)
10. [Workflow: Close the day (employee + accountant)](#10-workflow-close-the-day-employee--accountant)
11. [Keyboard shortcuts](#11-keyboard-shortcuts)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Signing in

Go to the app URL → you land on the branded login screen.

1. Pick your role (Admin / Accountant / Employee).
2. Type your UID and password.
3. Tick **Remember me** to prefill next time.
4. Click **Sign In**. The pulsing V-Cut loader overlays the screen while you're being authenticated.

*(screenshot: login screen with role selector)*

The app remembers up to three roles on this device (one per role). Switching roles just loads the matching UID.

---

## 2. Admin — daily playbook

| When | Action |
|---|---|
| Morning | `/dashboard` — glance KPIs; `/dashboard/leaves` — approve/reject pending leaves |
| Throughout day | `/dashboard/pos` if manning a terminal |
| Evening | `/dashboard/entry` — verify each branch's daily rollup (cash reconciliation); `/dashboard/pl` — check margins |
| Weekly | `/dashboard/staff` — new joins / exits / transfers |
| Monthly | `/dashboard/payroll` — release salaries; `/dashboard/users` (Master Setup) — update rates, shops, fixed expenses |

All sidebar entries are visible to Admin: Dashboard, Branches, Daily Business Entry, POS Terminal, Customers, Menu Configuration, Staff Management, Materials, Material Master, Operational Expenses, P&L Analytics, Leave Management, Payroll, Master Setup.

*(screenshot: admin sidebar)*

---

## 3. Accountant — daily playbook

| When | Action |
|---|---|
| Morning | `/dashboard/pos` — drafts from yesterday have auto-expired; start fresh |
| Throughout day | `/dashboard/pos` — settle invoices; `/dashboard/entry` — adjust petrol / others / actual cash |
| Evening | Reconcile each branch in `/dashboard/entry`; resolve cash deficits / excesses |

Accountants **cannot** see P&L, Payroll, Expenses, or Master Setup. Sales log and daily rollup are their primary screens.

*(screenshot: accountant sidebar)*

---

## 4. Employee — daily playbook

| When | Action |
|---|---|
| Start of shift | `/dashboard/day-working` — view today's menu |
| After each service | Tap the service card → adds to your log with standard price (editable). Tip + material sale fields record tips and salon-product sales on top |
| End of shift | Hit **Close Day** — locks your incentive for today. Manager reconciles from the daily entry |
| Anytime | `/dashboard/my-payroll` — see salary + advances; `/dashboard/apply-leave` — request leave; `/dashboard/my-target` — track monthly target |

*(screenshot: day-working page)*

Services added via POS by a cashier automatically show up in your day-log with `source: pos`, so you don't double-enter.

---

## 5. Workflow: Create & settle a bill

1. Go to `/dashboard/pos`. Terminal view is selected by default.
2. **Pick branch** in the Order Summary (right panel). The menu appears on the left.
   - Before a branch is picked you see a welcoming V-Cut splash, not a warning.
3. **Identify the customer** (top search bar). Select a match, add them, or leave blank for walk-in.
   - If selected, the Order Summary shows "Last visit: YYYY-MM-DD · N days ago" with a tiered colour (green if recent, red if long overdue).
   - Walk-ins get **Walk-in #NNN** on the bill (per-branch-per-day sequence).
4. **Add services** — click any credit-card-style tile. Items flow into the Order Summary as the same-styled cards.
5. **Assign stylist** per line from the cart card dropdown. The list is grouped:
   - `This branch` — stylists whose home is today's branch.
   - `Borrow · <Branch>` — loan groups for each other branch.
6. Enter **Online** (cash auto-fills the remainder). GST is calculated on the online portion.
7. Click **Preview & Settle**.
   - Modal shows the bill exactly as it will print, with the locked-in invoice number (e.g. `ARE-150426-003`).
8. Choose one:
   - **Back to Edit** — cancel; nothing saved yet.
   - **Settle** — records the invoice, writes service logs, rolls up into the daily entry, closes the modal. No print.
   - **Settle & Print** — same as above, plus opens the browser print dialog.
9. The invoice appears as a chip under **Today's Bills** above the menu. Click any chip to reopen the bill for reprint.

*(screenshot: POS terminal with Order Summary)*

The LOAN tag next to a stylist shows **only on-screen** — it's hidden from the printed receipt so customers don't see internal attribution.

---

## 6. Workflow: Save a draft and resume

1. Build the cart as normal (customer, services, stylists).
2. Click **Save Draft** instead of Preview & Settle.
3. Cart clears and the draft appears as a chip under **Drafts** above the menu grid.
4. Later (same day), click the draft chip to load it back. Add more items, change stylists, tweak online amount.
5. Click **Preview & Settle** when ready. The draft is converted to a settled invoice with a fresh `invoice_no` and disappears from the Drafts strip.

Drafts expire at midnight because the subscription only looks at today's date. Discard an in-progress draft with the small ✕ next to its chip.

---

## 7. Workflow: Loan a stylist from another branch

**On POS (per-bill loan)**

1. In the cart line's **Staff** dropdown, scroll past `This branch` to a `Borrow · <Branch>` group.
2. Pick the stylist. The cart card turns orange and shows `LOAN · Home: <Branch>`.
3. Settle as normal. The bill credits:
   - Sale, incentive, tips → this branch.
   - Salary / attendance → the stylist's home branch.
4. The printed receipt never shows the LOAN tag (it's hidden for customers).

**On Daily Entry (whole-day loan)**

1. `/dashboard/entry` → pick branch + date → the staff table loads.
2. Click **+ Loan Resource** above the table.
3. In the modal, search by staff name or branch name. Pick a stylist. They appear as a chip at the top; repeat to loan multiple people.
4. Close the modal. The loaned stylist is now a row in the staff billing table (orange accent, `LOAN · Home: <Branch>`).
5. Enter their billing / material / tips normally.
6. Save. The `staff_billing` row carries `home_branch_id` + `loan_flag: true` for downstream reports.

*(screenshot: loan resource modal)*

---

## 8. Workflow: Reprint any bill / view invoice PDF

### From POS

1. `/dashboard/pos` → switch to **History** tab.
2. Use the **search bar** to filter by invoice number, customer name, phone, amount, or date.
3. Click any **branch card** to drill in (multi-select is supported — pick several cards or use **Select All Branches**).
4. Apply filters: sort (newest / oldest / amount asc/desc), specific date, customer, or status (All / Settled / Drafts).
5. Click the **PDF** button on any row → bill opens in view-only mode.
6. Hit **Print** → browser print dialog. Choose "Save as PDF" to export.

*(screenshot: branch cards with drill-down + filter bar)*

### From a customer's record

1. `/dashboard/customers` → click a customer row.
2. The drawer lists every settled invoice with date, invoice number, services + stylist, and amount.
3. Click the **PDF** button on any invoice to reopen it for print.

---

## 9. Workflow: Customer lookup & billing history

1. `/dashboard/customers` — search by name, phone, or email.
2. Click a row → drawer opens with:
   - Phone, email, address, birthday, anniversary.
   - **Lifetime spend**.
   - **Billing history** — each invoice as a card: date, invoice #, services + stylist, amount, PDF button.

Add a new customer from **+ Add Customer**; or from POS when identifying a client (the "no match" path lets you add inline).

---

## 10. Workflow: Close the day (employee + accountant)

**Employee side**

1. `/dashboard/day-working` — all services for today (POS-source + manual) appear.
2. Click **Close Day** → incentive locks in, no more edits allowed for the day.

**Accountant side**

1. `/dashboard/entry` — pick branch + today's date. Existing rollup loads automatically.
2. Adjust petrol, material expense, others, actual cash counted.
3. Verify **Cash in Hand (expected)** vs **Actual Cash Counted** — the DEF/EXC pill shows ✓ Match, ▲ Excess, or ▼ Deficit.
   - Actual cash counted can't be negative.
4. Save. The day's rollup is committed; POS settles throughout the day keep adding to it automatically.

---

## 11. Keyboard shortcuts

| Shortcut | What it does |
|---|---|
| ⌘K / Ctrl-K | Open the quick search palette (branches, staff, nav) |
| Tab / Shift-Tab | Move through inputs in forms |
| Enter in Customer Search | Select the first match |
| Esc | Close modal (most modals) |

---

## 12. Troubleshooting

**"Duplicate Detected" when saving a daily entry**
Happens only when accountants change branch/date onto another existing rollup. POS settles bypass this because rollups are additive.

**Drafts disappeared overnight**
By design — drafts are per-date. If you need to keep something across days, settle it or re-enter.

**Staff not showing in POS dropdown**
Check their join/exit dates and effective branch on the selected date (transfers can move them mid-month). The accountant can loan them via `+ Loan Resource` on Daily Entry.

**Print preview shows whole page, not just the bill**
The bill modal uses `#print-bill`; all non-bill elements are `visibility: hidden` during print (see `globals.css`). If you copy the BillPrintModal into a new page, keep the `id="print-bill"` and `className="no-print"` on action buttons.

**Incentive showing decimals**
Shouldn't — values are rounded at source and at render. If you see one, the doc likely has legacy data. Open + save the entry once; it'll re-round.

**Login stuck on spinner**
The V-loader stays until the auth round-trip finishes. If it persists > 30s, the Firestore config in `.env` is likely missing — check browser console.

---

## Exporting this guide as PDF

This file is plain markdown.

- **From VS Code**: install "Markdown PDF" extension → right-click → Export (PDF).
- **From the command line**: `npx md-to-pdf USER_GUIDE.md` produces `USER_GUIDE.pdf`.
- **From GitHub**: open the file, File → Save As (your browser prints to PDF).

Drop screenshots into `docs/screenshots/` and replace the `(screenshot: …)` markers with `![caption](docs/screenshots/file.png)` to enrich the doc.
