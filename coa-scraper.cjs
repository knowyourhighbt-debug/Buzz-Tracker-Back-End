#!/usr/bin/env node
'use strict';

/**
 * COA Scraper — minimal fields (top-3 terps + THC)
 * Returns:
 *   - strain: string | null
 *   - type: string | null                // NEW (Sativa | Indica | Hybrid, or product form)
 *   - dominantTerpene: string | null
 *   - otherTerpenes: string[]            // up to 2 others (top-3 total)
 *   - thc: { totalPercent: number|null } // "Total (Active) THC" or computed from THCa + Δ9
 *
 * Deps: npm i undici pdf-parse cheerio
 * Usage: node coa-scraper.cjs "<COA URL>"
 */

const { fetch } = require('undici');
const pdfParse = require('pdf-parse');
const cheerio  = require('cheerio');

/* -------------------- Known terpenes & synonyms -------------------- */
const KNOWN_TERPENES = [
  'myrcene','limonene','linalool','terpinolene','caryophyllene','humulene',
  'alpha-pinene','beta-pinene','pinene','ocimene','farnesene','nerolidol',
  'bisabolol','eucalyptol','camphene','borneol','caryophyllene-oxide','cedrol',
  'guaiol','sabinene','terpineol','geraniol','isopulegol','pulegone','phytol','fenchyl alcohol'
];

const SYN = Object.freeze({
  'β-caryophyllene': 'caryophyllene',
  'b-caryophyllene': 'caryophyllene',
  'beta-caryophyllene': 'caryophyllene',
  'caryophyllene oxide': 'caryophyllene-oxide',
  'α-humulene': 'humulene',
  'a-humulene': 'humulene',
  'd-limonene': 'limonene',
  '1,8-cineole': 'eucalyptol',
  'α-pinene': 'alpha-pinene',
  'a-pinene': 'alpha-pinene',
  'β-pinene': 'beta-pinene',
  'b-pinene': 'beta-pinene',
  'trans-caryophyllene': 'caryophyllene',
  'fenchol': 'fenchyl alcohol',
  'β-myrcene': 'myrcene',
  'b-myrcene': 'myrcene'
});

/* -------------------- Utils -------------------- */
function isPdfBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}
function toFloatSafe(x) {
  if (x == null) return null;
  const m = String(x).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function unitFrom(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/%/.test(t)) return '%';
  if (/mg\s*\/\s*g/.test(t)) return 'mg/g';
  if (/µg\s*\/\s*g|ug\s*\/\s*g/.test(t)) return 'ug/g';
  return null;
}
const mgPerGToPercent = (x) => (x==null?null:(x/10));     // ~1% ≈ 10 mg/g
const ugPerGToPercent = (x) => (x==null?null:(x/10000));  // 10,000 µg/g == 1%

function canonTerp(name) {
  if (!name) return null;
  const raw = name.toLowerCase().trim();
  if (SYN[raw]) return SYN[raw];
  if (/alpha[-\s]?pinene|a[-\s]?pinene/i.test(name)) return 'alpha-pinene';
  if (/beta[-\s]?pinene|b[-\s]?pinene/i.test(name)) return 'beta-pinene';
  if (/\bpinene\b/i.test(name)) return 'pinene';
  const greek = raw.replace(/α/g,'alpha-').replace(/β/g,'beta-');
  for (const t of KNOWN_TERPENES) if (greek.includes(t)) return t;
  return raw;
}
function hasPercentContext(text) {
  return /(Result\s*%\s*\(total\)|Amount\s*\(%\s*(?:w\/w|wt\/wt)?\)|%\s*(?:w\/w|wt\/wt)|% of total terpenes|percent of total)/i.test(text);
}
function fixPercentOverflow(v) {
  if (v == null) return v;
  while (v > 100) v = v / 10;
  return v;
}
function joinWeirdDecimals(s) {
  return s
    .replace(/(\d)\s*[.,]\s*(\d{2,4})/g, '$1.$2')
    .replace(/(\d)\s+(\d{2,4})(?=\s*[%\b])/g, '$1.$2');
}

