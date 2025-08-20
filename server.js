import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import pdf from 'pdf-parse';

import {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from '@zxing/library';

const app = express();
app.use(cors());
app.use(express.json());

/** ================= In-memory "DB" ================= */
const STRAINS = [];
const toId = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** ================= API Endpoints ================= */
// List
app.get('/api/strains', (req, res) => res.json(STRAINS));

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

/** -------- Trulieve Lab PDF scraper -------- */
async function scrapeTrulieveLabPdf(url) {
  // 1) Download PDF
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());

  // 2) Extract text
  const pdfData = await pdf(buf);
  const textRaw = (pdfData.text || '').replace(/\r/g, '');
  const text = textRaw.replace(/[ \t]+/g, ' '); // compress spaces

  // 3) Strain/Product name
  let name =
    (text.match(/(?:Strain|Product Name|Product):\s*([^\n]+)\n/i)?.[1] ||
     text.match(/(?:Item|Sample Name):\s*([^\n]+)\n/i)?.[1] || null);
  if (name) name = name.replace(/\s+/g,' ').trim();
  if (!name) name = guessNameFromCode(url) || 'Unknown Strain';

  // 4) THC (prefer "Total THC")
  let thc;
  const mTotalTHC = text.match(/Total\s*THC[:\s]*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  const mAlt = text.match(/\bTHC\b[^%]{0,40}([0-9]+(?:\.[0-9]+)?)\s*%/i); // fallback
  if (mTotalTHC) thc = Number(mTotalTHC[1]);
  else if (mAlt) thc = Number(mAlt[1]);

  // 5) Terpenes (lines like "Limonene 0.45%" or "β-Caryophyllene 0.25%")
  const terpPairs = [];
  for (const line of text.split('\n')) {
    const m = line.match(/([A-Za-zµβ\- ]+?)\s+([0-9]+(?:\.[0-9]+)?)\s*%/);
    if (!m) continue;
    const raw = m[1].trim();
    const pct = Number(m[2]);
    const norm = normalizeTerpName(raw);
    if (KNOWN_TERPENES.some(k => norm.toLowerCase().includes(k.toLowerCase()))) {
      terpPairs.push({ name: norm, pct });
    }
  }
  const terpenes = pickTopTerpenes(terpPairs, 6);

  // 6) Bucket guess
  const bucket = guessBucketFromText(text);

  return { name, thc, bucket, terpenes };
}

function guessNameFromCode(code) {
  try {
    const u = new URL(code);
    const slug = u.pathname.split('/').filter(Boolean).pop();
    if (slug) return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch {}
  return null;
}

/** ================= Start ================= */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Buzz backend listening on http://localhost:${port}`);
});
