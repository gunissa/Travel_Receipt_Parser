import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// CONFIGURATION
const API_URL = "http://localhost:8789/api/extract-file"; 
const IMAGE_DIR = "./low_quality_images";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runBatch() {
  const dirPath = path.join(__dirname, IMAGE_DIR);

  if (!fs.existsSync(dirPath)) {
    console.error(`Error: Directory ${IMAGE_DIR} does not exist.`);
    return;
  }

  const files = fs.readdirSync(dirPath).filter(f => /\.(png|jpg|jpeg)$/i.test(f));

  console.log(`Found ${files.length} images in ${IMAGE_DIR}`);

  let i = 0;
  for (const file of files) {
    i++;
    const filePath = path.join(dirPath, file);
    const ext = path.extname(file).toLowerCase();
    
    // Determine the correct MIME type
    let mimeType = "application/octet-stream";
    if (ext === ".png") mimeType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";

    // Create Blob WITH the MIME type
    const fileBuffer = fs.readFileSync(filePath);
    const fileBlob = new Blob([fileBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append("file", fileBlob, file);

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        body: formData,
      });

      const json = await res.json();

      if (res.ok && json.ok) {
        console.log(`[${i}/${files.length}] OK   ${file}`);
      } else {
        // Handle server errors
        const err = json.error || (json.data ? "Validation Error" : "Unknown Error");
        console.log(`[${i}/${files.length}] FAIL ${file} — ${err}`);
      }
    } catch (e) {
      console.log(`[${i}/${files.length}] FAIL ${file} — Network/Server Error: ${e.message}`);
    }
  }
  console.log("\nDone.");
}

runBatch();