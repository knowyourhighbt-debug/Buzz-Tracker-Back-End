import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';

import {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from '@zxing/library';

let _pdfParse = null;
async function getPdfParse() {
  if (_pdfParse) return _pdfParse;
  // Use the library entry to avoid any test harness code paths
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  _pdfParse = mod.default || mod;
  return _pdfParse;
}


const app = express();
app.use(cors());
app.use(express.json());

/** ================= In-memory "DB" ================= */
const STRAINS = [];
const toId = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** ================= API Endpoints ================= */
// List
app.get('/api/strains', (req, res) => res.json(STRAINS));

// quick root page so Render sees a 200 at "/"
app.get('/', (req, res) => {
  res.send('Buzz backend is running. Try /api/strains');
});

// explicit health endpoint you (and Render) can hit
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

// Resolve by code (QR/UPC text)
app.get('/api/strains/resolve', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });
  const data = await scrapeFromCode(code);
  if (data) return res.json(normalizeStrain(data));
  return res.status(404).json({ error: 'Not found' });
});

// Create/upsert
app.post('/api/strains', (req, res) => {
  const { code, name, thc, bucket = 'hybrid', lean, terpenes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const strain = normalizeStrain({ code, name, thc, bucket, lean, terpenes });
  upsertStrain(strain);
  return res.status(201).json(strain);
});

// Upload QR/barcode image (no phone needed)
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/strains/scan-upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    // Decode to raw RGBA
    const { data, info } = await sharp(req.file.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const luminance = rgbaToLuminance(data, info.width, info.height);

    // ZXing hints
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.AZTEC,
      BarcodeFormat.DATA_MATRIX, BarcodeFormat.PDF_417
    ]);
    const reader = new MultiFormatReader();
    reader.setHints(hints);

    const source = new RGBLuminanceSource(luminance, info.width, info.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = reader.decode(bitmap);
    const code = String(result.getText() || '').trim();

    // Try to resolve
    const resolved = await scrapeFromCode(code);
    if (resolved) {
      const norm = normalizeStrain(resolved);
      upsertStrain(norm);
      return res.json({ code, status: 'resolved', strain: norm });
    }

    // Optional create
    if (String(req.query.autocreate || '') === '1') {
      const created = normalizeStrain({
        name: guessNameFromCode(code) || 'Unknown Strain',
        thc: undefined,
        bucket: 'hybrid',
        terpenes: []
      });
      upsertStrain(created);
      return res.json({ code, status: 'created', strain: created });
    }

    return res.status(404).json({ code, status: 'not_found' });
  } catch (e) {
    return res.status(422).json({ error: 'Decode failed', detail: String(e?.message || e) });
  }
});

/** ================= Helpers ================= */
function upsertStrain(s) {
  const i = STRAINS.findIndex((x) => x.id === s.id);
  if (i >= 0) STRAINS[i] = s;
  else STRAINS.unshift(s);
}

function normalizeStrain(s) {
  const terps = Array.isArray(s.terpenes)
    ? s.terpenes
    : (s.terpenes ? String(s.terpenes).split(/[;,|\n\r]+/).map(x => x.trim()).filter(Boolean) : []);
  return {
    id: s.id || toId(s.name),
    name: s.name,
    thc: s.thc == null ? undefined : Math.round(Number(String(s.thc).replace(/[^0-9.]/g, ''))),
    bucket: s.bucket || 'hybrid',
    lean: s.lean || (s.bucket === 'sativa_leaning' ? 'Sativa-leaning' : s.bucket === 'indica_leaning' ? 'Indica-leaning' : ''),
    terpenes: terps
  };
}

function rgbaToLuminance(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    out[j] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
  }
  return out;
}

