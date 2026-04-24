# V-Cut Luxe Mobile — Design Specification

**Version:** 1.0
**Source prototype:** `V-Cut Luxe Mobile.html` (React + inline JSX, 6 phone frames on a design canvas)
**Target:** Native mobile app (React Native / Expo recommended, or Flutter)
**Backend:** Existing Firestore from [`vipin638760/V-Cut-Web-ERP`](https://github.com/vipin638760/V-Cut-Web-ERP) — schema and auth reused as-is.

This document is the single source of truth for building the V-Cut mobile app. Read it end-to-end before writing code. Hand this file (plus the prototype HTML) to any developer or AI assistant.

---

## 1. Product summary

**V-Cut** is a multi-branch salon ERP for India-based chains. The mobile app is a role-aware companion to the existing web ERP. Three roles share one app with three different navigation graphs:

| Role | Primary job-to-be-done |
|---|---|
| **Admin** | Monitor branch P&L, approve payroll, run master setup, review expenses, oversee staff — 18 menu items |
| **Accountant** | POS settle, daily cash reconciliation, leaves, customers — 14 menu items |
| **Employee** (stylist) | Log own services, check own target/payroll, apply leave — 5 menu items |

The prototype proves out all 20 screens. Admin is the widest surface; Employee is intentionally minimal.

---

## 2. Design language — "Luxe Obsidian"

This is a **dark, editorial, gold-on-black** aesthetic. It diverges from the parent V-Cut web ERP (which uses neon cyan accents) — the mobile app leans into a more premium, hospitality-grade feel. Treat every screen as a page from a luxury spa menu, not a SaaS dashboard.

### 2.1 Color tokens

```ts
// Canonical tokens — do NOT invent new colors. Export from a theme file.
export const colors = {
  // Surfaces (5 tiers — depth through tonal shift, never borders)
  bg:       '#0a0806',   // page background
  bg2:      '#13100c',   // cards, drawer
  bg3:      '#1a1510',   // nested cards
  bg4:      '#221c15',   // hover / pressed surface
  bg5:      '#2a231a',   // highest tier (badges, dots)

  // Lines (felt, not seen)
  line:     'rgba(212, 165, 116, 0.08)',
  line2:    'rgba(212, 165, 116, 0.14)',

  // Text
  text:     '#f5e6c8',   // primary — warm off-white
  text2:    '#d4a574',   // secondary — muted gold
  text3:    '#8a7a5f',   // tertiary — labels, captions
  text4:    '#5a4e3d',   // quaternary — disabled, hints

  // Brand gold (the ONLY accent — don't use purple/teal/cyan)
  gold:        '#d4a574',   // base
  gold2:       '#b8864a',   // deeper
  goldBright:  '#f0c987',   // highlight / glow

  // Semantic (use sparingly)
  green:    '#6bbf7b',   // positive, "match", on-target
  red:      '#d46b6b',   // deficit, alerts, destructive
  orange:   '#e0955a',   // LOAN staff flag, warnings
};
```

**The No-Gradient-Backgrounds Rule.** Cards are flat `bg2` with a 1px `line` border. Gradients appear only in: (a) the `gold → gold2` fill of active/primary buttons, (b) avatar placeholder tiles, (c) small radial glows inside stat cards at ≤6% opacity.

### 2.2 Typography

| Role | Family | Notes |
|---|---|---|
| Display / KPIs / page titles | **Cormorant Garamond** (serif) | 24–40pt, regular weight, italic optional for numerics |
| UI / body / buttons | **Inter** (sans) | 10–14pt, weights 500/700/800 |
| Script brand mark "V-Cut" | **Great Vibes** | Used only in the brand header, never body |

```ts
export const type = {
  serif:  'Cormorant Garamond, Georgia, serif',
  sans:   'Inter, -apple-system, system-ui, sans-serif',
  script: 'Great Vibes, cursive',
};
```

**Hierarchy is extreme big-small.** KPI numbers are 26–36pt serif. Labels underneath are 9–10pt sans, `letter-spacing: 1.4–2.2px`, UPPERCASE, weight 700. The contrast between display numerics and micro-labels is the entire visual rhythm of the app — commit to it.

### 2.3 Iconography

- **Single-weight 1.6px stroke, 24×24 viewBox, `fill="none"`, round linecaps.** Feather/Lucide vocabulary.
- Sizes: **14** in pills, **16** default, **18** in list rows and sidebar items, **20** in top bar, **22** in bottom tab bar.
- Color inherits (`currentColor`). Active tab = gold, inactive = `text3`.
- **No emoji** in UI. The one exception is `👋` after the first name in the dashboard greeting — that's it.

### 2.4 Radii, shadows, elevation

| Token | Value | Where |
|---|---|---|
| `r-sm` | 8  | pills, chips, small inputs |
| `r-md` | 10 | buttons, avatar tiles |
| `r-lg` | 12 | list cards |
| `r-xl` | 14 | primary cards, stat cards |
| `r-2xl` | 18 | modals, bottom sheets |

Shadows are used **only** for lifted surfaces:
- Card lift: `0 8px 24px rgba(0,0,0,0.5)`
- Modal / drawer: `0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(212,165,116,0.08)`
- Gold glow on active KPIs / primary buttons: `0 0 12px rgba(212,165,116,0.35)` (use a text-shadow or box-shadow, never a blur filter on the element itself)

### 2.5 Motion

- **Drawer / bottom sheet:** slide in from left/bottom, 260ms, `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint).
- **Tab switch:** no transition on the content swap — instant. Only the active-indicator pill slides: `transform: translateX(...)` 240ms `ease-out`.
- **Modal open:** `scale(0.96) translateY(8px) → scale(1) translateY(0)` 220ms `ease-out`, backdrop fades in parallel.
- **Press feedback:** **no scale-down on buttons.** Instead: `gold` buttons brighten (`gold → goldBright` 100ms), dark buttons bump one surface tier.
- **KPI progress bars:** animate width from 0 on mount, 600ms, snappy overshoot `cubic-bezier(0.34, 1.56, 0.64, 1)`.

### 2.6 Layout rules

- Phone frame is **390×844** (iPhone 14 baseline). Content container has **20px horizontal padding**, **16px gap between cards**, **safe-area insets** respected on top and bottom.
- **Status bar:** always dark translucent, white glyphs.
- **Bottom nav:** fixed, 72pt tall including safe area, 4 tabs, centered icons with 9pt label beneath.
- **Top bar:** 56pt, hamburger left, greeting center-left, notification dot right.
- **Never use horizontal scroll** except for the explicit branch slicer / filter chip row at the top of list screens.

---

## 3. Navigation model

### 3.1 Global structure

```
AppShell (top bar + content + bottom nav)
 ├── DrawerSheet (full-height from left, role-aware menu)
 └── Routes: one per screen id
```

**Role switching** lives in the drawer at the top as three chips (Admin / Accountant / Employee). Switching role remaps the menu and jumps to that role's dashboard.

### 3.2 Bottom tab bar

Only 4 items — same for all roles, so muscle memory transfers:

| Icon | Label | Route |
|---|---|---|
| home | Home | `dashboard` |
| wallet | POS / Day | `pos` (admin/accountant) or `day-working` (employee) |
| trending | Insights | `pl` (admin) or `branches` (accountant) or `my-target` (employee) |
| users | People | `staff` (admin/accountant) or `my-payroll` (employee) |

The hamburger opens the drawer which exposes every route the role can see.

### 3.3 Full menu — mapped from the web ERP's `layout.js`

**Admin (18):** Dashboard · Branch Performance · Cash Collection · Incentive Calculator · Daily Business Entry · POS Terminal · Customers · Menu Configuration · Staff Management · Materials · Material Master · Daily Expenses · Operational Expenses · P&L Analytics · Leave Management · Payroll · Taskpedia · Master Setup

**Accountant (14):** Dashboard · Branch Performance · Cash Collection · Incentive Calculator · Daily Business Entry · POS Terminal · Customers · Menu Configuration · Staff Management · Materials · Daily Expenses · Leave Management · Payroll · Taskpedia

**Employee (5):** Dashboard · Day Working · My Target · My Payroll · Apply Leave

Source of truth for labels and icons: `src/app/dashboard/layout.js` in the parent repo. Mirror names exactly so analytics map 1:1.

### 3.4 History stack

Keep a plain array in state. Back button (top-left arrow) pops. The hamburger never pushes — it replaces the stack. Deep-linked routes push onto the stack normally.

---

## 4. Screen inventory (20 screens)

Each screen below lists: purpose, data it reads, primary action, and layout motif. See the prototype for pixel-accurate reference.

### Admin & Accountant (shared)

1. **Dashboard** — greeting + 4 KPI tiles (Revenue, Customers Today, Cash in Hand, On-Duty Staff) + "Today" timeline of settled invoices + 2-up quick actions (Settle bill, Add expense).
2. **POS Terminal** — service catalog on top, cart on bottom. Each cart row has stylist picker. "Preview & Settle" sticky bottom CTA.
3. **Daily Business Entry** — one doc per branch+date. Revenue breakdown, expected-cash calc, actual-cash input, match/excess/deficit pill in the header, "Save Draft" / "Submit" dual CTA.
4. **P&L Analytics** — Deep Dive screen. Gross Revenue (big serif), Operating Cost / Net P&L 2-up, revenue-velocity line chart, Material Consumption list with per-item cost.
5. **Branch Performance** — scope chips (All / Week / Month), aggregate efficiency ring (86.4%), branch listing cards with % progress bars color-coded by performance tier.
6. **Customers** — search field, filter chips (All / Frequent / New / Lapsed), customer rows with "last visit" ghost text.
7. **Staff Management** — roster efficiency KPI header, filter chips (All / Masters / Loan), staff cards with avatar initials, role, branch, and daily score.
8. **Materials** — stock analysis header with low-stock % alert, material flow cards, critical-items list. "New Stock Order" gold CTA.
9. **Cash Collection** — per-branch cash-in-hand expected vs actual, reconcile button.
10. **Operational Expenses** — monthly category breakdown, add-expense modal.
11. **Daily Expenses** — quick-entry log, same-day scoped.
12. **Incentive Calculator** — per-stylist target vs actual, computed incentive rounded at source.
13. **Menu Configuration** — service list with category grouping, price editor.
14. **Material Master** — SKU list, supplier, unit cost.
15. **Taskpedia** — internal SOP / knowledge base.
16. **Leave Management** — pending requests inbox, approve/reject.
17. **Payroll** — monthly roll-up per employee, advances, net pay.
18. **Master Setup** — branches, roles, tax rates, invoice prefix. Admin only.

### Employee

19. **Day Working** — self-log services for today, running total.
20. **My Target** — progress bar toward monthly target, incentive forecast.
21. **My Payroll** — last month net pay, advances taken, year-to-date.
22. **Apply Leave** — calendar picker, reason textarea, submit.

(Employee Dashboard is #1 above with a stripped card set.)

---

## 5. Data & terminology — must match the web ERP exactly

These are **non-negotiable strings and formats** pulled from the source repo. The mobile app must use the same wording so audit trails stay consistent.

| Concept | Use | Never |
|---|---|---|
| Anonymous customer | `Walk-in #NNN` | "Guest", "Unknown" |
| Customer label on bills | `Customer:` | "Guest:", "Client:" |
| Borrowed staff flag | `LOAN · Home: <Branch>` (hidden on printed receipts) | "Temp", "External" |
| POS finalisation verbs | **Preview & Settle** → **Settle** → **Settle & Print** | "Checkout", "Pay" |
| Cash recon pair | **Cash in Hand (expected)** vs **Actual Cash Counted** | "Drawer total", "Till" |
| Cash recon pills | `✓ MATCH` / `▲ EXCESS` / `▼ DEFICIT` | colored words alone |
| Invoice number format | `ARE-150426-003` (branch-DDMMYY-seq, gapless per branch+day) | UUIDs, timestamps |
| Currency | `₹1,23,450` (Indian lakh grouping, no decimals for cash) | `Rs.`, `INR 123450`, decimals |
| Greeting slot | `GOOD AFTERNOON` (label) + `Vipin 👋` (name) | generic "Hello" |
| Loader captions | Two-word UPPERCASE, tracked 3px: `SIGNING IN`, `LOADING`, `CONNECTING` | "Please wait…" |
| Confirm dialog pattern | Title = question (`Sign out of V-Cut?`), CTA echoes verb (`Sign Out` / `Stay Signed In`) | "OK" / "Cancel" |

**Greetings adapt by hour:** `Working late` (00–05) · `Good morning` (05–12) · `Good afternoon` (12–17) · `Good evening` (17–21) · `Good night` (21–24). First name only.

**Rounding:** all currency-as-cash fields `Math.round()` at source AND on render. No decimal rupees displayed anywhere.

---

## 6. Component primitives

Build these once, reuse everywhere. The prototype has working references.

| Component | Props | Notes |
|---|---|---|
| `TopBar` | `title`, `onMenu`, `onBack?`, `right?` | 56pt, gold script brand when at root, serif title when in a sub-route |
| `BottomNav` | `active`, `onSelect` | 4 tabs, gold active pill indicator slides |
| `DrawerSheet` | `open`, `role`, `onRoleChange`, `onNav`, `onClose` | Full-height, role chips top, scrollable menu, logout pinned bottom |
| `StatCard` | `label`, `value`, `delta?`, `tone?` | Serif value, UPPERCASE label, optional 6% radial gold glow top-right |
| `ListCard` | children | `bg2` + `line` border + 12pt radius + 14pt padding |
| `Pill` | `tone` (`gold` / `green` / `red` / `orange` / `ghost`) | 8pt radius, 9pt UPPERCASE text tracked 1.4 |
| `ChipGroup` | `items`, `active`, `onChange` | Horizontal scroll on overflow, gold-gradient active fill |
| `PrimaryButton` | `label`, `onPress`, `icon?` | Gold gradient fill, 10pt radius, 44pt min hit target |
| `GhostButton` | `label`, `onPress` | `bg3` fill, `line2` border |
| `Sheet` | `open`, `title`, `onClose`, children | Bottom sheet, 18pt top radius, drag-dismiss |
| `Loader` | `caption` | Script V pulsing crimson drop-shadow, 3 bouncing gold dots |
| `Toast` | `tone`, `text` | Slide-in from bottom-right offset, 350ms `ease-out` |

**Accessibility floor:** every touch target ≥44×44pt, color contrast ≥4.5:1 for body text, reduce-motion respected (replace all slide/scale with fades).

---

## 7. Recommended build stack

**If rebuilding as a native app:**

- **React Native + Expo (SDK 51+)** — closest fit to the prototype's React code, shares business logic with the web app via Firestore SDK.
- **Navigation:** `@react-navigation/native` with a custom drawer + bottom tabs composition (don't use the default drawer chrome — it won't match the design).
- **State:** Zustand for local UI state, Firestore's `onSnapshot` for live data. No Redux needed.
- **Fonts:** `expo-font` loading Cormorant Garamond, Inter, Great Vibes from `@expo-google-fonts/*`.
- **Icons:** inline SVG via `react-native-svg`. Copy the icon set verbatim from `app-v2-shell.jsx` in the prototype.
- **Theme:** a single `theme.ts` exporting the tokens in §2. Wrap the app in a `ThemeProvider` and pipe into a `useStyle` hook.
- **Firebase:** `@react-native-firebase/*` (auth + firestore). Reuse the security rules and collection shape from the web ERP — do not redesign the data model.
- **Offline:** Firestore's offline persistence is on by default; enable it explicitly for iOS. POS drafts must be local-first — queue on loss of signal, sync when reconnected.

**If you must build a web-app-installed-as-PWA instead:** Next.js 15 + the existing web codebase's theme tokens remapped to the gold palette. Add `manifest.json` + service worker + iOS touch icons. This is faster but won't be in the App Store.

---

## 8. Firestore — reuse these collections

Do not invent new collections. The mobile app is a second front-end over the same data.

```
branches/{branchId}
users/{uid}            // role: 'admin' | 'accountant' | 'employee'
customers/{customerId}
services/{serviceId}
invoices/{invoiceId}   // settled bills, immutable audit record
dailyEntries/{branchId_YYYY-MM-DD}
expenses/{expenseId}
materials/{materialId}
payroll/{uid_YYYY-MM}
leaves/{leaveId}
tasks/{taskId}         // taskpedia
```

Exact shapes live in the web repo — read those types; do not freestyle.

---

## 9. Handoff checklist

- [ ] Fonts downloaded and licensed (Google Fonts OFL — free for commercial use).
- [ ] All 20 screens wireframed against the prototype, parity verified on device.
- [ ] Role-switch flow tested for all three roles, including drawer remap + dashboard re-route.
- [ ] Currency and invoice-number formatters pulled verbatim from the web repo's `calculations.js`.
- [ ] Offline POS drafts survive app relaunch.
- [ ] Back-button behavior tested on Android hardware back.
- [ ] iOS notch + Android gesture nav safe areas respected on every screen.
- [ ] Reduce-motion + large-text accessibility modes tested.
- [ ] Firestore security rules unchanged.
- [ ] App icon: crimson cursive "V" (Great Vibes) on obsidian square, consistent with the web favicon.

---

## 10. What this document is NOT

- It's not a complete Firestore schema — that lives in the web repo.
- It's not a marketing spec — no onboarding copy, no notification strings beyond greetings. Write those separately.
- It's not a pixel spec for a specific device — the prototype is a *visual contract*, not a 1:1 Figma. When in doubt, match the tokens and the rules above rather than eyeballing the prototype PNG.

---

**Questions?** The prototype is in `V-Cut Luxe Mobile.html`. Open it, tap any phone to focus, open the hamburger to walk the full menu. Every screen labeled in this doc is reachable from there.
