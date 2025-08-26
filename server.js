// Buzz Tracker Backend — Clean Drop-In v12.2 (ESM)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  GlobalHistogramBinarizer,
} from '@zxing/library';

import Tesseract from 'tesseract.js';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ✅ Multer: define BEFORE any routes that use `upload`
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// Bring in your CJS scraper (returns parsed COA fields)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseCoa } = require('./coa-scraper.cjs');

/* ================= fetch polyfill (Node < 18) ================= */
let _fetch = null;
async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  if (_fetch) return _fetch;
  const mod = await import('node-fetch');
  _fetch = mod.default || mod;
  return _fetch;
}

/* ================= pdf-parse lazy import ================= */
let _pdfParse = null;
async function getPdfParse() {
  if (_pdfParse) return _pdfParse;
  const mod = await import('pdf-parse');
  const fn = mod.default || mod;
  // Return a function that behaves like pdf-parse(buf) → { text, ... }
  _pdfParse = (buf) => fn(buf);
  return _pdfParse;
}

/* ================= App & middleware ================= */
const app = express();
app.use(cors());
app.use(express.json());

// Allow CORS preflight on /api/scan
app.options('/api/scan', cors(), (req, res) => res.sendStatus(204));

/* ================= In-memory "DB" + JSON persistence ================= */
const STRAINS = [];
const toId = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const DATA_DIR  = process.env.DATA_DIR  || path.resolve(process.cwd(), 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'strains.json');

async function ensureDir(p) { try { await fs.mkdir(p, { recursive: true }); } catch {} }
async function ensureDataDir() { return ensureDir(DATA_DIR); }

async function loadDB() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      STRAINS.splice(0, STRAINS.length, ...arr);
      console.log(`[db] loaded ${STRAINS.length} strains from ${DATA_FILE}`);
    }
  } catch {
    console.log('[db] no existing DB, starting fresh');
  }
}
async function saveDB() {
  try {
    await ensureDataDir();
    await fs.writeFile(DATA_FILE, JSON.stringify(STRAINS, null, 2), 'utf8');
  } catch (e) {
    console.warn('[db] save failed:', e?.message || e);
  }
}

function upsertStrain(s) {
  const i = STRAINS.findIndex((x) => String(x.id) === String(s.id));
  if (i >= 0) STRAINS[i] = s;
  else STRAINS.unshift(s);
  saveDB().catch(() => {});
}

function makeId(s = {}) {
  if (s.id) return String(s.id);
  if (s.code) {
    try {
      const u = new URL(String(s.code));
      const last = (u.pathname.split('/').filter(Boolean).pop() || '');
      const digits = last.replace(/\D+/g, '');
      if (digits) return digits;
    } catch {}
  }
  return toId(s.name);
}

/* ===== Normalization helpers (for DB shape) ===== */
function guessNameFromCode(code) {
  try {
    const u = new URL(code);
    const last = (u.pathname.split('/').filter(Boolean).pop() || '').trim();
    if (!last) return null;
    const base = last.replace(/\.(pdf|html?)$/i, '');
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch { return null; }
}
const KNOWN_TERPENES = [
  'Myrcene','Limonene','Caryophyllene','Humulene','Linalool','Pinene','Alpha-Pinene','Beta-Pinene',
  'Terpinolene','Ocimene','Bisabolol','Camphene','Geraniol','Eucalyptol','Nerolidol','Terpineol',
  'Fenchol','Borneol','Isopulegol','Valencene'
];
function normalizeTerpName(name) {
  if (!name) return '';
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
    if (n.includes('beta'))  return 'Beta-Pinene';
    return 'Pinene';
  }
  if (n.includes('ocimene'))   return 'Ocimene';
  if (n.includes('bisabolol')) return 'Bisabolol';
  if (n.includes('terpineol')) return 'Terpineol';
  if (n.includes('nerolidol')) return 'Nerolidol';
  if (n.includes('valencene')) return 'Valencene';
  if (n.includes('eucalyptol') || n.includes('cineole')) return 'Eucalyptol';
  if (n.includes('geraniol'))  return 'Geraniol';
  if (n.includes('fenchol') || n.includes('fenchyl')) return 'Fenchol';
  if (n.includes('borneol'))   return 'Borneol';
  if (n.includes('isopulegol'))return 'Isopulegol';
  if (n.includes('camphene'))  return 'Camphene';
  return String(name).replace(/\s+/g, ' ').trim();
}

