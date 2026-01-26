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

            const renderTask: any = page.render({ canvasContext: ctx, viewport });
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

  // Helper to trigger the hidden input
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
    <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr" }}>
      <div><b>Passenger</b>: {f.passengerName ?? "—"}</div>
      <div><b>Booking Ref</b>: {f.bookingReference ?? "—"}</div>
      <div><b>Ticket</b>: {f.ticketNumber ?? "—"}</div>
      <div><b>Trip Type</b>: {f.tripType ?? "—"}</div>
      <div><b>From</b>: {f.overallFrom ?? "—"}</div>
      <div><b>To</b>: {f.overallTo ?? "—"}</div>
      <div><b>Departure</b>: {f.departureDate ?? "—"}</div>
      <div><b>Return</b>: {f.returnDate ?? "—"}</div>
      <div style={{ gridColumn: "1 / -1" }}><b>Total</b>: {formatMoney(f.currency, f.totalPrice)}</div>
    </div>
  );

  const renderHotel = (h: HotelData) => (
    <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr" }}>
      <div><b>Guest</b>: {h.guestName ?? "—"}</div>
      <div><b>Hotel</b>: {h.hotelName ?? "—"}</div>
      <div><b>Receipt</b>: {h.receiptNumber ?? "—"}</div>
      <div><b>City</b>: {h.hotelCity ?? "—"}</div>
      <div><b>Check In</b>: {h.checkInDate ?? "—"}</div>
      <div><b>Check Out</b>: {h.checkOutDate ?? "—"}</div>
      <div style={{ gridColumn: "1 / -1" }}><b>Total</b>: {formatMoney(h.currency, h.totalPrice)}</div>
    </div>
  );

  const display = useMemo(() => {
    if (!result) return null;
    return result.type === "flight"
      ? { title: "Parsed Flight", content: renderFlight(result as FlightData) }
      : { title: "Parsed Hotel", content: renderHotel(result as HotelData) };
  }, [result]);

  // =============================
  // Layout styles
  // =============================
  const wrapperStyle: React.CSSProperties = {
    minHeight: "100vh",
  width: "100vw",         
  background: "linear-gradient(135deg, #e3f2fd, #f9fbff)",
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
  padding: "48px 16px",
  boxSizing: "border-box",    
  };

  const cardStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 900,
    margin: "0 auto", 
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
    padding: 30,      
    boxSizing: "border-box",
    background: "#fff",
    borderRadius: 12, 
    boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
  };

  const dropzoneStyle: React.CSSProperties = {
    border: "2px dashed #e6e6e6",
    borderRadius: 8,
    padding: 24,
    textAlign: "center",
    background: "#fafafa",
  };

  const primaryButton: React.CSSProperties = {
    background: "#0b5fff",
    color: "white",
    border: "none",
    padding: "10px 16px",
    borderRadius: 6,
    cursor: loading ? "default" : "pointer",
    boxShadow: "0 4px 12px rgba(11,95,255,0.18)",
    marginRight: 8,
  };

  const secondaryButton: React.CSSProperties = {
    background: "white",
    color: "#333",
    border: "1px solid #ddd",
    padding: "8px 12px",
    borderRadius: 6,
    cursor: "pointer",
  };

  const graySmall: React.CSSProperties = { color: "#666", fontSize: 13 };

  return (
    <div style={wrapperStyle}>
      <div style={cardStyle}>
        <h1 style={{ margin: 0 }}>Travel Receipt Parser</h1>
        <p style={{ marginTop: 6, marginBottom: 18, color: "#555" }}>
          Upload a PDF or image of your hotel or flight receipt to extract booking details.
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

          <div style={{ marginBottom: 12 }}>
            <button style={primaryButton} onClick={triggerFilePicker} disabled={loading}>
              {loading ? "Processing…" : "Choose file"}
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
                style={{ ...secondaryButton, marginLeft: 8 }}
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
                Loaded: <b>{fileMeta.name}</b>
                {fileMeta.pages && ` — ${fileMeta.pages} page(s)`}
              </>
            ) : (
              "No file selected"
            )}
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 16, background: "#ffe6e6", padding: 12, borderRadius: 6 }}>
            <b style={{ color: "#b30000" }}>Error:</b> <span style={{ marginLeft: 8 }}>{error}</span>
          </div>
        )}

        {display && (
          <div style={{ marginTop: 18, padding: 16, background: "white", borderRadius: 8, border: "1px solid #eee" }}>
            <h3 style={{ marginTop: 0 }}>{display.title}</h3>
            <div>{display.content}</div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer" }}>Raw JSON</summary>
              <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}