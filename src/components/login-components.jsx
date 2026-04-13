"use client";
import { useState, useEffect, useRef } from "react";
import { Icon } from "./ui";

/* ── Brand Header ── */
export function BrandHeader() {
  return (
    <div className="text-center mb-12 relative z-10">
      {/* Floating scissors icon */}
      <div className="relative inline-block mb-6">
        <div className="w-20 h-20 rounded-[22px] bg-gradient-to-br from-[var(--accent)] via-[var(--gold2)] to-[var(--accent)] flex items-center justify-center shadow-[0_12px_40px_rgba(34,211,238,0.35)] relative overflow-hidden">
          <span className="text-black text-3xl relative z-10">&#x2702;</span>
          <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-white/10" />
        </div>
        {/* Glow ring */}
        <div className="absolute -inset-3 rounded-[28px] bg-gradient-to-br from-[var(--accent)] to-[var(--gold2)] opacity-15 blur-xl -z-10" />
      </div>

      <h1 className="text-[42px] font-extrabold tracking-[3px] flex items-baseline justify-center gap-1 mb-3">
        <span className="brand-v font-normal">V</span>
        <span className="brand-cut">-Cut</span>
        <span className="brand-group text-[22px] ml-2 opacity-90 font-black tracking-[6px]">SALON</span>
      </h1>

      <div className="flex items-center justify-center gap-4 mt-4">
        <div className="h-px w-16 bg-gradient-to-r from-transparent to-[var(--accent)] opacity-20" />
        <p className="text-[9px] text-[var(--text3)] tracking-[5px] uppercase font-bold opacity-40">
          Management Console
        </p>
        <div className="h-px w-16 bg-gradient-to-l from-transparent to-[var(--accent)] opacity-20" />
      </div>
    </div>
  );
}

