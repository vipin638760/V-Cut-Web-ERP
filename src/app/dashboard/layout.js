"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar, SidebarItem, SidebarToggle, SidebarPin, Icon, IconBtn, ThemeToggle, Avatar, useConfirm } from "@/components/ui";
import SearchPalette from "@/components/SearchPalette";
import VLoader from "@/components/VLoader";
import BellNotifications from "@/components/BellNotifications";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";

// Each item carries `s` (section) so the sidebar can group the long list into
// labelled blocks in its default order. Icons are distinct per item.
const NAV = {
  admin: [
    { id: "dashboard", l: "Dashboard",             icon: "home",       s: "Overview" },
    { id: "branches",  l: "Branch Performance",    icon: "store",      s: "Overview" },
    { id: "staff-performance", l: "Staff Performance", icon: "award",   s: "Overview" },
    { id: "analytics", l: "Analytics",             icon: "barChart",   s: "Overview" },
    { id: "pl",        l: "P&L Analytics",         icon: "pie",        s: "Overview" },

    { id: "entry",     l: "Daily Business Entry",  icon: "edit",       s: "Daily Ops" },
    { id: "pos",       l: "POS Terminal",          icon: "creditCard", s: "Daily Ops" },
    { id: "customers", l: "Customers",             icon: "users",      s: "Daily Ops" },
    { id: "menu-config", l: "Menu Configuration",  icon: "scissors",   s: "Daily Ops" },
    { id: "cash-collection", l: "Cash Collection", icon: "coins",      s: "Daily Ops" },
    { id: "incentive-calculator", l: "Incentive Calculator", icon: "percent", s: "Daily Ops" },

    { id: "materials", l: "Material Entry",        icon: "box",        s: "Inventory & Expenses" },
    { id: "material-master", l: "Historic Material", icon: "archive",  s: "Inventory & Expenses" },
    { id: "daily-expenses", l: "Online Expense Paid", icon: "receipt", s: "Inventory & Expenses" },
    { id: "payables",  l: "Payments To Be Paid",   icon: "clock",      s: "Inventory & Expenses" },
    { id: "expenses",  l: "Operational Expenses",  icon: "trending",   s: "Inventory & Expenses" },

    { id: "staff",     l: "Staff Management",      icon: "idCard",     s: "Team" },
    { id: "leaves",    l: "Leave Management",      icon: "calendar",   s: "Team" },
    { id: "payroll",   l: "Payroll",               icon: "wallet",     s: "Team" },
    { id: "taskpedia", l: "Taskpedia",             icon: "bookOpen",   s: "Team" },
    { id: "contacts",  l: "Contact Directory",     icon: "phone",      s: "Team" },

    { id: "users",     l: "Master Setup",          icon: "settings",   s: "System" },
  ],
  accountant: [
    { id: "dashboard", l: "Dashboard",             icon: "home",       s: "Overview" },
    { id: "branches",  l: "Branch Performance",    icon: "store",      s: "Overview" },
    { id: "staff-performance", l: "Staff Performance", icon: "award",   s: "Overview" },

    { id: "entry",     l: "Daily Business Entry",  icon: "edit",       s: "Daily Ops" },
    { id: "pos",       l: "POS Terminal",          icon: "creditCard", s: "Daily Ops" },
    { id: "customers", l: "Customers",             icon: "users",      s: "Daily Ops" },
    { id: "menu-config", l: "Menu Configuration",  icon: "scissors",   s: "Daily Ops" },
    { id: "cash-collection", l: "Cash Collection", icon: "coins",      s: "Daily Ops" },
    { id: "incentive-calculator", l: "Incentive Calculator", icon: "percent", s: "Daily Ops" },

    { id: "materials", l: "Material Entry",        icon: "box",        s: "Inventory & Expenses" },
    { id: "material-master", l: "Historic Material", icon: "archive",  s: "Inventory & Expenses" },
    { id: "daily-expenses", l: "Online Expense Paid", icon: "receipt", s: "Inventory & Expenses" },
    { id: "payables",  l: "Payments To Be Paid",   icon: "clock",      s: "Inventory & Expenses" },
    { id: "expenses",  l: "Operational Expenses",  icon: "trending",   s: "Inventory & Expenses" },

    { id: "staff",     l: "Staff Management",      icon: "idCard",     s: "Team" },
    { id: "leaves",    l: "Leave Management",      icon: "calendar",   s: "Team" },
    { id: "taskpedia", l: "Taskpedia",             icon: "bookOpen",   s: "Team" },
    { id: "contacts",  l: "Contact Directory",     icon: "phone",      s: "Team" },
  ],
  employee: [
    { id: "dashboard",      l: "Dashboard",        icon: "home",       s: "Overview" },
    { id: "day-working",    l: "Day Working",      icon: "edit",       s: "My Work" },
    { id: "my-payroll",     l: "My Payroll",       icon: "wallet",     s: "My Work" },
    { id: "apply-leave",    l: "Apply Leave",      icon: "calendar",   s: "My Work" },
    { id: "taskpedia",      l: "Taskpedia",        icon: "bookOpen",   s: "My Work" },
  ],
};

