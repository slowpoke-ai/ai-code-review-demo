import ReviewDashboard from "./components/ReviewDashboard";

export default function App() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* Top nav */}
      <header style={{
        borderBottom: "1px solid var(--border)",
        padding: "0 24px",
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "var(--bg2)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="var(--purple-light)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text)" }}>
          AI Review Gate
        </span>
        <span style={{
          marginLeft: 4, fontSize: 11, padding: "2px 8px",
          background: "var(--purple-bg)", color: "var(--purple-light)",
          border: "1px solid #4c1d95", borderRadius: 20, fontWeight: 500,
        }}>
          powered by Claude
        </span>
        <div style={{ flex: 1 }} />
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--text2)", textDecoration: "none", fontSize: 13 }}
        >
          GitHub ↗
        </a>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
        <ReviewDashboard />
      </main>
    </div>
  );
}