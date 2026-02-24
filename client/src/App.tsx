import { useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.min.mjs";

const API_BASE = "http://localhost:8789";

// =============================
// Types
// =============================
type FlightData = {
  type: "flight";
  passengerName: string | null;
  bookingReference: string | null;
  ticketNumber: string | null;
  tripType: "one_way" | "round_trip" | null;
  overallFrom: string | null;
  overallTo: string | null;
  departureDate: string | null;
  returnDate: string | null;
  currency: string | null;
  totalPrice: number | null;
};

type HotelData = {
  type: "hotel";
  guestName: string | null;
  hotelName: string | null;
  receiptNumber: string | null;
  hotelCity: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  currency: string | null;
  totalPrice: number | null;
};

type ExtractResult = FlightData | HotelData;

// =============================
// Helpers
// =============================
function formatMoney(currency: string | null, price: number | null) {
  if (price == null) return "—";
  if (!currency) return `${price}`;
  return `${price} ${currency}`;
}

// =============================
// Component
// =============================
export default function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [fileMeta, setFileMeta] = useState<{ name: string; pages?: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // =============================
  // Backend calls
  // =============================
  async function callTextExtraction(text: string, source_file: string) {
    const r = await fetch(`${API_BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source_file }),
    });

    const textBody = await r.text().catch(() => "");
    let data: any = null;
    try {
      data = textBody ? JSON.parse(textBody) : null;
    } catch {
      data = null;
    }

    if (!r.ok) {
      throw new Error(data?.error ?? `HTTP ${r.status} ${r.statusText}`);
    }

    if (!data?.ok) {
      throw new Error(data?.error ?? "Extraction failed");
    }

    if (!data.data?.type || !["flight", "hotel"].includes(data.data.type)) {
      throw new Error("Backend returned invalid data (missing type)");
    }

    return data.data as ExtractResult;
  }

  async function callFileOcrExtraction(file: File) {
    const form = new FormData();
    form.append("file", file);

    const r = await fetch(`${API_BASE}/api/extract-file`, {
      method: "POST",
      body: form,
    });

    const textBody = await r.text().catch(() => "");
    let data: any = null;
    try {
      data = textBody ? JSON.parse(textBody) : null;
    } catch {
      data = null;
    }

    if (!r.ok) {
      throw new Error(data?.error ?? `HTTP ${r.status} ${r.statusText}`);
    }

    if (!data?.ok) {
      throw new Error(data?.error ?? "OCR extraction failed");
    }

    if (!data.data?.type || !["flight", "hotel"].includes(data.data.type)) {
      throw new Error("Backend returned invalid data (missing type)");
    }

    return data.data as ExtractResult;
  }

  // =============================
  // File handler
  // =============================
  const onPickFile = async (file: File) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setFileMeta(null);

    try {
      // ---------- PDF ----------
      if (file.type === "application/pdf") {
        const buf = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items
            .map((it: any) => ("str" in it ? it.str : ""))
            .join(" ");
          text += "\n\n";
        }

        const normalized = text
          .replace(/\u00A0/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        setFileMeta({ name: file.name, pages: pdf.numPages });

        if (normalized.length >= 40) {
          const res = await callTextExtraction(normalized, file.name);
          setResult(res);
          return;
        }

        // fallback → OCR pages (try first N pages, stop on success)
        const pagesToTry = Math.min(3, pdf.numPages);
        for (let i = 1; i <= pagesToTry; i++) {
          try {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Canvas unsupported");

            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);

            const renderTask: any = page.render({ canvasContext: ctx, canvas: canvas, viewport });
            if (renderTask && renderTask.promise) {
              await renderTask.promise;
            } else {
              await renderTask;
            }

            const blob = await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png")
            );

            const pageFileName = `${file.name || "document"}.page-${i}.png`;
            const img = new File([blob], pageFileName, { type: "image/png" });

            try {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
            } catch {}
            canvas.width = 0;
            canvas.height = 0;

            const res = await callFileOcrExtraction(img);
            setResult(res);
            return;
          } catch (err: any) {
            setError((prev) => prev ?? (err?.message || String(err)));
            // continue to try next page
          }
        }

        throw new Error(error ?? "OCR fallback failed for the first pages.");
      }

      // ---------- IMAGE ----------
      if (file.type.startsWith("image/")) {
        setFileMeta({ name: file.name });
        const res = await callFileOcrExtraction(file);
        setResult(res);
        return;
      }

      throw new Error("Please upload a PDF or image.");
    } catch (e: any) {
      setError(e.message ?? "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  const triggerFilePicker = () => {
    if (inputRef.current && !loading) {
      inputRef.current.click();
    }
  };

  const clearAll = () => {
    setError(null);
    setResult(null);
    setFileMeta(null);
    setLoading(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const downloadResult = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileMeta?.name ?? "extracted"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // =============================
  // Render helpers
  // =============================
  const renderFlight = (f: FlightData) => (
    <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "1fr 1fr", fontSize: "15px" }}>
      <div><b style={{color: "#64748b"}}>Passenger:</b><br/> {f.passengerName ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Booking Ref:</b><br/> {f.bookingReference ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Ticket:</b><br/> {f.ticketNumber ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Trip Type:</b><br/> {f.tripType ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>From:</b><br/> {f.overallFrom ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>To:</b><br/> {f.overallTo ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Departure:</b><br/> {f.departureDate ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Return:</b><br/> {f.returnDate ?? "—"}</div>
      <div style={{ gridColumn: "1 / -1", marginTop: "8px", paddingTop: "12px", borderTop: "1px solid #e2e8f0", fontSize: "18px" }}>
        <b style={{color: "#0f172a"}}>Total:</b> {formatMoney(f.currency, f.totalPrice)}
      </div>
    </div>
  );

  const renderHotel = (h: HotelData) => (
    <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "1fr 1fr", fontSize: "15px" }}>
      <div><b style={{color: "#64748b"}}>Guest:</b><br/> {h.guestName ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Hotel:</b><br/> {h.hotelName ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Receipt:</b><br/> {h.receiptNumber ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>City:</b><br/> {h.hotelCity ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Check In:</b><br/> {h.checkInDate ?? "—"}</div>
      <div><b style={{color: "#64748b"}}>Check Out:</b><br/> {h.checkOutDate ?? "—"}</div>
      <div style={{ gridColumn: "1 / -1", marginTop: "8px", paddingTop: "12px", borderTop: "1px solid #e2e8f0", fontSize: "18px" }}>
        <b style={{color: "#0f172a"}}>Total:</b> {formatMoney(h.currency, h.totalPrice)}
      </div>
    </div>
  );

  const display = useMemo(() => {
    if (!result) return null;
    return result.type === "flight"
      ? { title: "✈️ Flight Details", content: renderFlight(result as FlightData) }
      : { title: "🏨 Hotel Details", content: renderHotel(result as HotelData) };
  }, [result]);

  // =============================
  // Layout styles
  // =============================
  const wrapperStyle: React.CSSProperties = {
    minHeight: "100vh",
    width: "100vw",
    background: "linear-gradient(135deg, #f0f4f8 0%, #e2e8f0 100%)",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "60px 20px",
    boxSizing: "border-box",
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    color: "#0f172a",
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 1000,
    margin: "0 auto",
    padding: "40px",
    boxSizing: "border-box",
    background: "#ffffff",
    borderRadius: "20px",
    boxShadow: "0 20px 40px -10px rgba(0,0,0,0.08), 0 10px 15px -3px rgba(0,0,0,0.04)",
  };

  const dropzoneStyle: React.CSSProperties = {
    border: "2px dashed #cbd5e1",
    borderRadius: "12px",
    padding: "40px 24px",
    textAlign: "center",
    background: "#f8fafc",
    marginTop: "24px",
    marginBottom: "24px",
  };

  const primaryButton: React.CSSProperties = {
    background: "#7c3aed",
    color: "white",
    fontWeight: 600,
    border: "none",
    padding: "10px 20px",
    borderRadius: "8px",
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.7 : 1,
    boxShadow: "0 4px 6px -1px rgba(124, 58, 237, 0.3)",
    marginRight: 12,
    fontSize: "14px",
    transition: "all 0.2s ease"
  };

  const secondaryButton: React.CSSProperties = {
    background: "white",
    color: "#334155",
    fontWeight: 600,
    border: "1px solid #cbd5e1",
    padding: "9px 16px",
    borderRadius: "8px",
    cursor: (loading && !result && !error) ? "not-allowed" : "pointer",
    opacity: (loading && !result && !error) ? 0.6 : 1,
    fontSize: "14px",
    transition: "all 0.2s ease"
  };

  const graySmall: React.CSSProperties = { 
    color: "#64748b", 
    fontSize: 14, 
    marginTop: 16,
    display: "block"
  };

  return (
    <div style={wrapperStyle}>
      <div style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: "40px", fontWeight: 700, textAlign: "center" ,}}>Travel Receipt Parser</h1>
        <p style={{ marginTop: 8, marginBottom: 0, color: "#64748b", fontSize: "16px", lineHeight: "1.5" }}>
          Upload a PDF or image of your hotel or flight receipt to extract your booking details.
        </p>

        <div style={dropzoneStyle}>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/*"
            style={{ display: "none" }}
            disabled={loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(f);
              if (e.currentTarget) e.currentTarget.value = "";
            }}
          />

          <div style={{ marginBottom: 4 }}>
            <button style={primaryButton} onClick={triggerFilePicker} disabled={loading}>
              {loading ? "Processing Document…" : "Choose File"}
            </button>
            <button
              style={secondaryButton}
              onClick={clearAll}
              disabled={loading && !result && !error}
              title="Clear results and selected file"
            >
              Clear
            </button>
            {result && (
              <button
                style={{ ...secondaryButton, marginLeft: 12 }}
                onClick={downloadResult}
                title="Download extracted data as JSON"
              >
                Download JSON
              </button>
            )}
          </div>

          <div style={graySmall}>
            {fileMeta ? (
              <>
                <span style={{ color: "#10b981", marginRight: 6 }}>✓</span>
                Loaded: <b style={{ color: "#334155" }}>{fileMeta.name}</b>
                {fileMeta.pages && ` (${fileMeta.pages} pages)`}
              </>
            ) : (
              "No file selected (Supports PDF, PNG, JPG)"
            )}
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 24, background: "#fef2f2", border: "1px solid #fecaca", padding: "16px", borderRadius: "8px", color: "#991b1b", fontSize: "15px" }}>
            <b>Error:</b> <span style={{ marginLeft: 4 }}>{error}</span>
          </div>
        )}

        {display && (
          <div style={{ marginTop: 24, padding: "24px", background: "#f8fafc", borderRadius: "12px", border: "1px solid #e2e8f0" }}>
            <h3 style={{ margin: "0 0 20px 0", color: "#0f172a", fontSize: "20px" }}>{display.title}</h3>
            <div>{display.content}</div>
            
            <details style={{ marginTop: 24, paddingTop: 16, borderTop: "1px dashed #cbd5e1" }}>
              <summary style={{ cursor: "pointer", color: "#64748b", fontWeight: 600, fontSize: "14px", userSelect: "none" }}>
                View Raw JSON Data
              </summary>
              <pre style={{ 
                background: "#1e293b", 
                color: "#e2e8f0", 
                padding: "16px", 
                borderRadius: "8px", 
                fontSize: "13px", 
                overflowX: "auto",
                marginTop: "12px"
              }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}