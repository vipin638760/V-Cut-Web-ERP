import { useState, useEffect, useCallback, useRef, memo } from "react";

// ── Toast Notification Hook ──
export function useToast() {
  const [toasts, setToasts] = useState([]);

  const toast = useCallback(({ title, message, type = "success", duration = 3000 }) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, title, message, type, entering: true }]);
    setTimeout(() => setToasts(prev => prev.map(t => t.id === id ? { ...t, entering: false } : t)), 50);
    setTimeout(() => setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t)), duration);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration + 400);
  }, []);

  const ToastContainer = toasts.length > 0 ? (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1200, display: "flex", flexDirection: "column-reverse", gap: 10, pointerEvents: "none" }}>
      <style>{`
        @keyframes toastIn { from { opacity:0; transform: translateX(80px) scale(0.95); } to { opacity:1; transform: translateX(0) scale(1); } }
        @keyframes toastOut { from { opacity:1; transform: translateX(0) scale(1); } to { opacity:0; transform: translateX(80px) scale(0.9); } }
      `}</style>
      {toasts.map(t => {
        const colors = {
          success: { bg: "rgba(22,163,74,0.12)", border: "rgba(74,222,128,0.3)", icon: "#4ade80", accent: "#22c55e" },
          error: { bg: "rgba(239,68,68,0.12)", border: "rgba(248,113,113,0.3)", icon: "#f87171", accent: "#ef4444" },
          warning: { bg: "rgba(245,158,11,0.12)", border: "rgba(251,191,36,0.3)", icon: "#fbbf24", accent: "#f59e0b" },
          info: { bg: "rgba(34,211,238,0.12)", border: "rgba(34,211,238,0.3)", icon: "#22d3ee", accent: "#06b6d4" },
        };
        const c = colors[t.type] || colors.success;
        return (
          <div key={t.id} style={{
            background: "var(--bg2)", border: `1px solid ${c.border}`, borderLeft: `4px solid ${c.accent}`,
            borderRadius: 12, padding: "14px 18px", minWidth: "min(300px, 90vw)", maxWidth: "min(400px, 90vw)", boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
            display: "flex", alignItems: "flex-start", gap: 12, pointerEvents: "auto",
            animation: t.exiting ? "toastOut 0.4s ease-in forwards" : "toastIn 0.35s ease-out"
          }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
              {t.type === 'success' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.icon} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              ) : t.type === 'error' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.icon} strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              ) : t.type === 'warning' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.icon} strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c.icon} strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>{t.title}</div>
              {t.message && <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: 1.4 }}>{t.message}</div>}
            </div>
          </div>
        );
      })}
    </div>
  ) : null;

  return { toast, ToastContainer };
}

// Shared SVG icons
export const Icons = {
  edit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  del:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>,
  log:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
  check:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  close:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
  info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  save: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  wallet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  arrowUp: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>,
  checkCircle: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  logout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  trending: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  pie: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>,
  support: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  sun: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  moon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
};

export function Icon({ name, size = 16, color = "currentColor" }) {
  const svg = Icons[name];
  if (!svg) return null;
  return (
    <span style={{ width: size, height: size, display: "inline-flex", color, flexShrink: 0 }}>
      {svg}
    </span>
  );
}

