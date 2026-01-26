import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import Tesseract from "tesseract.js";
import Database from "better-sqlite3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const upload = multer({ dest: "uploads/" });

// =====================================================
// Provider + model selection
// =====================================================

const PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();

if (!["openai", "ollama"].includes(PROVIDER)) {
  throw new Error(`Invalid LLM_PROVIDER: ${PROVIDER}`);
}

const BASE_URL =
  PROVIDER === "ollama"
    ? process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1"
    : "https://api.openai.com/v1";

const API_KEY = PROVIDER === "ollama" ? "ollama" : process.env.OPENAI_API_KEY;

if (PROVIDER === "openai" && !API_KEY) {
  throw new Error("OPENAI_API_KEY is missing");
}

const MODEL =
  PROVIDER === "ollama"
    ? process.env.OLLAMA_MODEL
    : process.env.OPENAI_MODEL || "gpt-4o-mini";

// =====================================================

// SQLite setup
// =====================================================

const DB_PATH = process.env.EVAL_DB_PATH || "./eval.sqlite";
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT,
  timestamp TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,

  docType_pred TEXT,
  groundTruth_docType TEXT,

  json_output TEXT,
  success INTEGER NOT NULL,
  parse_error TEXT,

  latency_ms INTEGER NOT NULL,
  ocr_used INTEGER NOT NULL,

  input_type TEXT NOT NULL,
  input_chars INTEGER NOT NULL,

  notes TEXT
);
`);

const insertRun = db.prepare(`
INSERT INTO eval_runs (
  source_file,
  timestamp, provider, model,
  docType_pred, groundTruth_docType,
  json_output, success, parse_error,
  latency_ms, ocr_used,
  input_type, input_chars,
  notes
) VALUES (
  @source_file,
  @timestamp, @provider, @model,
  @docType_pred, @groundTruth_docType,
  @json_output, @success, @parse_error,
  @latency_ms, @ocr_used,
  @input_type, @input_chars,
  @notes
);
`);

function logEvalRun(row) {
  insertRun.run({
    source_file: row.source_file ?? null,
    timestamp: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,

    docType_pred: row.docType_pred ?? null,
    groundTruth_docType: row.groundTruth_docType ?? null,

    json_output: row.json_output ?? null,
    success: row.success ? 1 : 0,
    parse_error: row.parse_error ?? null,

    latency_ms: row.latency_ms ?? 0,
    ocr_used: row.ocr_used ? 1 : 0,

    input_type: row.input_type,
    input_chars: row.input_chars ?? 0,

    notes: row.notes ?? null,
  });
}

// =====================================================
// Prompt
// =====================================================

function buildPrompt(text) {
  return `
You are an information extraction system. You read travel-related documents
(flight tickets / itineraries / boarding passes / flight receipts OR hotel booking confirmations / hotel invoices)
and you MUST return a single JSON object that matches EXACTLY one of these schemas:

FLIGHT:
{
  "type": "flight",
  "passengerName": string | null,
  "bookingReference": string | null,
  "ticketNumber": string | null,
  "tripType": "one_way" | "round_trip" | null,
  "overallFrom": string | null,
  "overallTo": string | null,
  "departureDate": string | null,
  "returnDate": string | null,
  "currency": string | null,
  "totalPrice": number | null
}

HOTEL:
{
  "type": "hotel",
  "guestName": string | null,
  "hotelName": string | null,
  "receiptNumber": string | null,
  "hotelCity": string | null,
  "checkInDate": string | null,
  "checkOutDate": string | null,
  "currency": string | null,
  "totalPrice": number | null
}

Rules:
1) Choose exactly ONE: "type" must be either "flight" or "hotel".
2) Dates must be "YYYY-MM-DD" (date only). If unknown, null.
3) City fields must be only city names (NOT airport codes and no country names) in ALL CAPS. If only code, infer city if obvious.
4) Names: FIRSTNAME LASTNAME in ALL CAPS; remove titles MR/MS/MRS/DR; remove extra tokens.
5) Flight simplification: do NOT output segments/connections.
   overallFrom = first departure city name (the trip origin, not a connecting or layover airport; not an airport code or airport name), written in ALL CAPS as defined in point 3.
   overallTo = final destination city name of the outgoing flight (not a connecting or layover airport; not an airport code or airport name), written in ALL CAPS as defined in point 3.   
   departureDate = first departure date.
   returnDate = departure date of the return flight (not a connecting or lazover flight) for round_trip only; otherwise null.
   A flight is round_trip ONLY if there are two opposite directions (A→B and B→A) with respective flight dates. There can be connecting flight in return ticket (A→C→B and B→C→A).
   Otherwise (if there are no opposite directions), it is one-way and returnDate MUST be null. There can be connecting flight in one-way ticket (i.e., A→C→B without returning from B to A).
