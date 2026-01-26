# Travel Document Parser

This project is part of my master's thesis and implements an end-to-end pipeline for extracting structured data from travel documents (currently flight and hotel receipts).  
It combines PDF parsing, OCR (work in progress), and LLM-based information extraction using either OpenAI models or local Llama models (via Ollama).

---

## Architecture Overview

The system consists of two main components:

client/ → React + TypeScript + Vite (PDF rendering + UI)
server/ → Node.js + Express (OCR, LLM orchestration, file handling)


High-level flow:

  [PDF Upload]
         |
  [Backend Server]
         |

PDF.js text extraction
+ optional OCR (WIP)
|
Pre-processing & normalization
|
LLM prompt → OpenAI / Ollama
|
JSON schema extraction
|
[Frontend Viewer]
Currently:
- OCR integration with Tesseract is **in progress**  
- System works reliably **only for text-based PDFs** (no raster/scan support yet)

---

## Tech Stack Details

### Frontend
- React 18 + TypeScript  
- Vite bundler (HMR enabled)  
- pdf.js (`pdfjs-dist`) for rendering + text extraction  
- Minimal UI (no external component library yet)

### Backend
- Node.js + Express  
- Multer for file upload handling  
- dotenv for env variable management  
- CORS enabled for local development  
- LLM routing layer (OpenAI or local Llama via Ollama executable)

### OCR
- Tesseract (via `tesseract.js` planned or native installation)  
- Not fully wired into the backend pipeline yet  
- Placeholder logic included for switching between text-extraction backends

### LLM Providers
#### 1. OpenAI
- Uses `OPENAI_API_KEY`  
- Receives processed text + instruction prompts  
- Returns structured JSON

#### 2. Local Llama Models (Ollama)
- Tested with `llama3.1:8b-instruct-q4_K_M`  
- Runs through `child_process.spawn` or Ollama JS client  
- Good fallback when cloud LLM not desired (privacy-friendly)

---

## Installation

### Clone the repository
```bash
git clone <your-repo-url>
cd travel_document_parser



Backend Setup

cd server
npm install


Environment variables (server/.env):
OPENAI_API_KEY=your_api_key
LLM_PROVIDER=openai      # or "ollama"
PORT=8789






