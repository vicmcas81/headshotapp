// app/page.tsx — updated with Portraly.ai branding
import Link from "next/link";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh" }}>

      {/* ── Nav ── */}
      <nav style={{
        padding: "24px 40px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ fontFamily: "var(--font-display)", fontSize: 22, letterSpacing: 3, color: "var(--accent)" }}>
          PORTRALY.AI
        </span>
        <Link href="/upload" style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          letterSpacing: 2,
          color: "var(--text)",
          border: "1px solid var(--border)",
          padding: "10px 24px",
        }}>
          GET STARTED
        </Link>
      </nav>

      {/* ── Hero ── */}
      <section style={{ padding: "120px 40px 80px", maxWidth: 900, margin: "0 auto" }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--accent)", marginBottom: 32 }}>
          AI HEADSHOT STUDIO
        </p>
        <h1 style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(52px, 8vw, 96px)",
          fontWeight: 300,
          lineHeight: 1.0,
          letterSpacing: -1,
          marginBottom: 40,
        }}>
          Portrayed<br />
          <em style={{ color: "var(--accent)", fontStyle: "italic" }}>perfectly.</em>
        </h1>
        <p style={{
          fontSize: 20,
          fontWeight: 300,
          color: "var(--muted)",
          maxWidth: 480,
          marginBottom: 56,
          lineHeight: 1.7,
        }}>
          Upload a few selfies. Our AI learns your face and generates
          studio-quality professional headshots in minutes.
        </p>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Link href="/upload" style={{
            display: "inline-block",
            background: "var(--accent)",
            color: "#0a0a0a",
            padding: "18px 48px",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            letterSpacing: 2,
          }}>
            CREATE YOUR HEADSHOTS →
          </Link>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
            Free to try · $59 to keep
          </span>
        </div>
      </section>

      {/* ── Stats ── */}
      <div style={{
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        padding: "40px 40px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 32,
        maxWidth: 900,
        margin: "0 auto",
      }}>
        {[
          ["3", "photos needed"],
          ["3", "styles generated"],
          ["~15 min", "turnaround"],
          ["$0", "until you love them"],
        ].map(([num, label]) => (
          <div key={label}>
            <div style={{ fontSize: 36, fontWeight: 300, color: "var(--accent)", lineHeight: 1 }}>{num}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", letterSpacing: 1, marginTop: 8 }}>
              {label.toUpperCase()}
            </div>
          </div>
        ))}
      </div>

      {/* ── How it works ── */}
      <section style={{ padding: "100px 40px", maxWidth: 900, margin: "0 auto" }}>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 4, color: "var(--accent)", marginBottom: 48 }}>
          HOW IT WORKS
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 48 }}>
          {[
            { n: "01", title: "Upload photos", body: "Upload up to 3 clear photos of yourself from different angles." },
            { n: "02", title: "AI trains on you", body: "Flux LoRA learns your exact facial features in about 10 minutes on fal.ai." },
            { n: "03", title: "Headshots generated", body: "Professional headshots across corporate, business casual, and LinkedIn styles." },
            { n: "04", title: "Download & use", body: "View your results and download. Look great on LinkedIn, resumes, and more." },
          ].map(({ n, title, body }) => (
            <div key={n}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", letterSpacing: 2, marginBottom: 16 }}>{n}</div>
              <h3 style={{ fontWeight: 400, fontSize: 22, marginBottom: 12 }}>{title}</h3>
              <p style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1.8, fontFamily: "var(--font-mono)", fontWeight: 300 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ borderTop: "1px solid var(--border)", padding: "100px 40px", textAlign: "center" }}>
        <h2 style={{ fontWeight: 300, fontSize: "clamp(36px, 5vw, 64px)", marginBottom: 32 }}>
          Ready to be portrayed perfectly?
        </h2>
        <Link href="/upload" style={{
          display: "inline-block",
          background: "var(--accent)",
          color: "#0a0a0a",
          padding: "18px 64px",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          letterSpacing: 2,
        }}>
          GET STARTED FREE →
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer style={{
        borderTop: "1px solid var(--border)",
        padding: "32px 40px",
        display: "flex",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 16,
      }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", letterSpacing: 2 }}>
          PORTRALY.AI
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>
          Powered by fal.ai · Flux LoRA
        </span>
      </footer>

    </main>
  );
}