6) Price: currency must be a 3-letter international code. totalPrice must be a pure number (no currency symbols) representing the final sum of all costs, including the base fare/rate plus all applicable taxes, fees, and surcharges.
7) Output ONLY valid JSON. No markdown, no extra keys.
8) Always respond in English and use English characters.
9) totalPrice must be a non-negative NUMBER (no currency symbols); if multiple prices, use TOTAL amount.
10) bookingReference and receiptNumber are the same concept (different names for flight vs hotel). 
    If multiple references/numbers, use the main one that is most prominently displayed.
11) Hotel name formatting: hotelName must use Capitalized Words (first letter uppercase for each word).


Now extract from this document:

${text}
  `.trim();
}

// =====================================================
// Helpers
// =====================================================

function normalizeText(text, max = 12000) {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanNameAllCaps(name) {
  if (!name || typeof name !== "string") return null;
  const stripped = name
    .replace(/\b(MR|MRS|MS|MISS|DR|PROF)\b\.?/gi, "")
    .replace(/[^A-Za-zÀ-ÿ\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.toUpperCase();
}

function cleanTicketNumber(t) {
  if (!t || typeof t !== "string") return null;
  const digits = t.replace(/[^\d\s]/g, " ").replace(/\s+/g, " ").trim();
  return digits || null;
}

// JSON handling
function stripCodeFences(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
}

function extractFirstJSONObject(raw) {
  const s = stripCodeFences(raw);
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

// Ensures missing keys are added as null before validation
function ensureRequiredKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (obj.type === "flight") {
    const keys = [
      "passengerName", "bookingReference", "ticketNumber", "tripType",
      "overallFrom", "overallTo", "departureDate", "returnDate",
      "currency", "totalPrice"
    ];
    for (const k of keys) {
      if (!(k in obj)) {
        obj[k] = null;
      }
    }
  } else if (obj.type === "hotel") {
    const keys = [
      "guestName", "hotelName", "receiptNumber", "hotelCity",
      "checkInDate", "checkOutDate", "currency", "totalPrice"
    ];
    for (const k of keys) {
      if (!(k in obj)) {
        obj[k] = null;
      }
    }
  }
  return obj;
}

// ---------- Post-processing (Robust Round-Trip) ----------

function postProcessFlight(flightObj, originalText) {
  const out = { ...flightObj };

  // 1. Clean basic fields
  out.passengerName = cleanNameAllCaps(out.passengerName);
  out.ticketNumber = cleanTicketNumber(out.ticketNumber);

  const t = (originalText || "").toLowerCase();
  const a = (out.overallFrom || "").toLowerCase();
  const b = (out.overallTo || "").toLowerCase();

  // 2. Default to "one_way"
  out.tripType = "one_way";

  if (!a || !b) return out;

  // 3. Verify Forward Leg exists (A -> ... -> B)
  const idxA = t.indexOf(a);
  const idxB = t.indexOf(b, idxA);

  if (idxA !== -1 && idxB !== -1) {
    // 4. Scan for valid Return Leg (B -> ... -> A)
    let cursor = idxB;
    
    while ((cursor = t.indexOf(a, cursor)) !== -1) {
      
      // CHECK 1: Is this 'A' followed closely by 'B'? (Repetition check)
      const nextB = t.indexOf(b, cursor);
      const isRepetition = (nextB !== -1 && (nextB - cursor) < 400);

      // CHECK 2: Is this 'A' near a Time or Date? (Footer noise check)
      const snippet = t.slice(Math.max(0, cursor - 50), cursor + 100);
      const hasDigit = /\d/.test(snippet);

      if (!isRepetition && hasDigit) {
        // Found 'A' that is NOT a repetition AND looks like a real flight entry
        out.tripType = "round_trip";
        return out; 
      }
      
      cursor++; 
    }
  }

  // Enforce one_way rules
  out.returnDate = null;
  return out;
}

// ---------- Validate schema ----------
function assertValidOutput(obj) {
  const t = obj?.type;
  if (t !== "flight" && t !== "hotel") {
    throw new Error(
      `Model output missing/invalid "type": ${JSON.stringify(obj).slice(0, 200)}`
    );
  }

  if (t === "flight") {
    const required = [
      "passengerName",
      "bookingReference",
      "ticketNumber",
      "tripType",
      "overallFrom",
      "overallTo",
      "departureDate",
      "returnDate",
      "currency",
      "totalPrice",
    ];
    for (const k of required) {
      if (!(k in obj)) throw new Error(`Flight output missing key "${k}"`);
    }
  }

  if (t === "hotel") {
    const required = [
      "guestName",
      "hotelName",
      "receiptNumber",
      "hotelCity",
      "checkInDate",
      "checkOutDate",
      "currency",
      "totalPrice",
    ];
    for (const k of required) {
      if (!(k in obj)) throw new Error(`Hotel output missing key "${k}"`);
    }
  }
}

async function callLLM(text) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: buildPrompt(normalizeText(text)) }],
    temperature: 0,
    max_tokens: 700,
    ...(PROVIDER === "ollama" ? { format: "json" } : {}),
    ...(PROVIDER === "openai" ? { response_format: { type: "json_object" } } : {}),
  };

  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();

  if (data?.error) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }

  const raw = data?.choices?.[0]?.message?.content ?? "";

  try {
    return JSON.parse(stripCodeFences(raw));
  } catch {}

  const jsonStr = extractFirstJSONObject(raw);
  if (!jsonStr) {
    throw new Error(`Invalid JSON from model (no object found). Raw: ${raw.slice(0, 200)}...`);
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Invalid JSON from model (parse failed). Extracted: ${jsonStr.slice(0, 200)}...`
    );
  }
}