const hrefFor = (id) => (id === "dashboard" ? "/dashboard" : `/dashboard/${id}`);

export default function DashboardLayout({ children }) {
  const [user, setUser] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [context, setContext] = useState({ branches: [], staff: [] });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  const router   = useRouter();
  const pathname = usePathname();
  const prefetched = useRef(new Set());

  useEffect(() => {
    const phoneMq = window.matchMedia("(max-width: 600px)");
    const tabletMq = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setIsMobile(phoneMq.matches);
      setIsTablet(tabletMq.matches);
    };
    update();
    phoneMq.addEventListener("change", update);
    tabletMq.addEventListener("change", update);
    return () => {
      phoneMq.removeEventListener("change", update);
      tabletMq.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const pinned = localStorage.getItem("vcut_sidebar_pinned") === "1";
    setSidebarPinned(pinned);
  }, []);

  const togglePin = useCallback(() => {
    setSidebarPinned(p => {
      const next = !p;
      localStorage.setItem("vcut_sidebar_pinned", next ? "1" : "0");
      return next;
    });
  }, []);

  useEffect(() => {
    if (!sidebarPinned || isMobile) setSidebarOpen(false);
  }, [pathname, sidebarPinned, isMobile]);

  const effectivelyPinned = sidebarPinned && !isMobile;

  useEffect(() => {
    const saved = sessionStorage.getItem("vcut_user") || localStorage.getItem("vcut_user");
    if (!saved) { router.push("/"); return; }
    setUser(JSON.parse(saved));
  }, [router]);

  // Lazy Firestore subscriptions — only attach when the search palette is opened.
  // Keeps the dashboard from re-rendering on every branch/staff write.
  useEffect(() => {
    if (!showSearch || !db) return;
    const unsubB = onSnapshot(collection(db, "branches"), sn =>
      setContext(prev => ({ ...prev, branches: sn.docs.map(d => ({ name: d.data().name, id: d.id })) })));
    const unsubS = onSnapshot(collection(db, "staff"), sn =>
      setContext(prev => ({ ...prev, staff: sn.docs.map(d => ({ name: d.data().name, id: d.id })) })));
    return () => { unsubB(); unsubS(); };
  }, [showSearch]);

  const roleNav = useMemo(() => (user ? NAV[user.role] || [] : []), [user]);

  // ── Draggable sidebar order, persisted per-role in localStorage ──
  const [navOrder, setNavOrder] = useState([]);
  const [navDragId, setNavDragId] = useState(null);
  const [navDragOverId, setNavDragOverId] = useState(null);
  const [navFilter, setNavFilter] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState(() => new Set());

  // Restore rail + collapsed-section preferences
  useEffect(() => {
    try {
      setRailCollapsed(localStorage.getItem("vcut_sidebar_rail") === "1");
      const saved = localStorage.getItem("vcut_nav_collapsed_sections");
      if (saved) setCollapsedSections(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
  }, []);

  const toggleRail = useCallback(() => {
    setRailCollapsed(r => {
      const next = !r;
      try { localStorage.setItem("vcut_sidebar_rail", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  const toggleSection = useCallback((name) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      try { localStorage.setItem("vcut_nav_collapsed_sections", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const railActive = railCollapsed && effectivelyPinned;
  const sidebarWidth = railActive ? 76 : 260;

  useEffect(() => {
    if (!user?.role || typeof window === "undefined") return;
    try {
      const saved = localStorage.getItem(`vcut_nav_order_${user.role}`);
      if (saved) setNavOrder(JSON.parse(saved));
      else setNavOrder([]);
    } catch { /* ignore */ }
  }, [user?.role]);

  // Apply the saved order on top of roleNav; any new nav items that were not
  // in the saved order are appended at the bottom so they still appear.
  let orderedNav = roleNav;
  if (navOrder && navOrder.length > 0) {
    const byId = new Map(roleNav.map(n => [n.id, n]));
    const result = [];
    navOrder.forEach(id => {
      if (byId.has(id)) { result.push(byId.get(id)); byId.delete(id); }
    });
    byId.forEach(n => result.push(n));
    orderedNav = result;
  }

  const reorderNav = useCallback((fromId, toId) => {
    if (!fromId || fromId === toId) return;
    const ids = orderedNav.map(n => n.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, fromId);
    setNavOrder(next);
    try { localStorage.setItem(`vcut_nav_order_${user.role}`, JSON.stringify(next)); } catch { /* ignore */ }
  }, [orderedNav, user?.role]);

  const resetNavOrder = useCallback(() => {
    setNavOrder([]);
    try { localStorage.removeItem(`vcut_nav_order_${user?.role}`); } catch { /* ignore */ }
  }, [user?.role]);

  // Prefetch on hover/focus rather than all at mount — avoids a boot-time bundle storm.
  const handlePrefetch = useCallback((id) => {
    if (prefetched.current.has(id)) return;
    prefetched.current.add(id);
    try { router.prefetch(hrefFor(id)); } catch {}
  }, [router]);

  const handleNav = useCallback((id) => {
    router.push(hrefFor(id));
    if (!sidebarPinned || isMobile) setSidebarOpen(false);
  }, [router, sidebarPinned, isMobile]);

  if (!user) return <VLoader fullscreen label="Connecting" />;
  if (loggingOut) return <VLoader fullscreen label="Signing out" />;

  const parts = pathname.split("/").filter(Boolean);
  const currentTab = parts.length >= 2 ? parts[1] : "dashboard";
  const activeTab  = currentTab || "dashboard";

  const firstName = (user.name || "").trim().split(/\s+/)[0] || "there";
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 21 ? "Good evening" : "Good night";

  // Renders one nav row. Dragging is enabled only in the normal (unfiltered) list.
  const renderNavItem = (n, draggable) => {
    const isActive = activeTab === n.id || (n.id === "dashboard" && (activeTab === "" || activeTab === "dashboard"));
    const isDraggingThis = navDragId === n.id;
    const isOverThis = navDragOverId === n.id && !isDraggingThis;
    return (
      <div
        key={n.id}
        draggable={draggable ? "true" : "false"}
        onDragStart={draggable ? (ev) => {
          setNavDragId(n.id);
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", n.id);
          }
        } : undefined}
        onDragOver={draggable ? (ev) => {
          ev.preventDefault();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
          if (navDragId && navDragId !== n.id) setNavDragOverId(n.id);
        } : undefined}
        onDragLeave={draggable ? () => { if (navDragOverId === n.id) setNavDragOverId(null); } : undefined}
        onDrop={draggable ? (ev) => {
          ev.preventDefault();
          reorderNav(navDragId, n.id);
          setNavDragId(null);
          setNavDragOverId(null);
        } : undefined}
        onDragEnd={draggable ? () => { setNavDragId(null); setNavDragOverId(null); } : undefined}
        style={{
          opacity: isDraggingThis ? 0.4 : 1,
          borderRadius: 10,
          boxShadow: isOverThis ? "inset 0 2px 0 0 var(--accent)" : "none",
          transition: "opacity .15s, box-shadow .15s",
          cursor: draggable ? (navDragId ? "grabbing" : "grab") : "default",
        }}
      >
        <SidebarItem
          id={n.id}
          icon={n.icon}
          label={n.l}
          isActive={isActive}
          collapsed={railActive}
          onClick={handleNav}
          onMouseEnter={handlePrefetch}
          onFocus={handlePrefetch}
        />
      </div>
    );
  };

  const handleLogout = () => {
    confirm({
      title: "Sign out of V-Cut?",
      message: `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:4px;">
          <div style="padding:10px 16px;border-radius:10px;background:rgba(34,211,238,0.06);border:1px solid rgba(34,211,238,0.2);display:inline-block;">
            <div style="font-size:14px;font-weight:700;color:var(--text);">${user.name}</div>
            <div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1.5px;margin-top:2px;">${user.role}</div>
          </div>
          <div style="font-size:12px;color:var(--text3);">You will need to sign in again to access the dashboard.</div>
        </div>
      `,
      confirmText: "Sign Out",
      cancelText: "Stay Signed In",
      type: "warning",
      onConfirm: () => {
        setLoggingOut(true);
        localStorage.removeItem("vcut_user");
        sessionStorage.removeItem("vcut_user");
        router.push("/");
      },
    });
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg1)" }}>

      <SearchPalette isOpen={showSearch} onClose={setShowSearch} context={context} userRole={user?.role} />


      {/* ── Sidebar ── */}
      <Sidebar isOpen={sidebarOpen} isPinned={sidebarPinned} isMobile={isMobile} width={sidebarWidth} onClose={() => setSidebarOpen(false)}>
        <div style={{ padding: railActive ? "22px 0 18px" : "24px 18px 18px", display: "flex", alignItems: "center", justifyContent: railActive ? "center" : "space-between", gap: 8 }}>
          {railActive ? (
            <span style={{ fontFamily: "var(--font-vibes)", fontSize: 30, lineHeight: 1, color: "var(--red)" }}>V</span>
          ) : (
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: 3, margin: 0, lineHeight: 1, whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--red)", fontFamily: "var(--font-vibes)", fontSize: "1.4em", fontWeight: 400 }}>V</span>
              <span style={{ color: "var(--text)", fontFamily: "var(--font-vibes)", fontWeight: 400 }}>-Cut</span>
              <span style={{ color: "var(--accent)", fontWeight: 700, letterSpacing: 4, fontSize: ".5em", marginLeft: 6, fontFamily: "var(--font-headline, var(--font-outfit))" }}>SALON</span>
            </h1>
          )}
          {effectivelyPinned && !railActive && (
            <button onClick={toggleRail} title="Collapse to icons" aria-label="Collapse sidebar"
              className="vcut-icon-btn"
              style={{ width: 28, height: 28, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text3)", cursor: "pointer", flexShrink: 0 }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/><line x1="4" y1="6" x2="4" y2="18"/></svg>
            </button>
          )}
        </div>
        {railActive && (
          <div style={{ display: "flex", justifyContent: "center", padding: "0 0 8px" }}>
            <button onClick={toggleRail} title="Expand menu" aria-label="Expand sidebar"
              className="vcut-icon-btn"
              style={{ width: 32, height: 32, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--bg4)", border: "1px solid var(--border)", color: "var(--text3)", cursor: "pointer" }}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/><line x1="20" y1="6" x2="20" y2="18"/></svg>
            </button>
          </div>
        )}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Quick filter — type to narrow the menu (hidden in icon-rail mode) */}
          {!railActive && (
            <div style={{ padding: "0 12px 10px", position: "relative" }}>
              <div style={{ position: "absolute", left: 22, top: "calc(50% - 5px)", transform: "translateY(-50%)", color: "var(--text3)", opacity: 0.6, pointerEvents: "none" }}>
                <Icon name="search" size={14} />
              </div>
              <input
                value={navFilter}
                onChange={(e) => setNavFilter(e.target.value)}
                placeholder="Filter menu…"
                aria-label="Filter menu"
                className="vcut-nav-filter"
              />
            </div>
          )}

          <div className="vcut-nav-scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", padding: railActive ? "0 10px 8px" : "0 8px 8px" }}>
            {(() => {
              const q = railActive ? "" : navFilter.trim().toLowerCase();
              const list = q ? orderedNav.filter(n => n.l.toLowerCase().includes(q)) : orderedNav;
              if (list.length === 0) {
                return <div style={{ padding: "18px 20px", fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>No menu items match “{navFilter}”.</div>;
              }
              // Group headers only in default order, unfiltered, and not in rail mode.
              const showGroups = navOrder.length === 0 && !q && !railActive;
              const out = [];
              let lastSection = null;
              let hiddenSection = null; // when a section is collapsed, skip its items
              list.forEach((n) => {
                if (showGroups && n.s && n.s !== lastSection) {
                  lastSection = n.s;
                  const isCollapsed = collapsedSections.has(n.s);
                  hiddenSection = isCollapsed ? n.s : null;
                  out.push(
                    <button key={`sec-${n.s}`} type="button" onClick={() => toggleSection(n.s)}
                      className="vcut-nav-section vcut-nav-section-btn"
                      aria-expanded={!isCollapsed}
                      style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer" }}>
                      <span style={{ marginRight: 2, transition: "transform .2s", transform: isCollapsed ? "rotate(-90deg)" : "none", display: "inline-flex" }}>
                        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                      </span>
                      {n.s}
                    </button>
                  );
                }
                if (hiddenSection && n.s === hiddenSection) return;
                out.push(renderNavItem(n, !q));
              });
              return out;
            })()}

            {navOrder.length > 0 && !navFilter && !railActive && (
              <button onClick={resetNavOrder}
                title="Restore the default menu order"
                style={{ margin: "10px 8px 4px", padding: "7px 10px", borderRadius: 8, background: "transparent", border: "1px dashed rgba(var(--accent-rgb),0.3)", color: "var(--text3)", fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer" }}>
                Reset menu order
              </button>
            )}
          </div>
        </div>

        {railActive ? (
          <div style={{ padding: "14px 0", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <Avatar name={user.name} size={36} online />
            <IconBtn name="logout" onClick={handleLogout} variant="secondary" size={30} title="Logout" />
          </div>
        ) : (
          <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={user.name} size={38} online />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>{user.role}</span>
              </div>
            </div>
            {!isMobile && <SidebarPin pinned={sidebarPinned} onClick={togglePin} />}
            <IconBtn name="logout" onClick={handleLogout} variant="secondary" size={30} title="Logout" />
          </div>
        )}
      </Sidebar>

      {/* ── Main Content ── */}
      <main style={{
        marginLeft: effectivelyPinned ? sidebarWidth : 0,
        flex: 1,
        padding: isTablet ? "16px 14px" : "32px 48px",
        maxWidth: 1600,
        width: "100%",
        boxSizing: "border-box",
        transition: "margin-left .25s ease",
      }}>
        {/* Command Bar */}
        <div className="vcut-cmdbar" style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap",
          marginBottom: isMobile ? 18 : 28,
          marginTop: isTablet ? -16 : -32,
          marginLeft: isTablet ? -14 : -48, marginRight: isTablet ? -14 : -48,
          padding: isTablet ? "12px 14px" : "16px 48px",
        }}>
           <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
              <SidebarToggle isOpen={sidebarOpen} onClick={() => setSidebarOpen(o => !o)} />
              <div onClick={() => setShowSearch(true)} style={{ position: "relative", flex: 1, maxWidth: 400, minWidth: 0, cursor: "text" }}>
                 <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", opacity: 0.5 }}>
                   <Icon name="search" size={16} />
                 </div>
                 <div className="vcut-cmd-search" style={{ width: "100%", background: "var(--bg3)", borderRadius: 12, padding: "12px 16px 12px 44px", color: "var(--text3)", fontSize: 13, fontWeight: 500, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid var(--border)", boxSizing: "border-box" }}>
                    Search...
                    <div style={{ padding: "3px 7px", background: "var(--bg4)", borderRadius: 6, fontSize: 10, fontWeight: 700, color: "var(--text3)" }}>&#8984;K</div>
                 </div>
              </div>
           </div>

           <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, flexWrap: "wrap" }}>
              {!isMobile && (
                <div style={{ textAlign: "right", lineHeight: 1.2 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>{greeting}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>
                    {firstName}
                    <span style={{ color: "var(--accent)", marginLeft: 4 }}>👋</span>
                  </div>
                </div>
              )}

              {/* Grouped utility actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12, padding: 4 }}>
                <RefreshButton />
                {(user.role === "admin" || user.role === "accountant") && <BellNotifications currentUser={user} />}
                <ThemeToggle size={32} />
              </div>

              <IconBtn name="plus" variant="primary" title="New Entry" onClick={() => router.push("/dashboard/entry")} size={38} />
              {!isMobile && <Avatar name={user.name} size={38} online />}
           </div>
        </div>

        {children}
      </main>
      <PageScrollSlider />
      {ConfirmDialog}
    </div>
  );
}

// Fixed vertical drag-to-scroll slider on the right edge of the viewport. Only shows
// when the page has scrollable vertical overflow, so tall pages get a drag handle and
// short ones stay clean. Mirrors + drives window.scrollY.
function PageScrollSlider() {
  const [state, setState] = useState({ y: 0, max: 0, overflow: false });

  useEffect(() => {
    const check = () => {
      const max = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
      setState({ y: window.scrollY || 0, max, overflow: max > 80 });
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    const ro = new ResizeObserver(check);
    ro.observe(document.documentElement);
    return () => { window.removeEventListener("scroll", check); window.removeEventListener("resize", check); ro.disconnect(); };
  }, []);

  if (!state.overflow) return null;
  return (
    <div style={{
      position: "fixed", right: 8, top: "50%", transform: "translateY(-50%)",
      zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center",
      gap: 6, padding: "8px 4px", background: "rgba(var(--accent-rgb),0.08)",
      border: "1px solid rgba(var(--accent-rgb),0.2)", borderRadius: 12,
      backdropFilter: "blur(8px)",
    }}>
      <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        aria-label="Scroll to top"
        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 14, fontWeight: 800, padding: 2 }}>⇈</button>
      <input type="range" min={0} max={Math.max(1, state.max)} value={state.y}
        onChange={(e) => window.scrollTo({ top: Number(e.target.value) })}
        aria-label="Page vertical scroll"
        className="page-scroll-slider"
        style={{
          writingMode: "bt-lr",
          WebkitAppearance: "slider-vertical",
          appearance: "slider-vertical",
          width: 6, height: 220,
          accentColor: "var(--accent)",
        }} />
      <button type="button" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
        aria-label="Scroll to bottom"
        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 14, fontWeight: 800, padding: 2 }}>⇊</button>
    </div>
  );
}

function RefreshButton() {
  const [spinning, setSpinning] = useState(false);
  const handle = () => {
    if (spinning) return;
    setSpinning(true);
    // Give any listening page (e.g. dashboard) a chance to do a soft refresh
    // and render its own progress indicator; then force a full reload so the
    // action works uniformly on every route and role.
    window.dispatchEvent(new CustomEvent("app:refresh"));
    setTimeout(() => {
      if (typeof window !== "undefined") window.location.reload();
    }, 350);
  };
  return (
    <>
      <style>{`
        @keyframes refreshSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes refreshTopBar { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
      `}</style>
      <button onClick={handle} title="Refresh data" disabled={spinning}
        style={{ width: 34, height: 34, borderRadius: 10, background: spinning ? "rgba(96,165,250,0.18)" : "var(--bg3)", border: "1px solid rgba(96,165,250,0.25)", color: "var(--blue, #60a5fa)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: spinning ? "wait" : "pointer", flexShrink: 0 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          style={{ animation: spinning ? "refreshSpin 0.8s linear infinite" : "none" }}>
          <polyline points="23 4 23 10 17 10"/>
          <polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
      {spinning && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, background: "transparent", zIndex: 1200, overflow: "hidden", pointerEvents: "none" }}>
          <div style={{ height: "100%", width: "40%", background: "linear-gradient(90deg, transparent, var(--accent), var(--gold2), transparent)", animation: "refreshTopBar 1.1s linear infinite" }} />
        </div>
      )}
    </>
  );
}