// --- Helper: derive a readable name from a URL slug/filename ---
function guessNameFromCode(code) {
  try {
    const u = new URL(code);
    const last = (u.pathname.split('/').filter(Boolean).pop() || '').trim();
    if (!last) return null;
    // strip extension like .pdf/.html and prettify
    const base = last.replace(/\.(pdf|html?)$/i, '');
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch {
    return null;
  }
}


/** ================= Resolver & Scrapers ================= */
async function scrapeFromCode(code) {
  // If it’s a URL, pick a scraper by host/type
  if (looksLikeUrl(code)) {
    const u = new URL(code);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Trulieve lab PDF (like the one you scanned)
    if (host.includes('trulieve.com') && path.endsWith('.pdf')) {
      return await scrapeTrulieveLabPdf(code);
    }

    // (Later) Trulieve product pages, other MMTCs, etc.
    // if (host.includes('trulieve.com')) return await scrapeTrulieveProductPage(code);
  }

  // UPC/EAN handling (future)
  // if (/^\d{8,14}$/.test(code)) { ... }

  // Demo: allow local “wedding-cake” tests to still work
  if (String(code).toLowerCase().includes('wedding-cake')) {
    return { name: 'Wedding Cake', thc: 23, bucket: 'hybrid', terpenes: ['Caryophyllene','Limonene','Humulene'] };
  }

  return null;
}

function looksLikeUrl(s) { try { new URL(s); return true; } catch { return false; } }

const KNOWN_TERPENES = [
  'Myrcene','Limonene','Caryophyllene','Humulene','Linalool','Pinene','Alpha-Pinene','Beta-Pinene',
  'Terpinolene','Ocimene','Bisabolol','Camphene','Geraniol','Eucalyptol','Nerolidol','Terpineol',
  'Fenchol','Borneol','Isopulegol','Valencene'
];

function normalizeTerpName(name) {
  const n = String(name).toLowerCase().replace(/[^a-z- ]+/g,'');
  if (n.includes('caryophyllene')) return 'Caryophyllene';
  if (n.includes('humulene')) return 'Humulene';
  if (n.includes('limonene')) return 'Limonene';
  if (n.includes('myrcene')) return 'Myrcene';
  if (n.includes('linalool')) return 'Linalool';
  if (n.includes('terpinolene')) return 'Terpinolene';
  if (n.includes('pinene')) return n.includes('alpha') ? 'Alpha-Pinene' : n.includes('beta') ? 'Beta-Pinene' : 'Pinene';
  if (n.includes('ocimene')) return 'Ocimene';
  if (n.includes('bisabolol')) return 'Bisabolol';
  if (n.includes('terpineol')) return 'Terpineol';
  if (n.includes('nerolidol')) return 'Nerolidol';
  if (n.includes('valencene')) return 'Valencene';
  if (n.includes('eucalyptol')) return 'Eucalyptol';
  if (n.includes('geraniol')) return 'Geraniol';
  if (n.includes('fenchol')) return 'Fenchol';
  if (n.includes('borneol')) return 'Borneol';
  if (n.includes('isopulegol')) return 'Isopulegol';
  if (n.includes('camphene')) return 'Camphene';
  return name.replace(/\s+/g,' ').trim();
}

function guessBucketFromText(text) {
  const m = text.match(/\b(Sativa|Indica|Hybrid)\b/i);
  if (!m) return 'hybrid';
  const v = m[1].toLowerCase();
  if (v === 'sativa') return 'sativa_leaning';
  if (v === 'indica') return 'indica_leaning';
  return 'hybrid';
}

function pickTopTerpenes(pairs, max = 6) {
  const sorted = pairs.filter(p => isFinite(p.pct) && p.pct > 0).sort((a,b) => b.pct - a.pct);
  return sorted.slice(0, max).map(p => p.name);
}

/** -------- Trulieve Lab PDF scraper (improved) -------- */
async function scrapeTrulieveLabPdf(url) {
  // 1) Download PDF
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());

  // 2) Extract text (lazy-load pdf-parse for Render stability)
  const pdfParse = await getPdfParse();
  const { text: pdfText } = await pdfParse(buf);
  const raw = (pdfText || '').replace(/\r/g, '');
  const text = raw.replace(/[ \t]+/g, ' ');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // 3) Strain / Product name
  const namePatterns = [
    /(?:Strain(?: Name)?|Product(?: Name)?|Product|Variety|Cultivar):\s*([^\n]+)\n?/i,
    /(?:Item|Sample(?: Name)?):\s*([^\n]+)\n?/i
  ];
  let name;
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) { name = m[1].replace(/\s+/g,' ').trim(); break; }
  }
  if (!name) name = guessNameFromCode(url) || 'Unknown Strain';

  // 4) THC — prefer explicit "Total THC", else 0.877*THCA + Δ9THC
  let totalThc;
  const mTotal = text.match(/Total\s*(?:Δ?9|Delta[-\s]?9)?\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (mTotal) {
    totalThc = Number(mTotal[1]);
  } else {
    const mThca = text.match(/THC-?A\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) || text.match(/\bTHCA\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
    const mD9   = text.match(/(?:Δ?9|Delta[-\s]?9)\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i) || text.match(/\bTHC\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
    const thca = mThca ? Number(mThca[1]) : 0;
    const d9   = mD9   ? Number(mD9[1])   : 0;
    if (thca || d9) totalThc = Number((0.877 * thca + d9).toFixed(1));
  }

  // 5) Terpenes — accept % OR mg/g (convert mg/g → % by ÷10)
  const terpPairs = [];
  for (const line of lines) {
    let m = line.match(/^([A-Za-zµβ\- ]+?)\s+([0-9]+(?:\.[0-9]+)?)\s*%$/);
    if (m) {
      const n = normalizeTerpName(m[1]);
      if (KNOWN_TERPENES.some(k => n.toLowerCase().includes(k.toLowerCase()))) {
        terpPairs.push({ name: n, pct: Number(m[2]) });
      }
      continue;
    }
    m = line.match(/^([A-Za-zµβ\- ]+?)\s+([0-9]+(?:\.[0-9]+)?)\s*mg\/g\b/i);
    if (m) {
      const n = normalizeTerpName(m[1]);
      if (KNOWN_TERPENES.some(k => n.toLowerCase().includes(k.toLowerCase()))) {
        const pct = Number(m[2]) / 10; // 10 mg/g ≈ 1%
        terpPairs.push({ name: n, pct: Number(pct.toFixed(2)) });
      }
    }
  }
  const terpenes = pickTopTerpenes(terpPairs, 6);

  // 6) Bucket guess
  const bucket = guessBucketFromText(text);

  return { name, thc: totalThc, bucket, terpenes };
}


/** ================= Start ================= */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Buzz backend listening on http://localhost:${port}`);
});
