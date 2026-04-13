"use client";
import { useState, useEffect, useCallback } from "react";
import { Icon, Pill } from "./ui";
import { useRouter } from "next/navigation";

export default function SearchPalette({ isOpen, onClose, context }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const router = useRouter();

  // Unified search registry
  const registry = useCallback(() => {
    const items = [
      { id: "dashboard", label: "Operational Dashboard", cat: "Navigation", icon: "home", path: "/dashboard" },
      { id: "branches",  label: "Network Nodes (Branches)", cat: "Navigation", icon: "grid", path: "/dashboard/branches" },
      { id: "staff",     label: "Force Registry (Staff)", cat: "Navigation", icon: "users", path: "/dashboard/staff" },
      { id: "leaves",    label: "Leave Authorization", cat: "Navigation", icon: "checkCircle", path: "/dashboard/leaves" },
      { id: "payroll",   label: "Financial Settlements", cat: "Navigation", icon: "wallet", path: "/dashboard/payroll" },
      { id: "setup",     label: "Master Protocols", cat: "Navigation", icon: "settings", path: "/dashboard/users" },
    ];

    // Add branches if provided
    if (context?.branches) {
      context.branches.forEach(b => {
        items.push({ id: b.id, label: b.name, cat: "Nodes", icon: "grid", path: `/dashboard/branches?branchId=${b.id}` });
      });
    }

    // Add staff if provided
    if (context?.staff) {
      context.staff.forEach(s => {
        items.push({ id: s.id, label: s.name, cat: "Personnel", icon: "users", path: `/dashboard/staff?staffId=${s.id}` });
      });
    }

    return items;
  }, [context]);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    const q = query.toLowerCase();
    const filtered = registry().filter(item => 
      item.label.toLowerCase().includes(q) || 
      item.cat.toLowerCase().includes(q)
    ).slice(0, 8);
    setResults(filtered);
  }, [query, registry]);

  useEffect(() => {
    const handleDown = (e) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onClose(!isOpen);
      }
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", handleDown);
    return () => window.removeEventListener("keydown", handleDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      onClick={() => onClose(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(12px)",
        zIndex: 10000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        animation: "paletteIn 0.3s cubic-bezier(0,0,0,1)"
      }}
    >
      <div 
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 650,
          background: "var(--bg2)",
          borderRadius: 24,
          border: "1px solid var(--border)",
          boxShadow: "0 40px 100px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.05)",
          overflow: "hidden"
        }}
      >
        <div style={{ position: "relative", borderBottom: "1px solid var(--border2)" }}>
          <div style={{ position: "absolute", left: 24, top: "50%", transform: "translateY(-50%)", color: "var(--accent)" }}>
            <Icon name="search" size={22} />
          </div>
          <input 
            autoFocus
            placeholder="Search command palette..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{
              width: "100%",
              height: 72,
              background: "transparent",
              border: "none",
              padding: "0 24px 0 64px",
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text)",
              outline: "none"
            }}
          />
          <div style={{ position: "absolute", right: 24, top: "50%", transform: "translateY(-50%)", display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ padding: "4px 8px", background: "rgba(255,255,255,0.05)", borderRadius: 6, fontSize: 10, fontWeight: 900, color: "var(--text3)", border: "1px solid var(--border2)" }}>ESC</div>
          </div>
        </div>

        <div style={{ maxHeight: 400, overflowY: "auto", padding: 12 }}>
          {results.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {results.map((res, i) => (
                <div 
                  key={i}
                  onClick={() => { router.push(res.path); onClose(false); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "14px 18px",
                    borderRadius: 14,
                    cursor: "pointer",
                    transition: "all 0.2s"
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = "rgba(34,211,238,0.1)";
                    e.currentTarget.style.transform = "translateX(6px)";
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.transform = "translateX(0)";
                  }}
                >
                  <div style={{ width: 40, height: 40, background: "rgba(255,255,255,0.03)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border2)" }}>
                    <Icon name={res.icon} size={20} color="var(--accent)" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>{res.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>{res.cat}</div>
                  </div>
                  <Icon name="trending" size={14} style={{ opacity: 0.3 }} />
                </div>
              ))}
            </div>
          ) : query ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13, fontWeight: 600 }}>
              No matches found for "{query}"
            </div>
          ) : (
            <div style={{ padding: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 16 }}>Suggested Commands</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { l: "Operational P&L", p: "/dashboard/pl", i: "pie" },
                  { l: "Employee Setup", p: "/dashboard/staff", i: "users" },
                  { l: "Network Hub", p: "/dashboard/branches", i: "grid" },
                  { l: "Protocol Settings", p: "/dashboard/users", i: "settings" }
                ].map((s, i) => (
                  <div 
                    key={i}
                    onClick={() => { router.push(s.p); onClose(false); }}
                    style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text2)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                    onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                  >
                    <Icon name={s.i} size={14} color="var(--accent)" />
                    {s.l}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes paletteIn {
          from { opacity: 0; transform: scale(0.98) translateY(-10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