/* -------------------- Fetch & text -------------------- */
async function fetchDoc(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const isPdf = /application\/pdf/i.test(ct) || isPdfBuffer(buf) || /\.pdf(\?|$)/i.test(url);
  return { type: isPdf ? 'pdf' : 'html', buffer: buf, contentType: ct, url };
}
async function pdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

/* -------------------- Parsers -------------------- */
function parseStrain(text) {
  const pats = [
    /\bStrain\s*[:\-]\s*(.+)/i,
    /\bCultivar\(s\)?\s*[:\-]\s*(.+)/i,
    /\bSample\s*Alias\s*[:\-]\s*(.+)/i,
    /\bProduct\s*Name\s*[:\-]\s*(.+)/i,
    /\bCultivars?\s*[:\-]\s*(.+)/i
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) return m[1].replace(/\r|\n/g,' ').replace(/\s{2,}/g,' ').trim();
  }
  return null;
}

function collectTerpenesAsPercent(text) {
  const percentByHeader = hasPercentContext(text);
  const lines = text.split(/\r?\n/);
  const rows = [];

  const nameRegex =
    /([A-Za-zµβα\-\.\/\(\)\s]*?(?:caryophyllene|pinene|myrcene|limonene|linalool|humulene|terpinolene|ocimene|farnesene|nerolidol|bisabolol|eucalyptol|fenchyl(?:\s+alcohol)?))/i;

  for (let rawLine of lines) {
    let line = joinWeirdDecimals(rawLine.replace(/\s{2,}/g, ' ').trim());
    if (!nameRegex.test(line)) continue;

    const nm = line.match(nameRegex);
    if (!nm) continue;
    const name = canonTerp(nm[1]);
    if (!name) continue;

    const nums = [...line.matchAll(/(-?\d{1,3})(?:\s*[.,]\s*(\d{1,4}))?\s*(%|mg\s*\/\s*g|µg\s*\/\s*g|ug\s*\/\s*g)?/gi)];
    if (!nums.length) continue;

    let pick = nums.find(n => (n[3] || '').includes('%'));
    if (!pick) pick = nums.find(n => (n[3] || '').toLowerCase().includes('mg'));
    if (!pick) pick = nums.find(n => (n[3] || '').toLowerCase().includes('g'));
    if (!pick && percentByHeader) pick = nums[nums.length - 1];
    if (!pick) continue;

    const whole = pick[1];
    const frac  = pick[2] || '';
    let val = toFloatSafe(frac ? `${whole}.${frac}` : whole);

    let unit = unitFrom(pick[3] || '');
    if (!unit && percentByHeader) unit = '%';
    if (val == null || !unit) continue;

    if (unit === '%') val = fixPercentOverflow(val);
    else if (unit === 'mg/g') val = mgPerGToPercent(val);
    else if (unit === 'ug/g') val = ugPerGToPercent(val);
    else continue;

    if (val != null && !Number.isNaN(val)) rows.push({ name, percent: val });
  }

  const best = new Map();
  for (const r of rows) {
    const prev = best.get(r.name);
    if (!prev || r.percent > prev.percent) best.set(r.name, r);
  }
  return [...best.values()];
}

function pickTopTerpenes(text, limit = 3) {
  const rows = collectTerpenesAsPercent(text);
  if (!rows.length) return [];

  rows.sort((a,b)=>b.percent - a.percent);

  const hasAlpha = rows.some(r => r.name === 'alpha-pinene');
  const hasBeta  = rows.some(r => r.name === 'beta-pinene');
  if (hasAlpha || hasBeta) {
    for (const r of rows) {
      if (r.name === 'pinene') r.percent = r.percent * 0.5;
    }
    rows.sort((a,b)=>b.percent - a.percent);
  }

  return rows.slice(0, limit).map(r => r.name);
}

