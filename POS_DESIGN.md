# V-Cut POS Terminal — Design Spec

_Extends [DESIGN.md](DESIGN.md) ("The Obsidian Atelier"). This document covers the **Point-of-Sale terminal** (`src/app/dashboard/pos/page.js`) — the billing surface where a shift is opened, services are added to a cart, and invoices are settled._

---

## 1. Intent

The POS is a **fast, single-screen billing station**. Everything needed to raise a bill lives on one view with no navigation: pick a branch, search or browse services, tap to add, assign a stylist, take payment. The design goal is **speed with zero ambiguity** — the biggest, brightest element on screen is always the next action.

### Principles
- **One screen, no hunting.** Menu on the left, live cart on the right. Never make the cashier scroll to find the total.
- **Tap-to-add.** Services are large touch targets; a single tap drops them into the cart.
- **Live feedback.** Cart, subtotal, GST and Total Receivable update instantly with every tap.
- **State is loud.** Day-not-opened, day-closed, and empty-cart states are unmissable coloured banners, not quiet text.

---

## 2. Layout

```
┌───────────────────────────── Toolbar ─────────────────────────────┐
│  [ Identify client ]  [🔲 BRANCH ▾]  [date]      Terminal|Booking|History │
├────────────────────────── Day-status banner ──────────────────────┤
│  DAY NOT OPENED / ● DAY OPENED / DAY CLOSED         [+ Open Day]   │
├──────────────────────────────────┬────────────────────────────────┤
│  LEFT — Menu grid                │  RIGHT — Order Summary (cart)   │
│  ┌ Service search ─────────────┐ │  ORDER SUMMARY            [🔲]  │
│  │ 🔍 Search a service…      × │ │  Branch      [🔲 AREK ▾]        │
│  └────────────────────────────┘ │  Default Stylist [Auto ▾]       │
│  [Hair][Colour][Facial]…(chips) │  ─────────────────────────────  │
│  ┌────┐ ┌────┐ ┌────┐           │  Customer card / Walk-in        │
│  │card│ │card│ │card│  (grid)   │  … cart lines …                 │
│  └────┘ └────┘ └────┘           │  Subtotal / GST / Online / Cash │
│                                 │  ▓▓ TOTAL RECEIVABLE ▓▓         │
└──────────────────────────────────┴────────────────────────────────┘
```

- **Split** — `.pos-split`, `display:flex; gap:16`. Left column `flex:1`; right cart is a fixed `380px` rail.
- **Cart rail** — `--bg2`, `border-radius:24`, `1px --border`, soft drop shadow, and a barely-there accent glow blob (`blur(120px)`, `opacity .03`) top-right for depth.

---

## 3. Components

### 3.1 Branch selector
The branch pill is the anchor of the whole screen — nothing works until it is set.
- Rendered with the shared `BranchSelect` (`ui.jsx`), `stripPrefix="V-CUT "` so the chain prefix never clutters the label (shows **AREK**, not "V-CUT AREK").
- **Selected** → accent-tinted background `rgba(--accent-rgb,0.08)` + `1px rgba(--accent-rgb,0.35)` border + gold text.
- **Unset** → neutral `--bg4` + `--border2`, muted text — reads as "action required".
- Full-width in the Order Summary column (`style={{ width:"100%" }}`); inline auto-width in the toolbar.
- **Don't** wrap `BranchSelect` in an outer bordered box — its own container shrinks to content and leaves an empty highlighted gap. Style the control directly.

### 3.2 Service search
- Sits directly above the category chips, full width. `--bg2` field, leading `search` icon, trailing `×` clear button.
- **Focused / has query** → accent border + a 3px accent focus ring (`box-shadow: 0 0 0 3px rgba(--accent-rgb,0.12)`).
- **While searching**, category chips are hidden and results span **all** categories; each result card shows its category as a micro-tag so context isn't lost.
- Matches on service **name or price**. Empty result → centred 🔍 + "No service matches …".

### 3.3 Category chips
- Pill row, horizontally scrollable (`scrollbarWidth:none`), `text-transform:uppercase; letter-spacing:1`.
- **Active** → solid `--accent`, black text, accent glow (`0 4px 15px rgba(--accent-rgb,0.3)`).
- **Rest** → `--bg3`, muted text.

