// run_batch_text_pdfs.mjs
import fs from "fs";
import path from "path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const API_BASE = process.env.API_BASE || "http://localhost:8789";
const PDF_DIR = process.env.PDF_DIR || path.join(process.cwd(), "pdfs_text");

// small delay so we don’t hammer the server/LLM
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractTextFromPdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await getDocument({ data }).promise;

  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it) => (it && typeof it.str === "string" ? it.str : ""))
      .join(" ");
    fullText += pageText + "\n\n";
  }

  return fullText
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function postExtract({ text, source_file }) {
  const r = await fetch(`${API_BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      source_file, // ✅ filename sent to backend
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${r.status}`);
  }
  return data.data;
}

async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    throw new Error(`PDF directory not found: ${PDF_DIR}`);
  }

  const files = fs
    .readdirSync(PDF_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    console.log(`No PDFs found in ${PDF_DIR}`);
    return;
  }

  console.log(`Batch running ${files.length} text-based PDFs`);
  console.log(`PDF_DIR = ${PDF_DIR}`);
  console.log(`API_BASE = ${API_BASE}\n`);

  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const fullPath = path.join(PDF_DIR, fileName);

    try {
      const text = await extractTextFromPdf(fullPath);

      if (!text || text.length < 40) {
        console.log(`[${i + 1}/${files.length}] SKIP (no text) ${fileName}`);
        continue;
      }

      await postExtract({ text, source_file: fileName });
      console.log(`[${i + 1}/${files.length}] OK   ${fileName}`);
    } catch (e) {
      console.log(`[${i + 1}/${files.length}] FAIL ${fileName} — ${e.message}`);
    }

    await sleep(150);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Batch failed:", e.message);
  process.exit(1);
});