/* ---------- THC parsing ---------- */
function normalizeForTHC(text) {
  return joinWeirdDecimals(text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' '));
}
function firstNumber(re, s) {
  const m = s.match(re);
  return m ? toFloatSafe(m[1]) : null;
}
function parseTHC(text) {
  const flat = normalizeForTHC(text);

  let pct = firstNumber(/\bTotal\s+(?:Active\s+)?THC\b[^0-9]{0,40}(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i, flat);
  if (pct != null) return { totalPercent: pct };

  let mg = firstNumber(/\bTotal\s+(?:Active\s+)?THC\b[^0-9]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s*mg\s*\/\s*g/i, flat);
  if (mg != null) return { totalPercent: mgPerGToPercent(mg) };

  let thcaPct = firstNumber(/\bTHC[\s\-]?A\b[^0-9]{0,40}(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i, flat)
             ?? firstNumber(/\bTHCa\b[^0-9]{0,40}(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i, flat);
  let d9Pct   = firstNumber(/\b(?:Delta|Δ)\s*[-]?\s*9\s*[-]?\s*THC\b[^0-9]{0,40}(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i, flat)
             ?? firstNumber(/\bD(?:elta)?-?9\b[^0-9]{0,40}(\d{1,2}(?:[.,]\d{1,2})?)\s*%/i, flat);

  let thcaMg  = firstNumber(/\bTHC[\s\-]?A\b[^0-9]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s*mg\s*\/\s*g/i, flat)
             ?? firstNumber(/\bTHCa\b[^0-9]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s*mg\s*\/\s*g/i, flat);
  let d9Mg    = firstNumber(/\b(?:Delta|Δ)\s*[-]?\s*9\s*[-]?\s*THC\b[^0-9]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s*mg\s*\/\s*g/i, flat)
             ?? firstNumber(/\bD(?:elta)?-?9\b[^0-9]{0,40}(\d{1,3}(?:[.,]\d{1,2})?)\s*mg\s*\/\s*g/i, flat);

  let thca = thcaPct ?? (thcaMg!=null ? mgPerGToPercent(thcaMg) : null);
  let d9   = d9Pct   ?? (d9Mg  !=null ? mgPerGToPercent(d9Mg)   : null);

  if (thca!=null || d9!=null) {
    return { totalPercent: +(0.877*(thca ?? 0) + (d9 ?? 0)).toFixed(2) };
  }
  return { totalPercent: null };
}

/* -------------------- Type extractors -------------------- */
function pickSih(text) {
  const m = text.match(/\b(Sativa|Indica|Hybrid)\b/i);
  return m ? m[1] : null;
}
function pickTypeRow(text) {
  const m = text.match(/\bType\s*[:\-]\s*([^\n]+?)(?=\s{2,}|\n|$)/i);
  return m ? m[1].trim() : null;
}
function extractType(text) {
  const sih = pickSih(text);
  if (sih) return sih;
  const row = pickTypeRow(text);
  if (!row) return null;
  const sihTail = row.match(/\b(Sativa|Indica|Hybrid)\b/i)?.[1];
  return sihTail || row;
}

/* -------------------- Public: parseCoa -------------------- */
async function parseCoa(url) {
  const doc = await fetchDoc(url);
  let text = '';
  if (doc.type === 'pdf') text = await pdfText(doc.buffer);
  else {
    const $ = cheerio.load(doc.buffer.toString('utf8'));
    text = $('body').text();
  }

  const strain = parseStrain(text);
  const names  = pickTopTerpenes(text, 3);
  const thc    = parseTHC(text);
  const type   = extractType(text);

  return {
    sourceUrl: url,
    strain,
    type,
    dominantTerpene: names[0] ?? null,
    otherTerpenes: names.slice(1),
    thc: { totalPercent: thc.totalPercent ?? null }
  };
}

/* -------------------- CLI -------------------- */
if (require.main === module) {
  (async () => {
    const url = process.argv[2];
    if (!url) {
      console.error('Usage: node coa-scraper.cjs <url>');
      process.exit(1);
    }
    try {
      const out = await parseCoa(url);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(2);
    }
  })();
}

module.exports = { parseCoa };