### 3.4 Service card
The primary interactive unit — a compact "credit-card".
- `aspect-ratio: 1.6/1`, `linear-gradient(135deg, --bg2, --bg3)`, `border-radius:14`, `1px --border`.
- Grid: `repeat(auto-fill, minmax(180px, 1fr))`, `gap:12`.
- **Content**: emoji icon top-left · duration top-right · name (2-line clamp) · **price in accent** bottom-left · category micro-tag bottom-right (search mode only).
- **Hover** → lift `translateY(-3px)`, border → accent, shadow `0 8px 24px rgba(--accent-rgb,0.15)`.
- Decorative accent blur blob bottom-right corner (`opacity .06`).
- **Tap anywhere** on the card = add to cart (auto-assigns the Default Stylist).

### 3.5 Day-status banner
A single high-contrast strip that owns the top of the working area.
| State | Colour | Action |
| :--- | :--- | :--- |
| **Day not opened** | Orange `rgba(251,146,60,*)` | `+ Open Day` (accent→gold gradient) |
| **● Day opened** | Green `rgba(74,222,128,*)` | `Close Day` (orange gradient) |
| **Day closed** | Slate `rgba(148,163,184,*)` | `Edit Close` · `↻ Reopen` |

### 3.6 Order Summary / cart
- Header: `ORDER SUMMARY` in gold, uppercase, `letter-spacing:1.5`, with a grid glyph.
- Branch + Default Stylist selectors grouped under micro-labels, divided from the cart by a `--border2` hairline.
- **Customer card** — walk-in placeholder (dashed) until a client is identified; then shows name, phone, and a colour-tiered "last visit N days ago" hint.
- **Empty state** — centred document glyph + `CART IS EMPTY`.
- **Totals** — Subtotal, `GST (5%)`, Online / Cash inputs, then the oversized **TOTAL RECEIVABLE** (display weight 900) as the visual finale.

### 3.7 Strips (Today's Bills / Drafts)
- Horizontal, scrollable pill rows above the grid.
- **Settled bills** → accent-tinted pills (`invoice_no · customer · ₹total`), click to re-open the printable preview.
- **Drafts** → neutral pills with an inline discard (🗑); the active/resumed draft turns solid accent.

---

## 4. Tokens (inherited)

| Token | Var | Role in POS |
| :--- | :--- | :--- |
| Accent (Cyan) | `--accent` #22d3ee | Prices, active chip, selected branch, focus ring, primary CTAs |
| Gold | `--gold` / `--gold2` | Branch label text, section titles, Open-Day gradient |
| Green | `--green` #4ade80 | Day-opened state, positive last-visit hints |
| Orange | `--orange` | Day-not-opened, Close-Day |
| Red | `--red` #f87171 | Discard, negative GST/errors |
| Surfaces | `--bg` → `--bg4` | Obsidian layering: ground → card → interactive rest |

**Type**: prices & Total Receivable use the display face at weight 900; labels are 9–11px uppercase bold micro-copy; service names 12px/800 with a 2-line clamp.

---

## 5. Interaction rules

- **Nothing before branch.** Adding to cart without a branch → warning toast; the empty-branch state shows the cursive V-Cut hero ("Pick a branch to unlock the menu").
- **Tap = add; hover = lift.** Cards never need a separate "add" button.
- **Search overrides browse.** A non-empty query hides chips and flattens all categories into one result set.
- **Instant math.** Every cart mutation recomputes subtotal/GST/total synchronously — no "recalculate" step.
- **Prefix hygiene.** Always `stripPrefix="V-CUT "` on branch labels in this screen.

---

## 6. Don'ts

- Don't box a `BranchSelect` inside another bordered container (empty-gap bug).
- Don't hide the Total Receivable below the fold — it is the screen's anchor.
- Don't show raw "V-CUT <branch>" text in the terminal.
- Don't replace tap-to-add cards with list rows — the tactile grid is the POS's identity.
- Don't mute the day-status banner; its colour is the cashier's first read of the screen.
