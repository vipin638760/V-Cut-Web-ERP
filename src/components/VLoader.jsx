"use client";

export default function VLoader({ fullscreen = true, label = "Loading", size = 1 }) {
  const scale = size;
  const wrap = fullscreen
    ? { position: "fixed", inset: 0, zIndex: 9999, background: "var(--bg1)" }
    : { position: "relative", width: "100%", minHeight: 240 };

  return (
    <div
      style={{
        ...wrap,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18 * scale,
        fontFamily: "var(--font-headline, var(--font-outfit))",
      }}
    >
      <div
        className="vloader-logo"
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "baseline",
          lineHeight: 1,
          fontSize: `${72 * scale}px`,
          letterSpacing: 2,
        }}
      >
        <span className="vloader-v" style={{ color: "var(--red)", fontFamily: "var(--font-vibes)", fontWeight: 400, fontSize: "1.4em" }}>V</span>
        <span className="vloader-cut" style={{ color: "var(--text)", fontFamily: "var(--font-vibes)", fontWeight: 400 }}>-Cut</span>
        <span className="vloader-ring" aria-hidden="true" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="vloader-dot" />
        <span className="vloader-dot" style={{ animationDelay: ".15s" }} />
        <span className="vloader-dot" style={{ animationDelay: ".3s" }} />
        <span
          style={{
            marginLeft: 6,
            fontSize: 11 * scale,
            fontWeight: 700,
            color: "var(--accent)",
            textTransform: "uppercase",
            letterSpacing: 3,
          }}
        >
          {label}
        </span>
      </div>

      <style>{`
        @keyframes vloader-pulse {
          0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(248,113,113,0)); }
          50%      { transform: scale(1.08); filter: drop-shadow(0 0 14px rgba(248,113,113,0.55)); }
        }
        @keyframes vloader-fade {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1; }
        }
        @keyframes vloader-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes vloader-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%           { transform: translateY(-6px); opacity: 1; }
        }
        .vloader-v {
          display: inline-block;
          transform-origin: 50% 70%;
          animation: vloader-pulse 1.4s ease-in-out infinite;
        }
        .vloader-cut {
          animation: vloader-fade 1.4s ease-in-out infinite;
        }
        .vloader-ring {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 1.55em;
          height: 1.55em;
          border-radius: 50%;
          border: 2px solid rgba(248,113,113,0.18);
          border-top-color: var(--red);
          transform: translate(-50%, -50%);
          animation: vloader-spin 1.1s linear infinite;
          pointer-events: none;
        }
        .vloader-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--accent);
          display: inline-block;
          animation: vloader-bounce 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
