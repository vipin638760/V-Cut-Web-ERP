"use client";
import { useState, useEffect } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon, Card, useConfirm } from "@/components/ui";
import VLoader from "@/components/VLoader";


export default function SettingsTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // Settings Data
  const [gstPct, setGstPct] = useState("5");
  const [isCustom, setIsCustom] = useState(false);
  const [rates, setRates] = useState({
    mens_inc: 10,
    unisex_inc: 10,
    mens_leaves: 2,
    unisex_leaves: 3
  });

  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(doc(db, "settings", "global"), (sn) => {
      if (sn.exists()) {
        const data = sn.data();
        const g = data.gst_pct || 5;
        if (![5, 12, 18, 28].includes(Number(g))) {
          setIsCustom(true);
        } else {
          setIsCustom(false);
        }
        setGstPct(g.toString());
        setRates({
          mens_inc: data.mens_inc || 10,
          unisex_inc: data.unisex_inc || 10,
          mens_leaves: data.mens_leaves || 2,
          unisex_leaves: data.unisex_leaves || 3
        });
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await setDoc(doc(db, "settings", "global"), {
        gst_pct: Number(gstPct) || 0,
        ...rates,
        updated_at: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      confirm({ title: "Error", message: "Error committing system configuration: " + err.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    }
    setSaving(false);
  };

  if (loading) return <VLoader fullscreen label="Syncing system protocols" />;

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out", display: "flex", flexDirection: "column", gap: 32 }}>
       {/* Configuration Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 24 }}>
        <div>
           <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ background: "rgba(34,211,238,0.1)", padding: 8, borderRadius: 10 }}>
                 <Icon name="gear" size={18} color="var(--accent)" />
              </div>
              <h3 style={{ fontSize: 22, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>Global Configuration</h3>
           </div>
           <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500 }}>Manage network-wide protocols, taxation rates, and workforce parameters.</p>
        </div>
      </div>

      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        
        {/* Taxation Control */}
        <Card style={{ padding: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            <div style={{ background: "rgba(255,215,0,0.1)", padding: 10, borderRadius: 12 }}>
              <Icon name="trending" size={20} color="var(--gold)" />
            </div>
            <h4 style={{ fontSize: 14, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5 }}>Fiscal Extraction Protocols (GST)</h4>
          </div>
          
          <div style={{ maxWidth: 600 }}>
            <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 20, lineHeight: 1.6 }}>Define the global tax percentage applied to all service transactions. This value is used for back-calculating net revenue across all nodes.</p>
            
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <select
                value={isCustom ? "custom" : gstPct}
                onChange={(e) => {
                  if (e.target.value === "custom") {
                    setIsCustom(true);
                    setGstPct("");
                  } else {
                    setIsCustom(false);
                    setGstPct(e.target.value);
                  }
                }}
                style={{ ...inputStyle, width: 200, appearance: "none", borderColor: isCustom ? "var(--border2)" : "var(--gold)" }}
              >
                <option value="5">5% (Default Tier)</option>
                <option value="12">12% Tier</option>
                <option value="18">18% Tier</option>
                <option value="28">28% Tier</option>
                <option value="custom">Define Custom Node...</option>
              </select>
              
              {isCustom && (
                <div style={{ position: "relative", flex: 1 }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Custom Entry %"
                    value={gstPct}
                    onChange={(e) => setGstPct(e.target.value)}
                    style={{ ...inputStyle, border: "1px solid var(--gold)", background: "rgba(255,215,0,0.03)", color: "var(--gold)", fontWeight: 800 }}
                  />
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Division Rules */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
          {/* Mens Division */}
          <Card style={{ padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
               <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }}></div>
               <h4 style={{ fontSize: 14, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5 }}>Mens Division Rules</h4>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Incentive Multiplier (%)</label>
                <input type="number" value={rates.mens_inc} onChange={e => setRates({...rates, mens_inc: Number(e.target.value)})} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Provisioned Monthly Leaves</label>
                <input type="number" value={rates.mens_leaves} onChange={e => setRates({...rates, mens_leaves: Number(e.target.value)})} style={inputStyle} />
              </div>
            </div>
          </Card>

          {/* Unisex Division */}
          <Card style={{ padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
               <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--gold)" }}></div>
               <h4 style={{ fontSize: 14, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5 }}>Unisex Division Rules</h4>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Incentive Multiplier (%)</label>
                <input type="number" value={rates.unisex_inc} onChange={e => setRates({...rates, unisex_inc: Number(e.target.value)})} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Provisioned Monthly Leaves</label>
                <input type="number" value={rates.unisex_leaves} onChange={e => setRates({...rates, unisex_leaves: Number(e.target.value)})} style={inputStyle} />
              </div>
            </div>
          </Card>
        </div>

        <button type="submit" disabled={saving} style={{ alignSelf: "flex-end", padding: "18px 48px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", cursor: saving ? "not-allowed" : "pointer", fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.5, boxShadow: "0 10px 30px -10px rgba(34,211,238,0.5)", display: "flex", alignItems: "center", gap: 12, transition: "all 0.2s" }}>
          <Icon name="save" size={18} /> {saving ? "Committing..." : "Commit Configuration"}
        </button>
      </form>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
    </div>
  );
}