function typeToBucket(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('indi')) return 'indica_leaning';
  if (t.startsWith('sati')) return 'sativa_leaning';
  return 'hybrid';
}
function bucketToLean(bucket) {
  return bucket === 'indica_leaning' ? 'Indica-leaning'
       : bucket === 'sativa_leaning' ? 'Sativa-leaning'
       : '';
}

/** map scraper output -> normalizeStrain input shape (now includes type -> bucket/lean) */
function coalesceParsedToStrain(parsed, url) {
  const name = parsed?.strain || guessNameFromCode(url) || 'Unknown Strain';
  const terps = [parsed?.dominantTerpene, ...(parsed?.otherTerpenes || [])]
    .filter(Boolean)
    .map(normalizeTerpName);
  const thc   = parsed?.thc?.totalPercent ?? undefined;
  const type  = parsed?.type || null; // take type from scraper if present
  const bucket = parsed?.bucket || (type ? typeToBucket(type) : 'hybrid');
  const lean   = bucketToLean(bucket);
  return { code: url, name, thc, bucket, lean, terpenes: terps, type };
}

function normalizeStrain(s) {
  const terps = Array.isArray(s.terpenes)
    ? s.terpenes
    : (s.terpenes ? String(s.terpenes).split(/[;,|\n\r]+/).map(x => x.trim()).filter(Boolean) : []);
  const top3 = terps.slice(0, 3);
  const bucket = s.bucket || (s.type ? typeToBucket(s.type) : 'hybrid');
  const lean   = s.lean || bucketToLean(bucket);
  return {
    id: makeId(s),
    code: s.code || undefined,
    name: s.name,
    thc: s.thc == null ? undefined : Math.round(Number(String(s.thc).replace(/[^0-9.]/g, ''))),
    bucket,
    lean,
    type: s.type || undefined,      // keep type in DB
    terpenes: top3,
    dominantTerpene: top3[0] || ''
  };
}

/* ================= Helpers used by scanner ================= */
function rgbaToLuminance(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    out[j] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
  }
  return out;
}
function looksLikeUrl(s) { try { new URL(s); return true; } catch { return false; } }

function guessBucketFromText(text) {
  const m = text.match(/\b(Sativa|Indica|Hybrid)\b/i);
  if (!m) return 'hybrid';
  const v = m[1].toLowerCase();
  if (v === 'sativa') return 'sativa_leaning';
  if (v === 'indica') return 'indica_leaning';
  return 'hybrid';
}