async function extractTextFromImage(path) {
  const buffer = await fs.promises.readFile(path);
  const { data } = await Tesseract.recognize(buffer, "eng");
  return data.text;
}

// =====================================================
// Routes
// =====================================================

app.get("/api/ping", (_, res) => {
  res.json({ ok: true, provider: PROVIDER, model: MODEL, db: DB_PATH });
});

app.post("/api/extract", async (req, res) => {
  const t0 = Date.now();
  const inputText = req?.body?.text ?? "";
  const source_file = req?.body?.source_file ?? null;

  const inputChars = typeof inputText === "string" ? inputText.length : 0;

  try {
    if (!inputText) return res.status(400).json({ error: "Missing text" });

    let data = await callLLM(inputText);

    //Fill missing keys with null BEFORE validation
    data = ensureRequiredKeys(data);

    assertValidOutput(data);

    if (data.type === "flight") {
      data = postProcessFlight(data, inputText);
    }
    
    // Ensure keys still exist after post-processing
    data = ensureRequiredKeys(data); 

    assertValidOutput(data);

    const latency = Date.now() - t0;

    logEvalRun({
      source_file,
      input_type: "text",
      input_chars: inputChars,
      ocr_used: 0,
      latency_ms: latency,
      success: 1,
      docType_pred: data.type,
      json_output: JSON.stringify(data),
      parse_error: null,
    });

    return res.json({ ok: true, data });
  } catch (e) {
    const latency = Date.now() - t0;

    logEvalRun({
      source_file,
      input_type: "text",
      input_chars: inputChars,
      ocr_used: 0,
      latency_ms: latency,
      success: 0,
      docType_pred: null,
      json_output: null,
      parse_error: e?.message ?? "Unknown error",
    });

    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/extract-file", upload.single("file"), async (req, res) => {
  const t0 = Date.now();
  const filePath = req?.file?.path;
  const source_file = req?.file?.originalname ?? null;

  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Only images supported" });
    }

    const ocrText = await extractTextFromImage(filePath);
    const inputChars = ocrText?.length ?? 0;

    let data = await callLLM(ocrText);

    // Fill missing keys with null BEFORE validation
    data = ensureRequiredKeys(data);

    assertValidOutput(data);

    if (data.type === "flight") {
      data = postProcessFlight(data, ocrText);
    }

    // Ensure keys still exist after post-processing
    data = ensureRequiredKeys(data);

    assertValidOutput(data);

    const latency = Date.now() - t0;

    logEvalRun({
      source_file,
      input_type: "image",
      input_chars: inputChars,
      ocr_used: 1,
      latency_ms: latency,
      success: 1,
      docType_pred: data.type,
      json_output: JSON.stringify(data),
      parse_error: null,
    });

    return res.json({ ok: true, data });
  } catch (e) {
    const latency = Date.now() - t0;

    logEvalRun({
      source_file,
      input_type: "image",
      input_chars: 0,
      ocr_used: 1,
      latency_ms: latency,
      success: 0,
      docType_pred: null,
      json_output: null,
      parse_error: e?.message ?? "Unknown error",
    });

    return res.status(500).json({ error: e.message });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// =====================================================
// Start
// =====================================================

app.listen(process.env.PORT || 8789, () => {
  console.log(`Server running | Provider: ${PROVIDER} | Model: ${MODEL}`);
  console.log(`Logging eval runs to SQLite: ${DB_PATH}`);
});