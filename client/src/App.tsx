import { useMemo, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.min.mjs";

const API_BASE = "http://localhost:8789";

// =============================
// Types (FINAL schema)
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

  // =============================
  // Backend calls
  // =============================
  async function callTextExtraction(text: string, source_file: string) {
    const r = await fetch(`${API_BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source_file }),
    });

    const data = await r.json();

    if (!r.ok || !data?.ok) {
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

    const data = await r.json();

    if (!r.ok || !data?.ok) {
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

        // fallback → OCR first page
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unsupported");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({ canvasContext: ctx, viewport } as any).promise;

        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/png")
        );

        const img = new File([blob], "page.png", { type: "image/png" });
        const res = await callFileOcrExtraction(img);
        setResult(res);
        return;
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

  // =============================
  // Render
  // =============================
  const display = useMemo(() => {
    if (!result) return null;
    return result.type === "flight"
      ? { title: "Parsed Flight", flight: result }
      : { title: "Parsed Hotel", hotel: result };
  }, [result]);

  return (
    <div style={{ maxWidth: 900, margin: "2rem auto", fontFamily: "system-ui" }}>
      <h1>Travel Receipt Parser</h1>

      <label style={{ cursor: "pointer", fontWeight: 600 }}>
        {loading ? "Processing…" : "Upload PDF or Image"}
        <input
          type="file"
          accept="application/pdf,image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickFile(f);
            e.currentTarget.value = "";
          }}
        />
      </label>

      {fileMeta && (
        <p style={{ color: "#666" }}>
          Loaded: <b>{fileMeta.name}</b>
          {fileMeta.pages && ` (${fileMeta.pages} pages)`}
        </p>
      )}

      {error && (
        <div style={{ background: "#ffe6e6", padding: 12, marginTop: 16 }}>
          <b>Error:</b> {error}
        </div>
      )}

      {display?.flight && (
        <pre style={{ marginTop: 16 }}>
          {JSON.stringify(display.flight, null, 2)}
        </pre>
      )}

      {display?.hotel && (
        <pre style={{ marginTop: 16 }}>
          {JSON.stringify(display.hotel, null, 2)}
        </pre>
      )}
    </div>
  );
}
