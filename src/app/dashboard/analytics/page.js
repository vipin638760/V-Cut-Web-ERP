"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, Icon } from "@/components/ui";

// Catalogue of analytical reports surfaced from this hub. `href` points to an
// existing page that already covers the topic; `stub: true` marks reports
// whose backing data isn't tracked yet (booking, feedback, marketing,
// peak-time aren't part of the schema). Stubs render with a "Coming soon"
// badge instead of a link.
const REPORTS = [
  {
    id: "customer",
    title: "Customer Analysis",
    desc: "Frequency, preferences, retention, and loyalty across the customer base.",
    icon: "users",
    color: "var(--accent)",
    href: "/dashboard/customers",
  },
  {
    id: "appointment",
    title: "Appointment Analysis",
    desc: "Booking trends, peak hours, cancellations, and no-shows.",
    icon: "edit",
    color: "var(--blue, #60a5fa)",
    stub: true,
  },
  {
    id: "service",
    title: "Service Performance",
    desc: "Demand, popularity, and profitability of salon services.",
    icon: "grid",
    color: "var(--accent)",
    href: "/dashboard/menu-config",
  },
  {
    id: "staff",
    title: "Staff Performance",
    desc: "Employee productivity, billing efficiency, and ranking.",
    icon: "trending",
    color: "var(--gold)",
    href: "/dashboard/leaderboard",
  },
  {
    id: "revenue",
    title: "Revenue Analysis",
    desc: "Income by service, staff, date, or branch.",
    icon: "wallet",
    color: "var(--green)",
    href: "/dashboard/branches?view=summary",
  },
  {
    id: "sales",
    title: "Sales Analysis",
    desc: "Daily, weekly, and monthly sales trends.",
    icon: "trending",
    color: "var(--green)",
    href: "/dashboard",
  },
  {
    id: "inventory",
    title: "Inventory Usage",
    desc: "Product consumption, wastage, and stock turnover.",
    icon: "wallet",
    color: "var(--orange)",
    href: "/dashboard/materials",
  },
  {
    id: "pl",
    title: "Profit & Loss Analysis",
    desc: "Operating costs vs revenue to assess profitability.",
    icon: "pie",
    color: "var(--green)",
    href: "/dashboard/pl",
  },
  {
    id: "feedback",
    title: "Customer Feedback",
    desc: "Customer satisfaction through ratings and reviews.",
    icon: "checkCircle",
    color: "var(--blue, #60a5fa)",
    stub: true,
  },
  {
    id: "marketing",
    title: "Marketing Campaign",
    desc: "Effectiveness of offers, discounts, and promotions.",
    icon: "trending",
    color: "var(--purple, #c084fc)",
    stub: true,
  },
  {
    id: "loyalty",
    title: "Membership & Loyalty",
    desc: "Membership usage and repeat customer behaviour.",
    icon: "users",
    color: "var(--gold)",
    href: "/dashboard/customers",
  },
  {
    id: "peak",
    title: "Peak Time Analysis",
    desc: "Busiest days and hours for better scheduling.",
    icon: "edit",
    color: "var(--orange)",
    stub: true,
  },
];

export default function AnalyticsHub() {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return REPORTS;
    return REPORTS.filter(r => r.title.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q));
  }, [search]);

  const liveCount = REPORTS.filter(r => !r.stub).length;
  const stubCount = REPORTS.length - liveCount;

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Insights</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Analytics</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>
          {liveCount} live · {stubCount} planned · pick a report below
        </div>
      </div>

      <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", display: "inline-flex", pointerEvents: "none" }}>
            <Icon name="search" size={14} />
          </span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search reports..."
            style={{ width: "100%", padding: "10px 36px 10px 36px", borderRadius: 10, background: "var(--bg3)", border: `1px solid ${search ? "var(--accent)" : "var(--border)"}`, color: "var(--text)", fontSize: 12, fontWeight: 600, outline: "none" }}
          />
          {search && (
            <button onClick={() => setSearch("")} title="Clear"
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "var(--bg4)", border: "none", borderRadius: 6, width: 22, height: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text3)", fontSize: 13 }}>×</button>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {filtered.map(r => (
          <ReportCard key={r.id} report={r} />
        ))}
        {filtered.length === 0 && (
          <Card style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>
            No reports match &ldquo;{search}&rdquo;.
          </Card>
        )}
      </div>

      <div style={{ marginTop: 24, padding: "14px 18px", borderRadius: 12, border: "1px dashed var(--border2)", color: "var(--text3)", fontSize: 11, lineHeight: 1.5 }}>
        <strong style={{ color: "var(--text2)" }}>Note:</strong> Stub reports are planned views that need either new data capture (bookings, ratings, campaigns) or a dedicated builder. Live reports route to the existing page that already covers the topic.
      </div>
    </div>
  );
}

function ReportCard({ report }) {
  const { title, desc, icon, color, href, stub } = report;
  const inner = (
    <Card style={{
      padding: 18,
      height: "100%",
      transition: "transform 0.15s ease, box-shadow 0.15s ease",
      cursor: stub ? "default" : "pointer",
      opacity: stub ? 0.78 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: `${color}1f`,
          border: `1px solid ${color}55`,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color,
        }}>
          <Icon name={icon} size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", letterSpacing: 0.2 }}>{title}</div>
            {stub ? (
              <span style={{ fontSize: 9, fontWeight: 800, color: "var(--orange)", background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.3)", padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 1 }}>Soon</span>
            ) : (
              <span style={{ fontSize: 9, fontWeight: 800, color: "var(--green)", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.3)", padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 1 }}>Live</span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text3)", lineHeight: 1.5 }}>{desc}</div>
          {!stub && (
            <div style={{ marginTop: 10, fontSize: 10, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: 1, display: "inline-flex", alignItems: "center", gap: 4 }}>
              Open report →
            </div>
          )}
        </div>
      </div>
    </Card>
  );
  if (stub) {
    return (
      <div title="Coming soon — backing data not tracked yet">{inner}</div>
    );
  }
  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      {inner}
    </Link>
  );
}
