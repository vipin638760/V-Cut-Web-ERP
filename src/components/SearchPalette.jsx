"use client";
import { useState, useEffect, useCallback } from "react";
import { Icon } from "./ui";
import { useRouter } from "next/navigation";

export default function SearchPalette({ isOpen, onClose, context, userRole }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const router = useRouter();

  // Unified search registry — mirrors the sidebar NAV in dashboard/layout.js.
  // Every nav item lists the roles allowed to see it; filtering happens at render time
  // so the palette always reflects the active user's permissions.
  const registry = useCallback(() => {
    const ALL = [
      { id: "dashboard",             label: "Dashboard",              cat: "Navigation", icon: "home",        path: "/dashboard",                      roles: ["admin", "accountant", "employee"] },
      { id: "branches",              label: "Branch Performance",     cat: "Navigation", icon: "grid",        path: "/dashboard/branches",             roles: ["admin", "accountant"] },
      { id: "cash-collection",       label: "Cash Collection",        cat: "Navigation", icon: "wallet",      path: "/dashboard/cash-collection",      roles: ["admin", "accountant"] },
      { id: "incentive-calculator",  label: "Incentive Calculator",   cat: "Navigation", icon: "trending",    path: "/dashboard/incentive-calculator", roles: ["admin", "accountant"] },
      { id: "entry",                 label: "Daily Business Entry",   cat: "Navigation", icon: "edit",        path: "/dashboard/entry",                roles: ["admin", "accountant"] },
      { id: "pos",                   label: "POS Terminal",           cat: "Navigation", icon: "wallet",      path: "/dashboard/pos",                  roles: ["admin", "accountant"] },
      { id: "customers",             label: "Customers",              cat: "Navigation", icon: "users",       path: "/dashboard/customers",            roles: ["admin", "accountant"] },
      { id: "menu-config",           label: "Menu Configuration",     cat: "Navigation", icon: "grid",        path: "/dashboard/menu-config",          roles: ["admin", "accountant"] },
      { id: "staff",                 label: "Staff Management",       cat: "Navigation", icon: "users",       path: "/dashboard/staff",                roles: ["admin", "accountant"] },
      { id: "materials",             label: "Materials",              cat: "Navigation", icon: "wallet",      path: "/dashboard/materials",            roles: ["admin", "accountant"] },
      { id: "material-master",       label: "Material Master",        cat: "Navigation", icon: "grid",        path: "/dashboard/material-master",      roles: ["admin", "accountant"] },
      { id: "daily-expenses",        label: "Daily Expenses",         cat: "Navigation", icon: "wallet",      path: "/dashboard/daily-expenses",       roles: ["admin", "accountant"] },
      { id: "expenses",              label: "Operational Expenses",   cat: "Navigation", icon: "trending",    path: "/dashboard/expenses",             roles: ["admin", "accountant"] },
      { id: "pl",                    label: "P&L Analytics",          cat: "Navigation", icon: "pie",         path: "/dashboard/pl",                   roles: ["admin"] },
      { id: "leaves",                label: "Leave Management",       cat: "Navigation", icon: "checkCircle", path: "/dashboard/leaves",               roles: ["admin", "accountant"] },
      { id: "payroll",               label: "Payroll",                cat: "Navigation", icon: "wallet",      path: "/dashboard/payroll",              roles: ["admin"] },
      { id: "taskpedia",             label: "Taskpedia",              cat: "Navigation", icon: "checkCircle", path: "/dashboard/taskpedia",            roles: ["admin", "accountant", "employee"] },
      { id: "users",                 label: "Master Setup",           cat: "Navigation", icon: "settings",    path: "/dashboard/users",                roles: ["admin"] },
      { id: "day-working",           label: "Day Working",            cat: "Navigation", icon: "edit",        path: "/dashboard/day-working",          roles: ["employee"] },
      { id: "my-payroll",            label: "My Payroll",             cat: "Navigation", icon: "wallet",      path: "/dashboard/my-payroll",           roles: ["employee"] },
      { id: "apply-leave",           label: "Apply Leave",            cat: "Navigation", icon: "checkCircle", path: "/dashboard/apply-leave",          roles: ["employee"] },
    ];
    const items = userRole ? ALL.filter(it => it.roles.includes(userRole)) : ALL;

    // Branches + staff are searchable regardless of role — they just deep-link into
    // the branches / staff pages, which already gate their own UI.
    if (context?.branches) {
      context.branches.forEach(b => {
        items.push({ id: b.id, label: b.name, cat: "Nodes", icon: "grid", path: `/dashboard/branches?branchId=${b.id}` });
      });
    }
    if (context?.staff) {
      context.staff.forEach(s => {
        items.push({ id: s.id, label: s.name, cat: "Personnel", icon: "users", path: `/dashboard/staff?staffId=${s.id}` });
      });
    }

    return items;
  }, [context, userRole]);

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
              <div style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 16 }}>
                Quick Access {userRole && <span style={{ color: "var(--accent)", marginLeft: 6 }}>· {userRole.toUpperCase()}</span>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {registry().filter(it => it.cat === "Navigation").map((s, i) => (
                  <div
                    key={s.id + i}
                    onClick={() => { router.push(s.path); onClose(false); }}
                    style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text2)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                    onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                  >
                    <Icon name={s.icon} size={14} color="var(--accent)" />
                    {s.label}
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
