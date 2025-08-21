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

/* ================= PDF parse loader ================= */
let _pdfParse = null;
async function getPdfParse() {
  if (_pdfParse) return _pdfParse;
  // Use the library entry to avoid any test harness code paths
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  _pdfParse = mod.default || mod;
  return _pdfParse;
}

/* ================= App ================= */
const app = express();
app.use(cors());
app.use(express.json());

/* ================= In-memory "DB" ================= */
const STRAINS = [];
const toId = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/* ================= API Endpoints ================= */

// List all
app.get('/api/strains', (req, res) => res.json(STRAINS));

// Get one by id
app.get('/api/strains/:id', (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  const s = STRAINS.find(x => String(x.id).toLowerCase() === id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json(s);
});

// Root + health
app.get('/', (req, res) => res.send('Buzz backend is running. Try /api/strains'));
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// Resolve by code (QR/UPC text or URL)
app.get('/api/strains/resolve', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });
  const data = await scrapeFromCode(code);
  if (data) return res.json(normalizeStrain(data));
  return res.status(404).json({ error: 'Not found' });
});

// Create/upsert (manual)
app.post('/api/strains', (req, res) => {
  const { code, name, thc, bucket = 'hybrid', lean, terpenes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const strain = normalizeStrain({ code, name, thc, bucket, lean, terpenes });
  upsertStrain(strain);
  return res.status(201).json(strain);
});

// Upload QR/barcode image (server-side scan)
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/strains/scan-upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    // Decode to raw RGBA
    const { data, info } = await sharp(req.file.buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
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

    // Try to resolve & upsert into master list
    const resolved = await scrapeFromCode(code);
    if (resolved) {
      const norm = normalizeStrain(resolved);
      upsertStrain(norm);
      return res.json({ code, status: 'resolved', strain: norm });
    }

    // Optional: create a stub when unresolved
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

/* ================= Helpers ================= */

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
    const base = last.replace(/\.(pdf|html?)$/i, '');
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch {
    return null;
  }
}

// Terpene extraction that accepts %, mg/g (÷10), ppm (÷100)
function extractTerpenesFromText(pdfRaw) {
  const text = pdfRaw.replace(/\r/g, ' ').replace(/[ \t]+/g, ' ');
  const pairs = [];
  for (const terp of KNOWN_TERPENES) {
    const variants = [
      terp,
      terp.replace('Alpha-', 'α-'),
      terp.replace('Beta-', 'β-'),
      terp.replace('-', ' '),
    ].filter((v, i, a) => a.indexOf(v) === i);

    const nameAlt = variants.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(?:${nameAlt})\\s*[:=]?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(%|mg\\/g|ppm|parts\\s*per\\s*million)`, 'i');
    const m = text.match(re);
    if (!m) continue;

    let val = Number(m[1]);
    const unit = m[2].toLowerCase();
    const pct =
      unit.includes('ppm') || unit.includes('parts') ? +(val / 100).toFixed(2)
        : unit === 'mg/g' ? +(val / 10).toFixed(2)
        : val;

    pairs.push({ name: normalizeTerpName(terp), pct });
  }
  return pickTopTerpenes(pairs, 6);
}

/* ================= Resolver & Scrapers ================= */

async function scrapeFromCode(code) {
  // If it’s a URL, pick a scraper by host/type
  if (looksLikeUrl(code)) {
    const u = new URL(code);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Trulieve lab PDF
    if (host.includes('trulieve.com') && path.endsWith('.pdf')) {
      return await scrapeTrulieveLabPdf(code);
    }
  }

  // Future: UPC/EAN handling…

  // Demo fallback
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
  if (!name) return '';
  // Normalize: map Greek letters and keep helpful punctuation
  let n = String(name)
    .replace(/α/gi, 'alpha')
    .replace(/β/gi, 'beta')
    .toLowerCase()
    .replace(/[^a-z\- ()+\/]+/g, '');

  if (n.includes('caryophyllene')) return 'Caryophyllene';
  if (n.includes('humulene')) return 'Humulene';
  if (n.includes('limonene')) return 'Limonene';
  if (n.includes('myrcene')) return 'Myrcene';
  if (n.includes('linalool')) return 'Linalool';
  if (n.includes('terpinolene')) return 'Terpinolene';
  if (n.includes('pinene')) {
    if (n.includes('alpha')) return 'Alpha-Pinene';
    if (n.includes('beta')) return 'Beta-Pinene';
    return 'Pinene';
  }
  if (n.includes('ocimene')) return 'Ocimene';
  if (n.includes('bisabolol')) return 'Bisabolol';
  if (n.includes('terpineol')) return 'Terpineol';
  if (n.includes('nerolidol')) return 'Nerolidol';
  if (n.includes('valencene')) return 'Valencene';
  if (n.includes('eucalyptol') || n.includes('cineole')) return 'Eucalyptol';
  if (n.includes('geraniol')) return 'Geraniol';
  if (n.includes('fenchol') || n.includes('fenchyl')) return 'Fenchol'; // e.g., Fenchyl Alcohol
  if (n.includes('borneol')) return 'Borneol';
  if (n.includes('isopulegol')) return 'Isopulegol';
  if (n.includes('camphene')) return 'Camphene';

  return String(name).replace(/\s+/g, ' ').trim();
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
  const sorted = pairs
    .filter(p => Number.isFinite(p.pct) && p.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  return sorted.slice(0, max).map(p => p.name);
}

/** -------- Trulieve Lab PDF scraper (improved) -------- */
async function scrapeTrulieveLabPdf(url) {
  // 1) Download PDF
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());

  // 2) Extract text
  const pdfParse = await getPdfParse();
  const { text: pdfText } = await pdfParse(buf);
  const raw = (pdfText || '').replace(/\r/g, '');
  const text = raw.replace(/[ \t]+/g, ' ');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // 3) Strain / Product name
  const namePatterns = [
    /(?:Strain(?: Name)?|Product(?: Name)?|Product|Variety|Cultivars?|Cultivar):\s*([^\n]+)\n?/i,
    /(?:Item|Sample(?: Name)?):\s*([^\n]+)\n?/i,
  ];
  let name;
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) { name = m[1].replace(/\s+/g, ' ').trim(); break; }
  }
  if (!name) name = guessNameFromCode(url) || 'Unknown Strain';

  // 4) THC — prefer explicit "Total THC", else 0.877*THCA + Δ9THC (supports % or mg/g)
  let totalThc;
  const mTotal = text.match(
    /Total\s*(?:Δ?9|Delta[-\s]?9)?\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i
  );
  if (mTotal) {
    const val = parseFloat(mTotal[1]);
    const unit = (mTotal[2] || '%').toLowerCase();
    totalThc = unit.includes('%') ? val : val / 10; // mg/g → %
  } else {
    const pick = (re) => {
      const m = text.match(re);
      if (!m) return undefined;
      const v = parseFloat(m[1]);
      const unit = (m[2] || '%').toLowerCase();
      return unit.includes('%') ? v : v / 10; // mg/g → %
    };
    const thca = pick(/\bTHC-?A\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i);
    const d9   = pick(/(?:Δ?9|Delta[-\s]?9)\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i)
              ?? pick(/\bTHC\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i);
    const thcaVal = Number.isFinite(thca) ? thca : 0;
    const d9Val   = Number.isFinite(d9) ? d9 : 0;
    if (thcaVal || d9Val) totalThc = Number((0.877 * thcaVal + d9Val).toFixed(1));
  }

  // 5) Terpenes — accept %, mg/g (÷10), or ppm (÷100 → %)
  const terpPairs = [];
  for (const line of lines) {
    const m = line.match(
      /^([A-Za-zµβ()\-+ ]+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(%|mg\/g|ppm|parts\s*per\s*million)\b/i
    );
    if (!m) continue;

    const rawName = m[1].trim();
    let value = parseFloat(m[2]);
    const unit = m[3].toLowerCase();

    if (unit.includes('ppm') || unit.includes('parts')) {
      value = value / 100;     // 100 ppm ≈ 0.1%
    } else if (unit.includes('mg')) {
      value = value / 10;      // 10 mg/g ≈ 1%
    } // else already %

    const normName = normalizeTerpName(rawName);
    if (
      normName &&
      /[A-Za-z]/.test(normName) &&
      KNOWN_TERPENES.some(k => normName.toLowerCase().includes(k.toLowerCase()))
    ) {
      terpPairs.push({ name: normName, pct: value });
    }
  }
  const terpenes = pickTopTerpenes(terpPairs, 6);

  // 6) Bucket guess
  const bucket = guessBucketFromText(text);

  return { name, thc: totalThc, bucket, terpenes };
}

/* ================= Start server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Buzz backend listening on :${PORT}`);
});

export default app;