// Icon button
export function IconBtn({ name, onClick, title, variant = "secondary", size = 32 }) {
  const styles = {
    secondary: { background: "var(--bg4)", border: "1px solid rgba(72,72,71,0.2)", color: "var(--text2)" },
    danger:    { background: "var(--red-bg)", border: "1px solid rgba(248,113,113,0.2)", color: "var(--red)" },
    success:   { background: "var(--green-bg)", border: "1px solid rgba(74,222,128,0.2)", color: "var(--green)" },
    primary:   { background: "linear-gradient(135deg,var(--accent),var(--gold2))", border: "none", color: "#000" },
  };
  return (
    <button onClick={onClick} title={title}
      style={{ width: size, height: size, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .2s", flexShrink: 0, ...styles[variant] }}>
      <Icon name={name} size={size * 0.5} />
    </button>
  );
}

// Theme toggle
export function ThemeToggle({ size = 36 }) {
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    const saved = localStorage.getItem("vcut_theme");
    const isLight = document.documentElement.classList.contains("light-mode");
    setTheme(saved === "light" || isLight ? "light" : "dark");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("vcut_theme", next);
    document.documentElement.classList.toggle("light-mode", next === "light");
  };

  return (
    <button onClick={toggle} title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
      style={{
        width: size, height: size, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", transition: "all .3s", flexShrink: 0,
        background: "var(--bg4)", border: "1px solid rgba(72,72,71,0.2)", color: "var(--text2)",
      }}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={size * 0.45} />
    </button>
  );
}

// Status pill
export function Pill({ label, color = "gold" }) {
  const map = {
    green:  { bg: "rgba(74,222,128,0.08)",  text: "var(--green)",  border: "rgba(74,222,128,0.15)" },
    red:    { bg: "rgba(248,113,113,0.08)", text: "var(--red)",    border: "rgba(248,113,113,0.15)" },
    blue:   { bg: "rgba(96,165,250,0.08)",  text: "var(--blue)",   border: "rgba(96,165,250,0.15)" },
    orange: { bg: "rgba(251,146,60,0.08)",  text: "var(--orange)", border: "rgba(251,146,60,0.15)" },
    purple: { bg: "rgba(168,85,247,0.08)",  text: "#a855f7",       border: "rgba(168,85,247,0.15)" },
    gold:   { bg: "rgba(var(--accent-rgb),0.06)", text: "var(--accent)", border: "rgba(var(--accent-rgb),0.15)" },
  };
  const c = map[color] || map.gold;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "5px 10px", borderRadius: 8, fontSize: 10, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", lineHeight: 1, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
      {label}
    </span>
  );
}

// Card — uses surface hierarchy, no hard borders
export function Card({ children, style }) {
  const ref = useRef(null);
  const [overflow, setOverflow] = useState(false);
  const [scrollPos, setScrollPos] = useState({ atStart: true, atEnd: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const hasOverflow = el.scrollWidth > el.clientWidth + 1;
      setOverflow(hasOverflow);
      setScrollPos({
        atStart: el.scrollLeft <= 2,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
      });
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", check); };
  }, [children]);

  return (
    <div style={{ position: "relative" }}>
      {overflow && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "7px 14px", marginBottom: 8,
          background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.08) 0%, rgba(var(--accent-rgb),0.03) 100%)",
          border: "1px solid rgba(var(--accent-rgb),0.18)",
          borderRadius: 10,
          fontSize: 10, fontWeight: 700, color: "var(--accent)",
          textTransform: "uppercase", letterSpacing: 1,
        }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            opacity: scrollPos.atStart ? 0.35 : 1,
            transition: "opacity .15s",
          }}>
            <span style={{ fontSize: 13, lineHeight: 1 }}>←</span>
            <span>Scroll</span>
          </span>
          <span style={{ color: "var(--text3)", fontWeight: 600, letterSpacing: 0.5 }}>
            More data hidden — swipe to see
          </span>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            opacity: scrollPos.atEnd ? 0.35 : 1,
            transition: "opacity .15s",
          }}>
            <span>Scroll</span>
            <span style={{ fontSize: 13, lineHeight: 1 }}>→</span>
          </span>
        </div>
      )}
      <div style={{ position: "relative" }}>
        <div ref={ref} style={{ background: "var(--bg3)", borderRadius: 16, overflowX: "auto", marginBottom: 0, border: "1px solid rgba(72,72,71,0.12)", ...style }}>
          {children}
        </div>
        {overflow && !scrollPos.atEnd && (
          <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 32, pointerEvents: "none", background: "linear-gradient(270deg, var(--bg3) 0%, transparent 100%)", borderTopRightRadius: 16, borderBottomRightRadius: 16 }} />
        )}
        {overflow && !scrollPos.atStart && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: 32, pointerEvents: "none", background: "linear-gradient(90deg, var(--bg3) 0%, transparent 100%)", borderTopLeftRadius: 16, borderBottomLeftRadius: 16 }} />
        )}
      </div>
    </div>
  );
}

