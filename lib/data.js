// lib/data.js — loads NCCI edit data into memory for fast lookup.
//
// The deterministic core needs three things: a PTP edit table (which code
// pairs bundle), an MUE table (per-code daily unit caps), and human-readable
// code descriptions. We load them once at startup into plain Maps so every
// scrub is an O(1) hash lookup, not a file scan. This scales to the real
// CMS quarterly files (hundreds of thousands of PTP pairs) without a database.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// CMS encodes "still active" as "*" in the deletion-date column. A real
// deletion date in the past means the edit no longer applies.
function isActive(deletionDate, modifier) {
  if (modifier === '9') return false; // modifier indicator 9 = not applicable / deleted
  const d = (deletionDate || '').trim();
  if (d === '' || d === '*') return true;
  // Parse YYYYMMDD; if it's in the past, the edit is retired.
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  if (!m) return true; // unknown format — fail open (treat as active) and let the user verify
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return dt.getTime() >= Date.now();
}

// Minimal, dependency-free TSV reader. First row is the header.
function readTsv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift().split('\t').map((h) => h.trim().toLowerCase());
  return lines.map((line) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

function loadPtp() {
  const rows = readTsv(path.join(DATA_DIR, 'ptp_edits.tsv'));
  // Key by "col1|col2". PTP edits are directional, so the caller must check
  // both orderings of any code pair.
  const map = new Map();
  let active = 0;
  for (const r of rows) {
    const c1 = (r.column_1 || '').toUpperCase();
    const c2 = (r.column_2 || '').toUpperCase();
    if (!c1 || !c2) continue;
    const rec = {
      column1: c1,
      column2: c2,
      modifier: r.modifier || '9',
      effectiveDate: r.effective_date || '',
      deletionDate: r.deletion_date || '',
      rationale: r.rationale || '',
      active: isActive(r.deletion_date, r.modifier),
    };
    if (rec.active) active++;
    map.set(`${c1}|${c2}`, rec);
  }
  return { map, total: rows.length, active };
}

function loadMue() {
  const rows = readTsv(path.join(DATA_DIR, 'mue_edits.tsv'));
  const map = new Map();
  for (const r of rows) {
    const code = (r.hcpcs_cpt_code || '').toUpperCase();
    if (!code) continue;
    map.set(code, {
      code,
      value: parseInt(r.mue_value, 10),
      mai: r.mai || '',
      rationale: r.rationale || '',
    });
  }
  return { map, total: rows.length };
}

function loadDescriptions() {
  const file = path.join(DATA_DIR, 'code_descriptions.json');
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) map.set(k.toUpperCase(), v);
    return map;
  } catch {
    return new Map();
  }
}

const ptp = loadPtp();
const mue = loadMue();
const descriptions = loadDescriptions();

module.exports = {
  ptp: ptp.map,
  mue: mue.map,
  descriptions,
  counts: { ptp: ptp.active, ptpTotal: ptp.total, mue: mue.total },
  describe: (code) => descriptions.get((code || '').toUpperCase()) || null,
};
