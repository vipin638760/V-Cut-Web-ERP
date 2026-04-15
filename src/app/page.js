"use client";
import { useState, useEffect } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { DEFAULTS_USERS } from "@/lib/constants";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import VLoader from "@/components/VLoader";

export default function LoginPage() {
  const [selectedRole, setSelectedRole] = useState(null);
  const [uid, setUid] = useState("");
  const [pass, setPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [mounted, setMounted] = useState(false);
  const [remember, setRemember] = useState(true);
  const router = useRouter();

  // Remember map shape: { admin: { uid, ts }, accountant: { uid, ts }, employee: { uid, ts } }
  // Legacy shape { role, uid } is migrated to the new map on load.
  const readRememberMap = () => {
    try {
      const raw = localStorage.getItem("vcut_remember");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.role && parsed.uid) {
        // Legacy → migrate
        return { [parsed.role]: { uid: parsed.uid, ts: Date.now() } };
      }
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch { return {}; }
  };

  useEffect(() => {
    setMounted(true);
    const map = readRememberMap();
    // Pick the most recently used role
    let recent = null;
    for (const role of Object.keys(map)) {
      const v = map[role];
      if (!v?.uid) continue;
      if (!recent || (Number(v.ts) || 0) > recent.ts) recent = { role, uid: v.uid, ts: Number(v.ts) || 0 };
    }
    if (recent) {
      setSelectedRole(recent.role);
      setUid(recent.uid);
      setRemember(true);
    } else {
      setRemember(false);
    }
  }, []);

  const handleRoleSelect = (role) => {
    setSelectedRole(role);
    setErrorMsg("");
    // Pre-fill the uid field with whatever was last remembered for THIS role.
    const map = readRememberMap();
    setUid(map[role]?.uid || "");
    setPass("");
  };

  const doLogin = async (e) => {
    if (e) e.preventDefault();
    if (!uid || !pass) {
      setErrorMsg("Please enter both User ID and Password.");
      return;
    }
    setLoading(true);
    setErrorMsg("");

    let allUsers = [...DEFAULTS_USERS];
    try {
      if (db) {
        const snap = await getDocs(collection(db, "users"));
        snap.docs.forEach((d) => {
          const ud = d.data();
          const existingIdx = allUsers.findIndex((u) => u.id === d.id);
          if (existingIdx !== -1) allUsers[existingIdx] = { ...ud, id: d.id };
          else allUsers.push({ ...ud, id: d.id });
        });
      }
    } catch (err) {
      console.warn("Firebase user fetch failed (Using defaults):", err.message);
    }

    const uRole = selectedRole.toLowerCase().trim();
    const uId = uid.toLowerCase().trim();
    const uPass = pass.trim();

    const user = allUsers.find(
      (u) =>
        (u.id || "").toLowerCase().trim() === uId &&
        (u.password || "").trim() === uPass &&
        (u.role || "").toLowerCase().trim() === uRole
    );

    if (!user) {
      let msg = "Incorrect User ID or password";
      const dbUser = allUsers.find((u) => (u.id || "").toLowerCase().trim() === uId);
      if (dbUser) {
        if ((dbUser.password || "").trim() !== uPass) msg = "Incorrect password for " + dbUser.id;
        else if ((dbUser.role || "").toLowerCase().trim() !== uRole)
          msg = "Role mismatch (User as " + (dbUser.role || "none") + ")";
      } else {
        msg = "User not found (Checked " + allUsers.length + " local/DB entries)";
      }
      setErrorMsg(msg);
      setLoading(false);
      return;
    }

    if (remember) {
      localStorage.setItem("vcut_user", JSON.stringify(user));
      sessionStorage.removeItem("vcut_user");
      // Per-role remember map: merge this login's role entry into whatever was already stored.
      const map = readRememberMap();
      map[uRole] = { uid: uId, ts: Date.now() };
      localStorage.setItem("vcut_remember", JSON.stringify(map));
    } else {
      sessionStorage.setItem("vcut_user", JSON.stringify(user));
      localStorage.removeItem("vcut_user");
      // Clear only this role's remember entry; leave other roles' entries intact.
      const map = readRememberMap();
      if (map[uRole]) { delete map[uRole]; localStorage.setItem("vcut_remember", JSON.stringify(map)); }
    }
    router.push("/dashboard");
  };

  const ROLES = [
    { id: "admin",      icon: "checkCircle", label: "Admin" },
    { id: "accountant", icon: "wallet",      label: "Accountant" },
    { id: "employee",   icon: "users",       label: "Employee" },
  ];

  return (
    <div className="login-page min-h-screen flex flex-col md:flex-row" style={{ background: "#0e0e0e", color: "#fff" }}>
      {loading && <VLoader fullscreen label="Signing in" />}

      {/* ═══════════ LEFT: Cinematic Branding ═══════════ */}
      <section className="relative hidden md:flex md:w-1/2 lg:w-[58%] overflow-hidden">
        {/* Salon photograph */}
        <div className="absolute inset-0 z-0">
          <img
            src="/salon-bg.jpg"
            alt="Modern salon interior with dark walls and cyan neon accents"
            className="w-full h-full object-cover"
            style={{ filter: "grayscale(0.2) brightness(0.5)" }}
          />
          {/* Overlay gradients for text readability */}
          <div className="absolute inset-0" style={{ background: "linear-gradient(to right, rgba(14,14,14,0.75) 0%, transparent 50%, transparent 100%)" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(14,14,14,0.9) 0%, transparent 50%)" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, rgba(14,14,14,0.3) 0%, transparent 30%)" }} />
        </div>

        {/* Content overlay */}
        <div className="relative z-10 p-10 lg:p-16 flex flex-col justify-between h-full w-full">
          {/* Top: Brand */}
          <div>
            <div className="flex flex-col items-start gap-3 mb-4">
              <div className="flex items-baseline gap-1">
                <span style={{ color: "#f06464", fontFamily: "var(--font-vibes)", fontSize: "52px", fontWeight: 400, filter: "drop-shadow(0 0 12px rgba(240,100,100,0.5))" }}>V</span>
                <span style={{ color: "#fff", fontFamily: "var(--font-vibes)", fontSize: "42px", fontWeight: 400 }}>-Cut</span>
                <span style={{ fontFamily: "var(--font-headline)", fontSize: "14px", fontWeight: 600, letterSpacing: "4px", marginLeft: "8px", background: "linear-gradient(90deg, #50e1f9, #00bcd4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>SALON</span>
              </div>

              <div className="flex items-center gap-3 w-full">
                <div className="h-px flex-grow max-w-[40px]" style={{ background: "rgba(72,72,71,0.3)" }} />
                <p style={{ fontFamily: "var(--font-headline)", fontSize: "10px", letterSpacing: "0.4em", fontWeight: 500, color: "#adaaaa", textTransform: "uppercase" }}>Management Console</p>
                <div className="h-px flex-grow max-w-[120px]" style={{ background: "rgba(72,72,71,0.3)" }} />
              </div>

              <p style={{ fontFamily: "var(--font-headline)", fontSize: "11px", letterSpacing: "0.2em", color: "rgba(80,225,249,0.5)", fontStyle: "italic", textTransform: "uppercase", marginLeft: "56px" }}>Your Style, Our Expertise</p>
            </div>
          </div>

          {/* Bottom: Tagline */}
          <div className="max-w-md">
            <div className="w-12 h-1 mb-6" style={{ background: "#50e1f9" }} />
            <h2 style={{ fontFamily: "var(--font-headline)", fontSize: "38px", fontWeight: 700, lineHeight: 1.15, marginBottom: "16px", color: "#fff" }}>
              Precision in every pixel.
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: "16px", lineHeight: 1.7, color: "#adaaaa" }}>
              Experience the Digital Atelier&mdash;a high-performance workspace designed for the world&rsquo;s most elite stylists and managers.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════ RIGHT: Login Form ═══════════ */}
      <main className="flex-1 flex items-center justify-center p-6 md:p-12 lg:p-20 relative" style={{ background: "#0e0e0e" }}>
        {/* Subtle ambient glow */}
        {mounted && (
          <div className="absolute top-0 right-0 w-96 h-96 rounded-full pointer-events-none" style={{ background: "rgba(80,225,249,0.04)", filter: "blur(120px)" }} />
        )}

        <div className="w-full max-w-[400px] relative z-10">

          {/* Mobile Brand Header */}
          <div className="md:hidden flex flex-col items-center mb-10">
            <div className="flex items-baseline gap-1 mb-2">
              <span style={{ color: "#f06464", fontFamily: "var(--font-vibes)", fontSize: "40px", fontWeight: 400, filter: "drop-shadow(0 0 10px rgba(240,100,100,0.5))" }}>V</span>
              <span style={{ color: "#fff", fontFamily: "var(--font-vibes)", fontSize: "32px", fontWeight: 400 }}>-Cut</span>
              <span style={{ fontFamily: "var(--font-headline)", fontSize: "11px", fontWeight: 600, letterSpacing: "3px", marginLeft: "6px", background: "linear-gradient(90deg, #50e1f9, #00bcd4)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>SALON</span>
            </div>
            <div className="flex items-center gap-3 justify-center">
              <div className="h-px w-8" style={{ background: "rgba(72,72,71,0.3)" }} />
              <p style={{ fontFamily: "var(--font-headline)", fontSize: "9px", letterSpacing: "0.3em", color: "#adaaaa", textTransform: "uppercase" }}>Console</p>
              <div className="h-px w-8" style={{ background: "rgba(72,72,71,0.3)" }} />
            </div>
            <p style={{ fontFamily: "var(--font-headline)", fontSize: "9px", letterSpacing: "0.2em", color: "rgba(80,225,249,0.5)", fontStyle: "italic", textTransform: "uppercase", marginTop: "8px" }}>Your Style, Our Expertise</p>
          </div>

          {/* Welcome */}
          <header className="mb-10">
            <h2 style={{ fontFamily: "var(--font-headline)", fontSize: "30px", fontWeight: 700, letterSpacing: "-0.01em", color: "#fff", marginBottom: "8px" }}>Welcome Back</h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: "14px", color: "#adaaaa" }}>Select your role to access the workspace.</p>
          </header>

          {/* ── Role Selection Grid ── */}
          <div className="grid grid-cols-3 gap-3 mb-10">
            {ROLES.map((r) => {
              const active = selectedRole === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => handleRoleSelect(r.id)}
                  className="flex flex-col items-center justify-center p-4 rounded-xl transition-all duration-200 group cursor-pointer"
                  style={{
                    background: active ? "rgba(80,225,249,0.08)" : "#20201f",
                    border: active ? "1px solid rgba(80,225,249,0.4)" : "1px solid rgba(72,72,71,0.15)",
                    boxShadow: active ? "0 0 24px -4px rgba(80,225,249,0.2)" : "none",
                    transform: active ? "scale(1)" : undefined,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = "rgba(80,225,249,0.35)"; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = "rgba(72,72,71,0.15)"; }}
                >
                  <span className="mb-2.5 transition-colors duration-200" style={{ color: active ? "#50e1f9" : "#adaaaa" }}>
                    <Icon name={r.icon} size={24} />
                  </span>
                  <span style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: active ? "#fff" : "#adaaaa",
                    transition: "color 0.2s",
                  }}>{r.label}</span>
                </button>
              );
            })}
          </div>

          {/* ── Login Form ── */}
          {selectedRole && (
            <form onSubmit={doLogin} className="login-form-enter">
              <div className="mb-8">
                {/* User ID */}
                <div className="mb-4">
                  <label style={{ fontFamily: "var(--font-body)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#adaaaa", display: "block", marginBottom: "8px", paddingLeft: "4px" }}>User ID</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: "#adaaaa", opacity: 0.5 }}>
                      <Icon name="users" size={18} />
                    </span>
                    <input
                      type="text"
                      value={uid}
                      onChange={(e) => setUid(e.target.value)}
                      placeholder="Enter your ID"
                      autoComplete="username"
                      className="login-input"
                    />
                  </div>
                </div>

                {/* Password */}
                <div>
                  <div className="flex justify-between items-center mb-2 px-1">
                    <label style={{ fontFamily: "var(--font-body)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#adaaaa" }}>Password</label>
                    <button type="button" style={{ fontFamily: "var(--font-body)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(80,225,249,0.6)", background: "none", border: "none", cursor: "pointer", transition: "color 0.2s" }}
                      onMouseEnter={e => e.currentTarget.style.color = "#50e1f9"}
                      onMouseLeave={e => e.currentTarget.style.color = "rgba(80,225,249,0.6)"}
                    >Forgot?</button>
                  </div>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: "#adaaaa", opacity: 0.5 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                    <input
                      type="password"
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                      placeholder="&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;"
                      autoComplete="current-password"
                      className="login-input"
                    />
                  </div>
                </div>
              </div>

              {/* Remember checkbox */}
              <div className="flex items-center gap-3 mb-8 px-1">
                <input type="checkbox" id="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="cursor-pointer" style={{ width: 16, height: 16, borderRadius: 4, border: "1px solid #484847", background: "#1a1a1a", accentColor: "#50e1f9" }} />
                <label htmlFor="remember" className="cursor-pointer select-none" style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "#adaaaa" }}>Remember this device</label>
              </div>

              {/* Sign In Button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full relative overflow-hidden group cursor-pointer"
                style={{
                  padding: "16px",
                  borderRadius: "12px",
                  background: "linear-gradient(135deg, #50e1f9, #00bcd4)",
                  color: "#003840",
                  fontFamily: "var(--font-body)",
                  fontWeight: 700,
                  fontSize: "13px",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  border: "none",
                  boxShadow: "0 0 20px -4px rgba(80,225,249,0.25)",
                  transition: "all 0.2s",
                  opacity: loading ? 0.5 : 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 0 32px -4px rgba(80,225,249,0.4)"; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = "0 0 20px -4px rgba(80,225,249,0.25)"; }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                {loading ? (
                  <span className="inline-flex items-center gap-2.5 relative">
                    <span className="login-spinner w-4 h-4 border-2 border-[#003840]/30 border-t-[#003840] rounded-full inline-block" />
                    Signing in...
                  </span>
                ) : (
                  <span className="relative">Sign In</span>
                )}
              </button>

              {/* Error */}
              {errorMsg && (
                <div className="login-form-enter mt-5 flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl" style={{
                  background: "rgba(215,56,59,0.08)",
                  border: "1px solid rgba(215,56,59,0.12)",
                  fontFamily: "var(--font-body)",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#ff716c",
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {errorMsg}
                </div>
              )}
            </form>
          )}

          {/* Spacer when no role selected */}
          {!selectedRole && <div style={{ height: 200 }} />}

          {/* Footer */}
          <footer className="mt-12 pt-8 flex items-center justify-between" style={{ borderTop: "1px solid rgba(72,72,71,0.12)" }}>
            <div className="flex gap-6">
              <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#adaaaa", cursor: "pointer", transition: "color 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.color = "#fff"}
                onMouseLeave={e => e.currentTarget.style.color = "#adaaaa"}
              >Privacy</span>
              <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#adaaaa", cursor: "pointer", transition: "color 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.color = "#fff"}
                onMouseLeave={e => e.currentTarget.style.color = "#adaaaa"}
              >Support</span>
            </div>
            <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", color: "rgba(173,170,170,0.4)" }}>v2.4.0</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