// --- Type helpers (single copy) ---
const TYPE_MAP = { I: 'Indica', H: 'Hybrid', S: 'Sativa' };
function parseType(text) {
  if (!text) return null;
  // TRU-Flower-...-I-FL or -H-FL or -S-FL
  let m = text.match(/-([IHS])-[A-Z]{2}\b/);
  if (m) return TYPE_MAP[m[1].toUpperCase()] || null;
  // Fallback: words anywhere
  m = text.match(/\b(Indica|Sativa|Hybrid)\b/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return null;
}
function bucketFromType(t) {
  if (!t) return 'hybrid';
  if (t === 'Indica') return 'indica_leaning';
  if (t === 'Sativa') return 'sativa_leaning';
  return 'hybrid';
}

function pickTopTerpenes(pairs, max = 3) {
  const sorted = pairs
    .filter(p => Number.isFinite(p.pct) && p.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  return sorted.slice(0, max).map(p => p.name);
}

function detectColumnUnit(lines) {
  const unitHeader = lines.find(l => /\bresult\s*\((%|mg\/g|ppm|µg\/g|ug\/g)\)/i.test(l));
  if (unitHeader) {
    const m = unitHeader.match(/\bresult\s*\((%|mg\/g|ppm|µg\/g|ug\/g)\)/i);
    if (m) return m[1].toLowerCase();
  }
  const unitLine = lines.find(l => /\bunits?\s*:\s*(%|mg\/g|ppm|µg\/g|ug\/g)\b/i.test(l));
  if (unitLine) {
    const m = unitLine.match(/\bunits?\s*:\s*(%|mg\/g|ppm|µg\/g|ug\/g)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}
function toPercent(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (!unit || unit === '%') return value;
  unit = unit.toLowerCase();
  if (unit.includes('mg/g')) return +(value * 0.1).toFixed(3);
  if (unit.includes('ppm') || unit.includes('µg/g') || unit.includes('ug/g'))
    return +(value / 10000).toFixed(4);
  return value;
}

function buildTerpNameRegex() {
  const names = KNOWN_TERPENES.map(t => {
    const base = t
      .replace('Alpha-', '(?:Alpha-|α-)')
      .replace('Beta-',  '(?:Beta-|β-)')
      .replace('-',      '[ \\-]?');
    return base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  names.push('terpinolene','terpen[eo]l','terpene','pinene','myrcene','ocimene','humulene','caryophyllene','limonene','linalool','bisabolol','nerolidol','valencene','camphene','geraniol','eucalyptol','borneol','isopulegol','fenchol');
  return new RegExp(`\\b(${names.join('|')})\\b`, 'i');
}
const TERP_NAME_RE = buildTerpNameRegex();

function extractTerpenesSmart(raw, lines) {
  const defaultUnit = detectColumnUnit(lines);
  const pairs = [];

  for (const line of lines) {
    if (!TERP_NAME_RE.test(line)) continue;
    const m = line.match(/([A-Za-zα-ωΑ-Ωµμ()\/+.\- ]+?)\s*(?:[:\-–•·]|\s{2,})?\s*([0-9]+(?:\.[0-9]+)?|\.[0-9]+)\s*(%|mg\/g|ppm|µg\/g|ug\/g)?\b/i);
    if (!m) continue;
    const rawName = m[1].trim();
    const val = parseFloat(m[2]);
    const unit = (m[3] || defaultUnit || '%').toLowerCase();

    const normName = normalizeTerpName(rawName);
    const pct = toPercent(val, unit);
    if (!normName || !Number.isFinite(pct)) continue;
    if (!KNOWN_TERPENES.some(k => normName.toLowerCase().includes(k.toLowerCase()))) continue;
    pairs.push({ name: normName, pct });
  }

  if (!pairs.length) {
    const dom = raw.match(/Dominant\s*Terpenes?\s*:\s*([^\n\r]+)/i);
    if (dom) {
      const names = dom[1].split(/[;,|]/).map(s => normalizeTerpName(s.trim())).filter(Boolean);
      const uniq = [...new Set(names)];
      return uniq.slice(0, 3);
    }
    for (const terp of KNOWN_TERPENES) {
      const re = new RegExp(`${terp.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n\\r]{0,40}?([0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)\\s*(%|mg\\/g|ppm|µg\\/g|ug\\/g)?`, 'i');
      const m = raw.match(re);
      if (m) {
        const pct = toPercent(parseFloat(m[1]), (m[2] || defaultUnit || '%'));
        if (Number.isFinite(pct)) pairs.push({ name: normalizeTerpName(terp), pct });
      }
    }
  }

  return pickTopTerpenes(pairs, 3);
}

/* ================= OCR & fetch helpers ================= */
async function ocrExtractUrlOrBatch(buf, maxMs = 12000) {
  const t0 = Date.now();
  let base = sharp(buf).grayscale().normalize().sharpen();
  const meta = await base.metadata();
  const minW = 1200;
  if ((meta.width || 0) < minW) base = base.resize({ width: minW });

  const angles = [0, -6, 6, -10, 10];
  const variants = [
    (img) => img,
    (img) => img.modulate({ brightness: 1.25 }),
    (img) => img.linear(1.25, -5),
    (img) => img.threshold(150),
    (img) => img.threshold(190),
    (img) => img.blur(0.4).threshold(165),
  ];
  function findFromText(text) {
    if (!text) return null;
    const direct = text.match(/https?:\/\/[^\s]+?\.pdf\b/i);
    if (direct) return direct[0];
    const mBatch = text.match(/\b(\d{5})[ _-]?(\d{7,})\b/);
    if (mBatch) {
      const a = mBatch[1];
      const b = mBatch[2];
      return `https://www.trulieve.com/content/dam/trulieve/en/lab-reports/${a}_${b}.pdf`;
    }
    return null;
  }
  for (const deg of angles) {
    for (const v of variants) {
      if (Date.now() - t0 > maxMs) return null;
      let img = base.clone().rotate(deg);
      try { img = v(img); } catch {}
      const pre = await img.toBuffer();
      try {
        const { data } = await Tesseract.recognize(pre, 'eng', {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_:/.-',
          preserve_interword_spaces: '1',
        });
        const text = (data?.text || '').replace(/\r/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const found = findFromText(text);
        if (found) return found;
      } catch {}
    }
  }
  return null;
}

async function fetchPdfWithHeaders(url) {
  const f = await getFetch();
  let resp = await f(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      'Accept': 'application/pdf,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });
  if (!resp.ok && (resp.status === 403 || resp.status === 406 || resp.status === 503)) {
    resp = await f(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Accept': 'application/pdf,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.trulieve.com/',
      },
    });
  }
  return resp;
}

/* ================= Scrapers used by scanner resolve ================= */
async function scrapeTrulieveLabPdf(url) {
  const resp = await fetchPdfWithHeaders(url);
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());

  const pdfParse = await getPdfParse();
  const { text: pdfText } = await pdfParse(buf);
  const raw = (pdfText || '').replace(/\r/g, '');
  const text = raw.replace(/[ \t]+/g, ' ');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

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

  let totalThc;
  const mTotal = text.match(/Total\s*(?:Δ?9|Delta[-\s]?9)?\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i);
  if (mTotal) {
    const val = parseFloat(mTotal[1]);
    const unit = (mTotal[2] || '%').toLowerCase();
    totalThc = unit.includes('%') ? val : val / 10;
  } else {
    const pick = (re) => {
      const m = text.match(re);
      if (!m) return undefined;
      const v = parseFloat(m[1]);
      const unit = (m[2] || '%').toLowerCase();
      return unit.includes('%') ? v : v / 10;
    };
    const thca = pick(/\bTHC-?A\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i);
    const d9   = pick(/(?:Δ?9|Delta[-\s]?9)\s*THC\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i)
              ?? pick(/\bTHC\b\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(%|mg\s*\/\s*g)?/i);
    const thcaVal = Number.isFinite(thca) ? thca : 0;
    const d9Val   = Number.isFinite(d9) ? d9 : 0;
    if (thcaVal || d9Val) totalThc = Number((0.877 * thcaVal + d9Val).toFixed(1));
  }

  let terpenes = extractTerpenesSmart(raw, lines);
  if (!terpenes.length) {
    terpenes = extractTerpenesSmart(raw.replace(/[ \t]+/g, ' '), lines);
  }

  // Detect type from the header (…-I-FL / -H- / -S-) OR words on page
  const type = parseType(text);
  const bucket = type ? typeToBucket(type) : guessBucketFromText(text);

  return { name, thc: totalThc, bucket, type, terpenes };
}

function looksLikePdfUrl(u) {
  try { const x = new URL(u); return x.pathname.toLowerCase().endsWith('.pdf'); } catch { return false; }
}

async function scrapeFromCode(code) {
  const codeStr = String(code || '');
  if (looksLikeUrl(codeStr)) {
    try {
      const u = new URL(codeStr);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (host.includes('trulieve.com') && path.endsWith('.pdf')) {
        const r = await scrapeTrulieveLabPdf(codeStr);
        if (r) return r;
      }
    } catch {}
  }
  if (codeStr.toLowerCase().includes('wedding-cake')) {
    return { name: 'Wedding Cake', thc: 23, bucket: 'hybrid', type: 'Hybrid', terpenes: ['Caryophyllene','Limonene','Humulene'] };
  }
  return null;
}

/* ================= API: simple health & list ================= */
app.get('/', (req, res) => res.send('Buzz backend is running. Try /api/strains'));
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));
app.get('/api/strains', (req, res) => {
  const total = STRAINS.length;

  // Parse query params
  const offsetRaw = req.query.offset;
  const limitRaw  = req.query.limit;

  const offset = Math.max(0, Number.isFinite(+offsetRaw) ? parseInt(offsetRaw, 10) : 0);

  // If limit is not provided, return everything from offset
  const computedDefault = Math.max(0, total - offset);
  const limitParam = (limitRaw === undefined || limitRaw === null || limitRaw === '')
    ? computedDefault
    : parseInt(limitRaw, 10);

  // Per-response ceiling only; DOES NOT cap storage size.
  const limit = Math.max(1, Math.min(5000, Number.isFinite(+limitParam) ? limitParam : computedDefault));

  // Optional: paging metadata
  res.set('X-Total-Count', String(total));

  res.json(STRAINS.slice(offset, offset + limit));
});

/* ================= API: COA ingestion ================= */
// Minimal: return scraper output (no DB write) — supports POST and GET
app.post('/api/ingest-coa', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const parsed = await parseCoa(url);
    return res.json(parsed); // parsed includes "type" if scraper implements it
  } catch (e) {
    return res.status(500).json({ error: 'ingest_failed', detail: String(e?.message || e) });
  }
});
app.get('/api/ingest-coa', async (req, res) => {
  try {
    const url = String(req.query?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const parsed = await parseCoa(url);
    return res.json(parsed);
  } catch (e) {
    return res.status(500).json({ error: 'ingest_failed', detail: String(e?.message || e) });
  }
});

// Save-on-scan: parse the URL, normalize it, UPSERT into your strains list, return it
app.post('/api/scan', async (req, res) => {
  try {
    const url = String(req.body?.url || req.body?.link || '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const parsed = await parseCoa(url);
    const normalizedInput = coalesceParsedToStrain(parsed, url);
    const norm = normalizeStrain(normalizedInput);

    upsertStrain(norm);
    return res.json({ strain: norm, saved: true });
  } catch (e) {
    console.error('scan error', e);
    return res.status(500).json({ error: 'scan_failed', detail: String(e?.message || e) });
  }
});

/* ================= API: resolver & CRUD ================= */
function safeDecode(s) { try { return decodeURIComponent(String(s)); } catch { return String(s); } }

app.get('/api/strains/resolve', async (req, res) => {
  const raw = typeof req.query.code === 'string' ? req.query.code : '';
  const code = safeDecode(raw).trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const data = await scrapeFromCode(code);
    if (!data) return res.status(404).json({ error: 'Not found' });
    const norm = normalizeStrain({ ...data, code });
    if (String(req.query.upsert || '') === '1') upsertStrain(norm);
    return res.json(norm);
  } catch (err) {
    return res.status(500).json({ error: 'resolve_failed', detail: String(err?.message || err) });
  }
});

app.get('/api/strains/:id', (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  const s = STRAINS.find(x => String(x.id).toLowerCase() === id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json(s);
});

app.post('/api/strains', (req, res) => {
  const { code, name, thc, bucket, lean, terpenes, type } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const strain = normalizeStrain({ code: safeDecode(code || ''), name, thc, bucket, lean, terpenes, type });
  upsertStrain(strain);
  return res.status(201).json(strain);
});

/* ================= API: photo scan (QR/COA code) ================= */
app.post('/api/strains/scan-upload', upload.single('image'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const budgetMs = Math.max(1000, Math.min(60000, Number(req.query.budget_ms || process.env.SCAN_BUDGET_MS || 12000)));
    const mode = String(req.query.mode || 'auto').toLowerCase(); // 'fast' | 'auto'
    const debugSave = String(req.query.debug_save || '') === '1';
    const skipOcr = String(req.query.skip_ocr || '') === '1';

    const debugDir = path.join(DATA_DIR, 'debug', `scan_${Date.now()}`);
    if (debugSave) await ensureDir(debugDir);
    let attempts = 0;
    async function saveAttempt(img, tag) {
      if (!debugSave) return;
      try {
        const p = path.join(debugDir, `attempt_${String(++attempts).padStart(3,'0')}_${tag}.png`);
        await img.png().toFile(p);
      } catch {}
    }

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.AZTEC,
      BarcodeFormat.DATA_MATRIX, BarcodeFormat.PDF_417
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new MultiFormatReader();
    reader.setHints(hints);

    // Pre-resize & grayscale
    let base0 = sharp(req.file.buffer).grayscale().normalize();
    const meta0 = await base0.metadata();
    const maxDim = 1800;
    const needResize = Math.max(meta0.width || 0, meta0.height || 0) > maxDim;
    if (needResize) {
      base0 = base0.resize({ width: meta0.width >= meta0.height ? maxDim : undefined, height: meta0.height > meta0.width ? maxDim : undefined });
    }

    const fastRotations = [0, 90];
    const fastPre = [ (img)=> img, (img)=> img.sharpen() ];
    const fastUp = [1, 1.5, 2];
    const minShortFast = 900;

    const microAngles = [-8, -4, 0, 4, 8];
    const baseAngles = [0, 90, 180, 270];
    const heavyAngles = baseAngles.flatMap(b => microAngles.map(m => b + m));
    const heavyCrops = [1.0, 0.92, 0.85, 0.75, 0.65];
    const anchors = [
      { name:'center', ax:0.5, ay:0.5 },
      { name:'tl', ax:0.0, ay:0.0 },
      { name:'tr', ax:1.0, ay:0.0 },
      { name:'bl', ax:0.0, ay:1.0 },
      { name:'br', ax:1.0, ay:1.0 },
    ];
    const heavyPre = [
      (img)=> img, (img)=> img.sharpen(), (img)=> img.gamma(1.2), (img)=> img.linear(1.25, 0),
      (img)=> img.modulate({ brightness: 1.18, saturation: 1.04 }), (img)=> img.blur(0.5),
      (img)=> img.threshold(140), (img)=> img.threshold(170), (img)=> img.threshold(200),
    ];
    const heavyUp = [1, 1.5, 2, 3, 4];
    const minShortHeavy = 1300;

    const tEnd = () => (Date.now() - t0) > budgetMs;

    async function tryDecodeFrom(img, minShort, upscales, tag) {
      const m2 = await img.metadata();
      for (const scale of upscales) {
        const shortEdge = Math.min(m2.width || 0, m2.height || 0);
        const factor = shortEdge > 0 ? Math.max(1, Math.ceil((minShort / shortEdge) * scale)) : 1;
        const targetW = Math.max(48, Math.round((m2.width || minShort) * factor));
        const piped = img.clone().resize({ width: targetW }).ensureAlpha();
        await saveAttempt(piped.clone(), `${tag}_resize${targetW}`);

        const { data, info } = await piped.raw().toBuffer({ resolveWithObject: true });
        const luminance = rgbaToLuminance(data, info.width, info.height);
        const source = new RGBLuminanceSource(luminance, info.width, info.height);
        const attemptsHere = [
          new BinaryBitmap(new HybridBinarizer(source)),
          new BinaryBitmap(new GlobalHistogramBinarizer(source)),
        ];

        for (const bitmap of attemptsHere) {
          try {
            const result = reader.decode(bitmap);
            const text = String(result.getText() || '').trim();
            if (text) return text;
          } catch {}
          if (tEnd()) return null;
        }
      }
      return null;
    }

    // FAST mode first
    for (const deg of fastRotations) {
      let base = base0.clone().rotate(deg);
      for (const tweak of fastPre) {
        let img; try { img = tweak(base.clone()); } catch { continue; }
        const got = await tryDecodeFrom(img, minShortFast, fastUp, `fast_rot${deg}`);
        if (got) {
          const resolved = await scrapeFromCode(got);
          if (resolved) {
            const norm = normalizeStrain({ ...resolved, code: got });
            upsertStrain(norm);
            return res.json({ code: got, status: 'resolved', mode: 'fast', ms: Date.now()-t0, strain: norm });
          }
          if (String(req.query.autocreate || '') === '1') {
            const created = normalizeStrain({ code: got, name: guessNameFromCode(got) || 'Unknown Strain', thc: undefined, bucket: 'hybrid', terpenes: [] });
            upsertStrain(created);
            return res.json({ code: got, status: 'created', mode: 'fast', ms: Date.now()-t0, strain: created });
          }
          return res.status(404).json({ code: got, status: 'not_found', mode: 'fast', ms: Date.now()-t0 });
        }
        if (tEnd()) break;
      }
      if (tEnd()) break;
    }
    if (mode === 'fast') {
      return res.status(422).json({ error: 'Decode failed', detail: 'fast_path_exhausted', ms: Date.now()-t0 });
    }

    // HEAVY fallback
    for (const deg of heavyAngles) {
      let base = base0.clone().rotate(deg);
      const meta = await base.metadata();
      const W = meta.width || 0, H = meta.height || 0;
      if (!W || !H) continue;

      for (const cropFactor of heavyCrops) {
        for (const a of anchors) {
          let work = base;
          if (cropFactor < 1.0) {
            const s0 = Math.min(W, H) * cropFactor;
            const s  = Math.max(2, Math.floor(s0));
            const left = Math.max(0, Math.min(W - s, Math.round((W - s) * a.ax)));
            const top  = Math.max(0, Math.min(H - s, Math.round((H - s) * a.ay)));
            try { work = base.extract({ left, top, width: s, height: s }); } catch { work = base; }
          }

          for (const tweak of heavyPre) {
            let img; try { img = tweak(work.clone()); } catch { continue; }
            const tag = `heavy_rot${deg}_crop${Math.round(cropFactor*100)}_${a.name}_${tweak.name||'fx'}`;
            const got = await tryDecodeFrom(img, minShortHeavy, heavyUp, tag);
            if (got) {
              const resolved = await scrapeFromCode(got);
              if (resolved) {
                const norm = normalizeStrain({ ...resolved, code: got });
                upsertStrain(norm);
                return res.json({ code: got, status: 'resolved', mode: 'heavy', ms: Date.now()-t0, strain: norm });
              }
              if (String(req.query.autocreate || '') === '1') {
                const created = normalizeStrain({ code: got, name: guessNameFromCode(got) || 'Unknown Strain', thc: undefined, bucket: 'hybrid', terpenes: [] });
                upsertStrain(created);
                return res.json({ code: got, status: 'created', mode: 'heavy', ms: Date.now()-t0, strain: created });
              }
              return res.status(404).json({ code: got, status: 'not_found', mode: 'heavy', ms: Date.now()-t0 });
            }
            if (tEnd()) break;
          }
          if (tEnd()) break;
        }
        if (tEnd()) break;
      }
      if (tEnd()) break;
    }

    // OCR fallback
    if (!skipOcr) {
      const ocrUrl = await ocrExtractUrlOrBatch(await base0.clone().toBuffer(), Math.max(4000, Math.floor(budgetMs * 0.6)));
      if (ocrUrl) {
        const r = await scrapeFromCode(ocrUrl);
        if (r) {
          const norm = normalizeStrain({ ...r, code: ocrUrl });
          upsertStrain(norm);
          return res.json({ code: ocrUrl, status: 'resolved_via_ocr', mode: 'ocr', ms: Date.now()-t0, strain: norm });
        } else {
          return res.status(404).json({ code: ocrUrl, status: 'not_found_via_ocr', mode: 'ocr', ms: Date.now()-t0 });
        }
      }
    }

    return res.status(422).json({ error: 'Decode failed', detail: 'budget_exhausted', ms: Date.now()-t0 });
  } catch (e) {
    return res.status(422).json({ error: 'Decode failed', detail: String(e?.message || e) });
  }
});

/* ================= Debug endpoints ================= */
app.get('/api/debug/echo', (req, res) => {
  const raw = String(req.query.code || '');
  let decoded = raw; try { decoded = decodeURIComponent(raw); } catch {}
  res.json({ raw, decoded });
});

app.get('/api/debug/fetch', async (req, res) => {
  const raw = String(req.query.url || '');
  let url = raw; try { url = decodeURIComponent(raw); } catch {}
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const r = await fetchPdfWithHeaders(url);
    const ok = r.ok, status = r.status, statusText = r.statusText;
    const ct = r.headers.get('content-type');
    let bodyPreview = '';
    try {
      const ab = await r.arrayBuffer();
      const slice = Buffer.from(ab).subarray(0, 512);
      bodyPreview = slice.toString('base64');
    } catch {}
    res.json({ ok, status, statusText, contentType: ct, bodyPreviewBase64: bodyPreview });
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', detail: String(e?.message || e) });
  }
});

app.get('/api/debug/terps', async (req, res) => {
  const rawUrl = String(req.query.url || '');
  if (!rawUrl) return res.status(400).json({ error: 'Missing url' });
  try {
    const r = await fetchPdfWithHeaders(rawUrl);
    if (!r.ok) return res.status(502).json({ ok: false, status: r.status, statusText: r.statusText });
    const buf = Buffer.from(await r.arrayBuffer());
    const pdfParse = await getPdfParse();
    const { text: pdfText } = await pdfParse(buf);
    const raw = (pdfText || '').replace(/\r/g, '');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const defaultUnit = detectColumnUnit(lines);
    const terps = extractTerpenesSmart(raw, lines);
    res.json({ ok: true, defaultUnit, terps, preview: lines.slice(0, 40) });
  } catch (e) {
    res.status(500).json({ error: 'terp_debug_failed', detail: String(e?.message || e) });
  }
});

// OCR-only debug: upload a photo, get raw OCR text + detected URL/batch
const debugUpload = multer({ storage: multer.memoryStorage() });
app.post('/api/debug/ocr', debugUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const urlOrBatch = await ocrExtractUrlOrBatch(req.file.buffer, 12000);

    let base = sharp(req.file.buffer).grayscale().normalize().sharpen();
    const meta = await base.metadata();
    if ((meta.width || 0) < 1200) base = base.resize({ width: 1200 });
    const pre = await base.toBuffer();

    const { data } = await Tesseract.recognize(pre, 'eng', {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_:/.-',
      preserve_interword_spaces: '1',
    });
    const text = (data?.text || '').replace(/\r/g, ' ').replace(/[ \t]+/g, ' ').trim();

    res.json({ ok: true, urlOrBatch, textPreview: text.slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: 'ocr_debug_failed', detail: String(e?.message || e) });
  }
});

/* ================= Start server (load DB first) ================= */
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

function getLAN() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

(async () => {
  await ensureDataDir();
  await loadDB();
  app.listen(PORT, HOST, () => {
    const lan = getLAN();
    console.log(`Buzz backend listening on http://${HOST}:${PORT}`);
    console.log(`LAN URL (use on your phone): http://${lan}:${PORT}`);
  });
})();

export default app;