// Stats card
export function StatCard({ label, value, subtext, icon, trend, color = "accent" }) {
  const colors = { accent: "var(--accent)", green: "var(--green)", red: "var(--red)", gold: "var(--gold)", orange: "var(--orange)", purple: "#a855f7" };
  const c = colors[color] || colors.accent;
  return (
    <div style={{ background: "var(--bg3)", borderRadius: 16, padding: "22px 24px", flex: 1, minWidth: 200, position: "relative", overflow: "hidden", border: "1px solid rgba(72,72,71,0.1)" }}>
      <div style={{ position: "absolute", top: -15, right: -15, width: 80, height: 80, background: c, opacity: 0.04, borderRadius: "50%", filter: "blur(20px)" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "var(--font-body, var(--font-outfit))" }}>{label}</div>
        {icon && <div style={{ color: c, opacity: 0.6 }}>{icon}</div>}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", marginBottom: 4, letterSpacing: -0.5, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{value}</div>
      {subtext && <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 500 }}>{subtext}</div>}
      {trend && <div style={{ fontSize: 11, marginTop: 8, color: trend.startsWith("+") ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{trend}</div>}
    </div>
  );
}

// Progress bar
export function ProgressBar({ value, max = 100, label, color = "accent", size = "md" }) {
  const pct = Math.min(Math.round((value / max) * 100), 100);
  const heights = { sm: 4, md: 8, lg: 12 };
  const h = heights[size] || heights.md;
  const colors = { accent: "var(--accent)", green: "var(--green)", red: "var(--red)", gold: "var(--gold)" };
  const c = colors[color] || colors.accent;

  return (
    <div style={{ width: "100%" }}>
      {label && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase" }}>
        <span>{label}</span><span style={{ color: "var(--text)" }}>{pct}%</span>
      </div>}
      <div style={{ height: h, background: "var(--bg5)", borderRadius: h, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${c}, ${c}88)`, borderRadius: h, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

// Modal / Drawer
export function Modal({ isOpen, onClose, title, children, width }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => { if (isOpen) setPos({ x: 0, y: 0 }); }, [isOpen]);

  const onMouseDown = (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
  };
  const onMouseMove = (e) => { if (dragging) setPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }); };
  const onMouseUp = () => setDragging(false);

  useEffect(() => {
    if (dragging) { window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp); }
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  });

  if (!isOpen) return null;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)", zIndex: 1000, display: "flex", justifyContent: "center", alignItems: "center", padding: "16px" }}>
      <div onClick={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <div style={{ width: "100%", maxWidth: `min(${width || 500}px, 92vw)`, maxHeight: "90vh", background: "var(--bg2)", borderRadius: 16, position: "relative", display: "flex", flexDirection: "column", animation: "modalPop 0.25s ease-out", boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)", transform: `translate(${pos.x}px, ${pos.y}px)` }}>
        <style>{`@keyframes modalPop { from { opacity:0; transform: scale(0.95) translateY(10px); } to { opacity:1; transform: scale(1) translateY(0); } }`}</style>
        <div onMouseDown={onMouseDown} style={{ padding: "18px 24px", borderBottom: "1px solid rgba(72,72,71,0.15)", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: dragging ? "grabbing" : "grab", userSelect: "none", borderRadius: "16px 16px 0 0" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", letterSpacing: 0.5, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{title}</div>
          <IconBtn name="close" onClick={onClose} variant="secondary" />
        </div>
        <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

// ── Confirm Dialog (replaces browser confirm/alert) ──
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = ({ title, message, confirmText, cancelText, type, onConfirm }) => {
    setState({ title, message, confirmText: confirmText || "Confirm", cancelText: cancelText || "Cancel", type: type || "danger", onConfirm, resolve: null });
  };
  const close = () => setState(null);
  const handleConfirm = () => { state?.onConfirm?.(); close(); };

  const ConfirmDialog = state ? (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 1100, display: "flex", justifyContent: "center", alignItems: "center", padding: "16px" }}>
      <div onClick={close} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <div style={{ width: "100%", maxWidth: "min(400px, 92vw)", background: "var(--bg2)", borderRadius: 16, position: "relative", overflow: "hidden", animation: "modalPop 0.25s ease-out", boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)" }}>
        <style>{`@keyframes modalPop { from { opacity:0; transform: scale(0.95) translateY(10px); } to { opacity:1; transform: scale(1) translateY(0); } } @keyframes iconPulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.1); } }`}</style>
        {/* Icon header */}
        <div style={{ padding: "28px 24px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            background: state.type === 'danger' ? 'rgba(248,113,113,0.1)' : state.type === 'warning' ? 'rgba(251,191,36,0.1)' : state.type === 'success' ? 'rgba(74,222,128,0.1)' : 'rgba(34,211,238,0.1)',
            display: "flex", alignItems: "center", justifyContent: "center", animation: "iconPulse 0.6s ease-out"
          }}>
            {state.type === 'danger' ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            ) : state.type === 'warning' ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            ) : state.type === 'success' ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            )}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)", textAlign: "center", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{state.title}</div>
        </div>
        {/* Message */}
        <div style={{ padding: "0 24px 20px", fontSize: 13, color: "var(--text3)", textAlign: "center", lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: state.message }} />
        {/* Actions */}
        <div style={{ padding: "0 24px 24px", display: "flex", gap: 10 }}>
          <button onClick={close}
            style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "none", fontWeight: 600, fontSize: 13, cursor: "pointer", transition: "all .2s" }}>
            {state.cancelText}
          </button>
          <button onClick={handleConfirm}
            style={{
              flex: 1, padding: "12px 0", borderRadius: 10, border: "none", fontWeight: 700, fontSize: 13, cursor: "pointer", transition: "all .2s",
              background: state.type === 'danger' ? 'linear-gradient(135deg, #ef4444, #dc2626)' : state.type === 'warning' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : state.type === 'success' ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'linear-gradient(135deg, var(--accent), var(--gold2))',
              color: state.type === 'danger' || state.type === 'success' ? '#fff' : '#000'
            }}>
            {state.confirmText}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, ConfirmDialog };
}

// Period/month slicer
export function PeriodWidget({ filterMode, setFilterMode, filterYear, setFilterYear, filterMonth, setFilterMonth, onEdit, monthlyOnly }) {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div style={{ background: "var(--bg3)", border: "1px solid rgba(72,72,71,0.12)", borderRadius: 14, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {/* Monthly / Yearly toggle */}
      {!monthlyOnly && (
        <div style={{ display: "inline-flex", background: "var(--bg4)", borderRadius: 10, padding: 3, position: "relative" }}>
          <div style={{ position: "absolute", top: 3, bottom: 3, left: 3, width: "calc(50% - 3px)", background: "linear-gradient(135deg, var(--accent), var(--gold2))", borderRadius: 8, transform: filterMode === "month" ? "translateX(0)" : "translateX(100%)", transition: "all 0.3s ease", zIndex: 1 }} />
          <button onClick={() => setFilterMode("month")} style={{ flex: 1, border: "none", background: "transparent", color: filterMode === "month" ? "#000" : "var(--text3)", fontSize: 11, fontWeight: 700, padding: "7px 16px", borderRadius: 8, cursor: "pointer", zIndex: 2, transition: "color 0.3s", textTransform: "uppercase", position: "relative" }}>Monthly</button>
          <button onClick={() => setFilterMode("year")} style={{ flex: 1, border: "none", background: "transparent", color: filterMode === "year" ? "#000" : "var(--text3)", fontSize: 11, fontWeight: 700, padding: "7px 16px", borderRadius: 8, cursor: "pointer", zIndex: 2, transition: "color 0.3s", textTransform: "uppercase", position: "relative" }}>Yearly</button>
        </div>
      )}

      {/* Year */}
      <div style={{ position: "relative" }}>
        <select value={filterYear} onChange={e => setFilterYear(parseInt(e.target.value))}
          style={{ background: "var(--bg4)", border: "none", color: "var(--text2)", fontWeight: 700, fontSize: 13, padding: "7px 30px 7px 12px", borderRadius: 8, cursor: "pointer", appearance: "none", outline: "none" }}>
          {[2024,2025,2026].map(y => <option key={y} value={y} style={{background: "var(--bg2)", color: "var(--text)"}}>{y}</option>)}
        </select>
        <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text3)", fontSize: 8 }}>&#9660;</div>
      </div>

      {/* Months */}
      {filterMode === "month" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", background: "var(--bg4)", padding: 3, borderRadius: 10, flex: "1 1 480px", minWidth: 420, position: "relative" }}>
          <div style={{ position: "absolute", top: 3, bottom: 3, left: 3, width: "calc((100% - 6px) / 12)", background: "linear-gradient(135deg, var(--accent), var(--gold2))", borderRadius: 8, transform: `translateX(calc(100% * ${filterMonth - 1}))`, transition: "all 0.3s ease", zIndex: 1 }} />
          {MONTHS.map((m, i) => (
            <button key={i} onClick={() => setFilterMonth(i + 1)}
              style={{ border: "none", background: "transparent", color: filterMonth === i + 1 ? "#000" : "var(--text3)", padding: "8px 0", fontSize: 10, fontWeight: 700, cursor: "pointer", zIndex: 2, transition: "color 0.3s", textTransform: "uppercase", textAlign: "center" }}>
              {m}
            </button>
          ))}
        </div>
      )}

      {/* Current label */}
      <div style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1, display: "flex", alignItems: "center", gap: 8 }}>
         <span>{new Date(filterYear, filterMonth - 1, 1).toLocaleString("default", { month: filterMode === "month" ? "long" : undefined, year: "numeric" })}</span>
         {onEdit && filterMode === "month" && <IconBtn name="edit" size={24} onClick={onEdit} variant="primary" title="Quick Log" />}
      </div>
    </div>
  );
}

// Toggle group with sliding pill
export function ToggleGroup({ label, options, value, onChange, colors }) {
  const activeIndex = options.findIndex(opt => opt[0] === value);
  const total = options.length;
  const activeBg = colors?.[value] || "linear-gradient(135deg, var(--accent), var(--gold2))";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {label && <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>{label}</span>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${total}, 1fr)`, background: "var(--bg4)", borderRadius: 10, padding: 3, position: "relative", minWidth: total * 90, isolation: "isolate" }}>
        <div style={{ position: "absolute", top: 3, bottom: 3, left: `calc((100% / ${total} * ${activeIndex}) + 3px)`, width: `calc((100% / ${total}) - 6px)`, background: activeBg, borderRadius: 8, transition: "all 0.3s ease", zIndex: 0 }} />
        {options.map(([val, lbl]) => (
          <button key={val} onClick={() => onChange(val)}
            style={{ border: "none", background: "transparent", color: value === val ? "#000" : "var(--text3)", fontFamily: "var(--font-body, var(--font-outfit))", fontSize: 11, fontWeight: 700, padding: "8px 10px", borderRadius: 8, cursor: "pointer", transition: "color 0.3s", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap", zIndex: 1, position: "relative", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 30 }}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

// Tab navigation
export function TabNav({ tabs, activeTab, onTabChange }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "var(--bg3)", padding: 4, borderRadius: 12 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onTabChange(t.id)}
          style={{ flex: 1, padding: "10px 16px", fontSize: 12, fontWeight: 700, borderRadius: 10, border: "none", cursor: "pointer", transition: "all .2s",
            background: activeTab === t.id ? "var(--accent)" : "transparent",
            color: activeTab === t.id ? "#000" : "var(--text3)",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8, whiteSpace: "nowrap",
          }}>
          {t.icon && <span style={{ opacity: activeTab === t.id ? 1 : 0.5, fontSize: 14 }}>{t.icon}</span>}
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Sidebar ──
// Hamburger-style: closed by default, slides in when `isOpen` is true.
// `isPinned` keeps it locked open (desktop only — mobile always overlays).
export function Sidebar({ children, isOpen, isPinned, onClose, isMobile }) {
  const visible = isOpen || (isPinned && !isMobile);
  return (
    <>
      {/* Backdrop — only when overlay (not pinned) */}
      {visible && (!isPinned || isMobile) && (
        <div onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 49, transition: "opacity .2s" }} />
      )}
      <aside
        style={{
          width: 260, height: "100vh", position: "fixed", left: 0, top: 0,
          background: "var(--bg2)", display: "flex", flexDirection: "column",
          zIndex: 50, padding: 0,
          transform: visible ? "translateX(0)" : "translateX(-100%)",
          transition: "transform .25s ease",
          boxShadow: visible ? "4px 0 20px rgba(0,0,0,0.3)" : "none",
        }}>
        {children}
      </aside>
    </>
  );
}

// Floating hamburger button — always visible
export function SidebarToggle({ onClick, isOpen }) {
  return (
    <button onClick={onClick} title={isOpen ? "Close menu" : "Open menu"} aria-label="Toggle menu"
      style={{
        width: 40, height: 40, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text)",
        cursor: "pointer", flexShrink: 0,
      }}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {isOpen ? (
          <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
        ) : (
          <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>
        )}
      </svg>
    </button>
  );
}

// Pin button (used inside the sidebar footer)
export function SidebarPin({ pinned, onClick }) {
  return (
    <button onClick={onClick} title={pinned ? "Unpin sidebar" : "Pin sidebar (keep open)"}
      style={{
        width: 30, height: 30, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: pinned ? "var(--accent)" : "var(--bg4)", border: "1px solid var(--border)",
        color: pinned ? "#000" : "var(--text2)", cursor: "pointer", flexShrink: 0, transition: "all .2s",
      }}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 .55 1.38l2.52 2.62a1 1 0 0 1-.72 1.74H5.65a1 1 0 0 1-.72-1.74l2.52-2.62A2 2 0 0 0 9 10.76z"/>
      </svg>
    </button>
  );
}

export const SidebarItem = memo(function SidebarItem({ id, icon, label, isActive, onClick, onMouseEnter, onFocus, neon }) {
  const handleClick = useCallback(() => onClick?.(id), [onClick, id]);
  const handleEnter = useCallback(() => onMouseEnter?.(id), [onMouseEnter, id]);
  const handleFocus = useCallback(() => onFocus?.(id), [onFocus, id]);
  return (
    <button onClick={handleClick} onMouseEnter={handleEnter} onFocus={handleFocus}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", border: "none",
        background: isActive ? "rgba(var(--accent-rgb), 0.06)" : "transparent",
        color: isActive ? "var(--text)" : "var(--text3)", cursor: "pointer", transition: "all 0.2s",
        position: "relative", textAlign: "left", borderRadius: 10, margin: "1px 0",
      }}>
      {isActive && <div style={{ position: "absolute", left: 0, top: "25%", bottom: "25%", width: 3, background: "var(--accent)", borderRadius: "0 3px 3px 0" }} />}
      <div style={{ color: isActive ? "var(--accent)" : "var(--text3)", transition: "all 0.2s" }}>
        <Icon name={icon} size={18} />
      </div>
      <span style={{ fontSize: 13, fontWeight: isActive ? 700 : 500, letterSpacing: "0.3px", textTransform: "uppercase", opacity: isActive ? 1 : 0.6, fontFamily: "var(--font-body, var(--font-outfit))" }}>
        {label}
      </span>
      {neon && <div style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />}
    </button>
  );
});

