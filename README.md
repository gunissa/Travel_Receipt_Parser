# Travel Receipt Parser

> Structured Data Extraction from Travel Documents using Large Language Models (LLMs)
> React · Node.js · Tesseract · OpenAI · Ollama (LLaMA)

---

## What It Does

Upload a travel document (text-based PDF, scanned/image-based PDF, or image file) —  
the system extracts structured data automatically and returns clean JSON.

**Flow:**

Upload → OCR → LLM → Structured JSON → SQLite Logging

This project focuses on:

AI-based document processing
Comparison of cloud vs. local LLMs
Automation of travel expense extraction
Integration of OCR and LLMs in a single pipeline

---

## Key Features

- Upload images or PDFs
- OCR with **Tesseract.js**
- JSON extraction via **OpenAI** or **Local LLaMA (Ollama)**
- Easy model switching (`openai` / `ollama`)
- SQLite logging of every run
- Batch evaluation scripts
- CSV export for quantitative analysis

---

## Tech Stack

**Frontend**

- React
- TypeScript
- Vite

**Backend**

- Node.js
- Express
- Tesseract.js
- OpenAI API
- Ollama (LLaMA 3.1)
- SQLite

---

## Architecture

Client (React)
↓
Express API
↓
OCR (Tesseract.js)
↓
LLM (OpenAI or Ollama)
↓
SQLite (eval.sqlite)
↓
JSON Response

---

## ⚙️ Installation

```bash
git clone <your-repo-url>
cd Travel_Receipt_Parser

```

Install Backend

```bash
cd server
npm install
```

Install Frontend

```bash
cd ../client
npm install
```

Environment Variables

Create server/.env:

```env
PORT=8789

# OpenAI (cloud)
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini

# Ollama (local)
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=llama3.1:8b-instruct-q8_0
```

Running the App

OpenAI Mode

```bash
cd server
npm run openai
```

Ollama Mode (Local LLaMA)

Make sure Ollama is running:

```bash
ollama run llama3.1:8b-instruct-q8_0
```

Then:

```bash
npm run ollama
```

Start Frontend

```bash
cd client
npm run dev
```

Frontend → http://localhost:5173
Backend → http://localhost:8789

Batch Evaluation
Run automated experiments:

```bash
node run_batch_images.mjs
node run_batch_text_pdfs.mjs
node run_batch_low_quality_images.mjs
```

All experiment runs are stored in the SQLite database:
server/eval.sqlite

Export Results (CSV)
After running experiments, export all recorded runs using:

```bash
sqlite3 -header -csv eval.sqlite "
SELECT
  id,
  timestamp,
  source_file,
  provider,
  model,
  success,
  docType_pred,
  latency_ms,
  ocr_used,
  input_chars,
  json_output
FROM eval_runs
ORDER BY id;
" > eval_runs_all.csv
```

This generates:
server/eval_runs_all.csv

The exported CSV file enables further analysis of:

Extraction success rates
Processing latency
OCR impact on performance
Differences between cloud and local models
Model behavior across document types

📂 Project Structure
Travel*Receipt_Parser/
│
├── client/ # React frontend
├── server/ # Express backend
│ ├── uploads/
│ ├── images/
│ ├── pdfs_text/
│ ├── eval.sqlite
│ ├── run_batch*\*.mjs
│ └── index.js
│
└── README.md

License
Academic / Research Use

Gunay Aghadadashli
Master’s Thesis – Structured Data Extraction from Travel Documents using Large Language Models (LLMs) (2026)