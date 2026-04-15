"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { staffBillingInPeriod, makeFilterPrefix, INR } from "@/lib/calculations";
import { Card, PeriodWidget, TH, TD } from "@/components/ui";
import VLoader from "@/components/VLoader";


const NOW = new Date();

export default function LeaderboardPage() {
  const [branches, setBranches] = useState([]);
  const [staff, setStaff]       = useState([]);
  const [entries, setEntries]   = useState([]);
  const [loading, setLoading]   = useState(true);

  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);

  // Calculate stats
  const staffData = staff
    .map(s => {
      const sale = staffBillingInPeriod(s.id, entries, filterPrefix, "month", filterYear);
      const tgt = s.target || 50000;
      const b = branches.find(x => x.id === s.branch_id);
      return { s, b, sale, tgt, pct: Math.min(Math.round(sale / tgt * 100), 100) };
    })
    .sort((a, b) => b.sale - a.sale);

  if (loading) return <VLoader fullscreen label="Loading Leaderboard" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, color: "var(--gold)", letterSpacing: 1, textTransform: "uppercase" }}>Leaderboard</h1>
          <p style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Compare overall staff performance against monthly targets.</p>
        </div>
        <PeriodWidget
          filterMode="month" setFilterMode={() => {}}
          filterYear={filterYear} setFilterYear={setFilterYear}
          filterMonth={filterMonth} setFilterMonth={setFilterMonth}
          monthlyOnly={true}
        />
      </div>

      <Card style={{ padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr>
              <TH>Rank</TH>
              <TH>Staff Name</TH>
              <TH>Branch</TH>
              <TH right>Performance</TH>
              <TH right>Target</TH>
            </tr>
          </thead>
          <tbody>
            {staffData.map(({ s, b, sale, tgt, pct }, index) => {
              const rank = index + 1;
              const isTop3 = rank <= 3;
              const medals = ["🥇", "🥈", "🥉"];
              const rankDisplay = isTop3 ? <span style={{ fontSize: 20, filter: "drop-shadow(0 0 4px rgba(255,215,0,0.5))" }}>{medals[rank-1]}</span> : <span style={{ fontSize: 14, fontWeight: 900, color: "var(--text3)" }}>#{rank}</span>;

              return (
                <tr key={s.id} style={{ background: index % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                  <TD style={{ textAlign: "center", width: 60 }}>{rankDisplay}</TD>
                  <TD style={{ fontWeight: isTop3 ? 800 : 600, color: isTop3 ? "var(--gold)" : "var(--text)" }}>{s.name}</TD>
                  <TD style={{ fontSize: 11, color: "var(--text2)", textTransform: "uppercase" }}>{b?.name?.replace('V-CUT ', '') || "—"}</TD>
                  <TD right>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                      <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700 }}>{INR(sale)}</span>
                      <div style={{ height: 6, width: 80, background: "var(--border2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 4, width: `${pct}%`, background: pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--gold)" : "var(--blue)", transition: "width 0.5s ease" }} />
                      </div>
                    </div>
                  </TD>
                  <TD right style={{ fontWeight: 800, color: pct >= 100 ? "var(--green)" : "var(--text)" }}>{pct}%</TD>
                </tr>
              );
            })}
            {staffData.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 40, textAlign: "center", color: "var(--text3)" }}>No performance data available yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