// Avatar
export function Avatar({ src, name, size = 40, online }) {
  // Robust initials: trim, split on any whitespace run, drop empties.
  // Two+ parts → first-name initial + LAST-name initial (skip middle names).
  // One part → first two letters of that word. Fallback to "?".
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0]?.slice(0, 2) || "?").toUpperCase();
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <div style={{ width: "100%", height: "100%", borderRadius: 12, background: "linear-gradient(135deg, rgba(var(--accent-rgb),0.15), rgba(var(--accent-rgb),0.05))", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {src ? (
          <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: size * 0.38, fontWeight: 700, color: "var(--accent)", letterSpacing: 0 }}>{initials}</span>
        )}
      </div>
      {online && (
        <div style={{ position: "absolute", bottom: 0, right: 0, width: size * 0.25, height: size * 0.25, borderRadius: "50%", background: "#4ade80", border: `2px solid var(--bg2)` }} />
      )}
    </div>
  );
}

// Table components — cleaner, using surface shifts
export function TH({ children, right, sticky, ...props }) {
  return (
    <th {...props} style={{ background: "var(--bg4)", color: "var(--text3)", fontWeight: 600, fontSize: 10, padding: "14px 20px", textAlign: right ? "right" : "left", borderBottom: "1px solid rgba(72,72,71,0.1)", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: "1.5px", fontFamily: "var(--font-body, var(--font-outfit))", ...(sticky ? { position: "sticky", right: 0, background: "var(--bg4)", zIndex: 10 } : {}), ...props.style }}>
      {children}
    </th>
  );
}

export function TD({ children, right, sticky, style, ...props }) {
  return (
    <td {...props} style={{ padding: "14px 20px", borderBottom: "1px solid rgba(72,72,71,0.06)", color: "var(--text)", textAlign: right ? "right" : "left", fontWeight: 500, fontSize: 13, ...(sticky ? { position: "sticky", right: 0, background: "var(--bg3)", zIndex: 10 } : {}), ...style }}>
      {children}
    </td>
  );
}
