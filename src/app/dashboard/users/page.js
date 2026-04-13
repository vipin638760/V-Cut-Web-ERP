"use client";
import { useState } from "react";
import { useCurrentUser } from "@/lib/currentUser";
import UsersTab from "./tabs/UsersTab";
import ShopsTab from "./tabs/ShopsTab";
import FixedExpTab from "./tabs/FixedExpTab";
import ExpTypesTab from "./tabs/ExpTypesTab";
import CostCenterTab from "./tabs/CostCenterTab";
import SettingsTab from "./tabs/SettingsTab";
import ReviewsTab from "./tabs/ReviewsTab";

import { TabNav } from "@/components/ui";

export default function MasterSetupPage() {
  const [activeTab, setActiveTab] = useState("users");

  const currentUser = useCurrentUser() || {};
  const isAccountant = currentUser.role === "accountant";

  const allTabs = [
    { id: "users",      icon: "👤", label: "Users" },
    { id: "shops",      icon: "🏪", label: "Shops" },
    { id: "fixed",      icon: "📅", label: "Fixed Exp" },
    { id: "exptypes",   icon: "✏️", label: "Exp Types" },
    { id: "costcenter", icon: "🏢", label: "Cost Centers" },
    { id: "reviews",    icon: "⭐", label: "Reviews" },
    { id: "settings",   icon: "⚙️", label: "System Config" },
  ];

  const tabs = allTabs.filter(t => !(t.adminOnly && isAccountant));

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>System Configuration</div>
          <div style={{ fontSize: 28, fontWeight: 950, color: "var(--text)", letterSpacing: -1 }}>Master Setup</div>
        </div>
        <div style={{ background: "rgba(34,211,238,0.1)", padding: "10px 20px", borderRadius: 16, border: "1px solid var(--border)", fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>
           v3.1 Stable Release
        </div>
      </div>

      <TabNav tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Rendering Tab Content */}
      <div style={{ background: "transparent", minHeight: "60vh" }}>
        {activeTab === "users"      && <UsersTab />}
        {activeTab === "shops"      && <ShopsTab />}
        {activeTab === "fixed"      && <FixedExpTab />}
        {activeTab === "exptypes"   && <ExpTypesTab />}
        {activeTab === "costcenter" && <CostCenterTab />}
        {activeTab === "reviews"    && <ReviewsTab />}
        {activeTab === "settings"   && <SettingsTab />}
      </div>
    </div>
  );
}
