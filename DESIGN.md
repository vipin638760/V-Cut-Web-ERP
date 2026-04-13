# V-cut Design System: The Obsidian Atelier

## 1. Creative North Star: "Atmospheric Depth"
The **V-cut Employee Portal** is designed as a premium, editorial-grade workspace rather than a standard SaaS utility. The system reimagines the interface as a series of deep, obsidian-layered surfaces illuminated by surgical strikes of neon cyan.

### Core Principles
- **Obsidian Layering**: Depth is created through tonal shifts in dark backgrounds rather than physical lines or shadows.
- **Neon Luminescence**: Use functional highlights (Cyan, Lime) to guide the eye and represent "live" data.
- **Glassmorphism**: High-level summaries and navigation utilize backdrop blurs to maintain context and premium feel.
- **Big-Small Hierarchy**: Leading metrics are oversized (Editorial Display) while supporting metadata is fine-tuned micro-copy.

---

## 2. Design Tokens

### Color Palette (Dark Mode - Primary)
| Token | Variable | Value | Usage |
| :--- | :--- | :--- | :--- |
| **Background** | `--bg` | `#020202` | Root ground layer |
| **Surface 1** | `--bg2` | `#080808` | Primary cards and sections |
| **Surface 2** | `--bg3` | `#0f0f0f` | Tertiary sections and table headers |
| **Surface 3** | `--bg4` | `#141414` | Interactive backgrounds (button rests) |
| **Accent (Cyan)** | `--accent` | `#22d3ee` | Primary actions, KPIs, and "glows" |
| **Success (Lime)** | `--green` | `#4ade80` | Positive statuses, active indicators |
| **Alert (Red)** | `--red` | `#f87171` | High priority alerts and deletions |

### Typography
- **Primary Font**: `Manrope` / `Outfit` (Sans-serif)
- **Brand Font**: `Great Vibes` (Cursive) - Used exclusively for the "V-cut" signature logo.
- **Scale**:
  - `Display`: 24px+ | Heavy weight (900) | Metric visualization.
  - `Headline`: 18px | Semi-bold (800) | Section titles.
  - `Body`: 13px | Regular (400) | Primary content.
  - `Label`: 10px-11px | Bold (700) | Metadata and micro-copy (Uppercase).

---

## 3. Core Components (`ui.jsx`)

### 3.1 `StatCard`
Used for KPI visualization on dashboards.
- **Props**: `label`, `value`, `subtext`, `icon`, `trend`, `color`.
- **Logic**: Automatically applies a subtle radial glow in the corner matching the theme color.

### 3.2 `PeriodWidget`
A complex management tool for time-based filtering.
- **Features**: 
  - Dynamic sliding pill animations for Month/Year selection.
  - Linear gradients (`Cyan` to `Gold`) for active indicators.
  - Integrated "Quick Log" action shortcut.

### 3.3 `ToggleGroup`
Segmented controls with a physical-feeling sliding "glass" pill.
- **Pattern**: Uses `isolation: isolate` and `zIndex` layering to ensure the sliding pill feels part of the track.

### 3.4 `ProgressBar`
Animated progress visualization.
- **Visuals**: Includes an outer glow (`box-shadow`) to simulate a neon light bar.
- **Animation**: Snappy cubic-bezier transition (`0.34, 1.56, 0.64, 1`).

---

## 4. Layout & UI Patterns

### The "No-Line" Rule
1px solid borders are strictly avoided for structural sectioning. Contrast between Surface Tiers (`--bg` to `--bg3`) must define boundaries. If a border is necessary (e.g., input fields), it should use `rgba(255, 255, 255, 0.08)` to remain felt, not seen.

### Global Watermark
The system maintains brand presence through a large, low-opacity fixed background watermark (`font-size: 18vw`, `opacity: 0.03`).

### Interaction Design
- **Hover States**: Interactive elements should shift background to a brighter surface tier (e.g., `bg4` -> `bg5`) or gain a subtle accent inner-glow.
- **Glass Effects**: Top navigation and modals use `backdrop-filter: blur(12px)` with `rgba(10, 10, 10, 0.7)` background.

---

## 5. Technical Implementation Details

### CSS Strategy
- **Tailwind + Variables**: The system uses `@theme` in CSS to map Tailwind colors to CSS variables, allowing for dynamic theme switching.
- **Custom Scrollbars**: Minimalist dark-themed scrollbars are implemented to maintain immersion.
- **Accessibility**: Number inputs have spinners disabled globally; date pickers are styled using `filter: invert` to match the Cyan theme.

### Global Variables Manifest
```css
--accent-glow: 0 0 15px rgba(34, 211, 238, 0.4);
--card-shadow: 0 8px 25px rgba(0, 0, 0, 0.5);
--glass: rgba(10, 10, 10, 0.7);
```
