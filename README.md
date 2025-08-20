# Buzz Backend (Scan + Resolve + Create)

This is a tiny Express server that lets you **upload a QR/UPC image**, decodes it on the server, tries to **resolve** it to a strain (scraper stub), and **adds** it to an in-memory master list. Swap the in-memory list for a real DB later.

## Quickstart
1) Install Node.js 18+ and npm. Verify:
```
node -v
npm -v
```

2) Install deps:
```
npm i
```

3) Run the server:
```
npm run dev
```
Server listens on `http://localhost:3000` (or change `PORT` in `.env`).

## Endpoints
- `GET /api/strains` → List all strains (in-memory)
- `GET /api/strains/resolve?code=...` → Resolve a code (uses stub)
- `POST /api/strains` (JSON) → Create/upsert a strain
- `POST /api/strains/scan-upload` (form-data: `image=@file`) → Upload QR/UPC image
  - Optional `?autocreate=1` to create an entry if not resolvable

## Test with cURL
```
# Empty list
curl http://localhost:3000/api/strains

# Add a strain manually
curl -X POST http://localhost:3000/api/strains \
  -H "Content-Type: application/json" \
  -d "{ \"name\": \"Blue Dream\", \"thc\": 21, \"bucket\": \"hybrid\", \"terpenes\": [\"Myrcene\", \"Pinene\"] }"

# Check list again
curl http://localhost:3000/api/strains

# Upload QR/UPC image (no auto-create)
curl -F "image=@/absolute/path/to/qr.png" "http://localhost:3000/api/strains/scan-upload"

# Upload with auto-create fallback
curl -F "image=@/absolute/path/to/qr.png" "http://localhost:3000/api/strains/scan-upload?autocreate=1"
```

## Generate a test QR image
```
npm run make-qr
# writes test-qr.png for "https://example.com/wedding-cake"
# try:
curl -F "image=@test-qr.png" "http://localhost:3000/api/strains/scan-upload"
```

## Hook up your app
Use `http://localhost:3000` for web dev, `http://10.0.2.2:3000` for Android emulator.
Set something like:
```js
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";
```

## Notes
- The scraper is a stub (`scrapeFromCode`). If the decoded string contains `wedding-cake`, it returns a demo strain.
- Replace it with per-domain scrapers (Trulieve, MÜV, Fluent, etc.).
- The DB is in-memory here; swap with SQLite/Postgres later.