/* ── Role Card ── */
export function RoleCard({ id, icon, name, desc, isSelected, onClick }) {
  return (
    <button
      onClick={() => onClick(id)}
      className="cursor-pointer text-left w-full transition-all duration-300 relative group"
    >
      <div
        className={`p-4 rounded-2xl transition-all duration-300 relative overflow-hidden border ${
          isSelected
            ? "bg-gradient-to-r from-[rgba(34,211,238,0.1)] to-[rgba(8,145,178,0.04)] border-[var(--accent)] shadow-[0_0_30px_rgba(34,211,238,0.08)]"
            : "bg-[rgba(255,255,255,0.02)] border-[var(--border)] hover:border-[var(--border2)] hover:bg-[rgba(255,255,255,0.04)]"
        }`}
      >
        <div className="flex items-center gap-4">
          {/* Icon */}
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
              isSelected
                ? "bg-gradient-to-br from-[var(--accent)] to-[var(--gold2)] text-black shadow-[0_6px_16px_rgba(34,211,238,0.25)]"
                : "bg-[var(--bg4)] text-[var(--text3)] group-hover:text-[var(--accent)] group-hover:bg-[rgba(34,211,238,0.06)]"
            }`}
          >
            {icon}
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0">
            <div
              className={`text-[13px] font-extrabold tracking-[1px] uppercase transition-colors duration-200 ${
                isSelected ? "text-[var(--text)]" : "text-[var(--text)] opacity-80"
              }`}
            >
              {name}
            </div>
            <div className={`text-[10px] mt-0.5 truncate transition-colors duration-200 ${
              isSelected ? "text-[var(--accent)] opacity-70" : "text-[var(--text3)] opacity-50"
            }`}>
              {desc}
            </div>
          </div>

          {/* Selection indicator */}
          <div
            className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 ${
              isSelected
                ? "bg-[var(--accent)] shadow-[0_0_12px_rgba(34,211,238,0.4)]"
                : "border-2 border-[var(--border2)] group-hover:border-[var(--text3)]"
            }`}
          >
            {isSelected && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

/* ── Login Form ── */
export function LoginForm({ selectedRole, getRoleTitle, getRoleSubtitle, uid, setUid, pass, setPass, loading, errorMsg, onSubmit }) {
  const inputRef = useRef(null);
  const [showPass, setShowPass] = useState(false);

  useEffect(() => {
    if (inputRef.current) {
      setTimeout(() => inputRef.current.focus(), 300);
    }
  }, [selectedRole]);

  return (
    <form onSubmit={onSubmit} className="w-full login-form-enter relative z-10">
      <div className="mb-7">
        <h3 className="text-[18px] font-extrabold mb-1.5 text-[var(--text)] tracking-wide">
          {getRoleTitle(selectedRole)}
        </h3>
        <p className="text-[11px] text-[var(--text3)] opacity-50 font-medium">
          {getRoleSubtitle(selectedRole)}
        </p>
      </div>

      <div className="space-y-4">
        {/* User ID */}
        <div className="relative group">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text3)] opacity-30 transition-all duration-200 group-focus-within:opacity-80 group-focus-within:text-[var(--accent)]">
            <Icon name="users" size={16} />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder="User ID"
            autoComplete="username"
            className="w-full py-3.5 pl-12 pr-4 border border-[var(--border)] rounded-2xl text-[13px] bg-[rgba(255,255,255,0.02)] text-[var(--text)] font-semibold transition-all duration-200 focus:outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_rgba(34,211,238,0.06)] focus:bg-[rgba(34,211,238,0.02)] placeholder:text-[var(--text3)] placeholder:opacity-30 placeholder:font-medium"
          />
        </div>

        {/* Password */}
        <div className="relative group">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text3)] opacity-30 transition-all duration-200 group-focus-within:opacity-80 group-focus-within:text-[var(--accent)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <input
            type={showPass ? "text" : "password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="w-full py-3.5 pl-12 pr-12 border border-[var(--border)] rounded-2xl text-[13px] bg-[rgba(255,255,255,0.02)] text-[var(--text)] font-semibold transition-all duration-200 focus:outline-none focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_rgba(34,211,238,0.06)] focus:bg-[rgba(34,211,238,0.02)] placeholder:text-[var(--text3)] placeholder:opacity-30 placeholder:font-medium"
          />
          {/* Toggle password visibility */}
          <button
            type="button"
            onClick={() => setShowPass(!showPass)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text3)] opacity-30 hover:opacity-70 transition-opacity cursor-pointer"
          >
            {showPass ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>
      </div>

      {/* Sign In Button */}
      <button
        type="submit"
        disabled={loading}
        className="w-full py-4 bg-gradient-to-r from-[var(--accent)] to-[var(--gold2)] text-black border-none rounded-2xl text-[12px] font-black cursor-pointer tracking-[2px] uppercase transition-all duration-300 mt-7 shadow-[0_8px_30px_rgba(34,211,238,0.2)] hover:shadow-[0_12px_40px_rgba(34,211,238,0.35)] hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed relative overflow-hidden group"
      >
        {/* Shine sweep */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
        {loading ? (
          <span className="inline-flex items-center gap-2.5 relative">
            <span className="login-spinner w-4 h-4 border-2 border-black/20 border-t-black rounded-full inline-block" />
            Authenticating...
          </span>
        ) : (
          <span className="relative">Sign In</span>
        )}
      </button>

      {/* Error message */}
      {errorMsg && (
        <div className="text-[11px] text-[var(--red)] text-center mt-5 bg-[var(--red-bg)] py-3 px-4 rounded-2xl border border-[rgba(248,113,113,0.1)] font-semibold login-form-enter flex items-center justify-center gap-2.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {errorMsg}
        </div>
      )}
    </form>
  );
}

/* ── Ambient Background ── */
export function AmbientBackground() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden select-none z-0">
      {/* Large gradient orbs */}
      <div className="absolute top-[-20%] right-[-10%] w-[700px] h-[700px] bg-[rgba(34,211,238,0.04)] rounded-full blur-[140px] animate-float" />
      <div className="absolute bottom-[-20%] left-[-10%] w-[600px] h-[600px] bg-[rgba(8,145,178,0.035)] rounded-full blur-[130px] animate-float" style={{ animationDelay: "7s" }} />
      <div className="absolute top-[30%] left-[60%] w-[400px] h-[400px] bg-[rgba(240,100,100,0.02)] rounded-full blur-[120px] animate-float" style={{ animationDelay: "4s" }} />

      {/* Dot grid */}
      <div className="absolute inset-0 opacity-[0.02]" style={{
        backgroundImage: "radial-gradient(circle, var(--accent) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }} />

      {/* Noise */}
      <div className="absolute inset-0 opacity-[0.015]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
      }} />

      {/* Radial vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,2,2,0.5)_100%)]" />
    </div>
  );
}
