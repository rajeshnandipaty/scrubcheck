#!/usr/bin/env node
// scripts/import-cms.js — load the REAL CMS quarterly edit files.
//
// The sample data in data/ exists so the app runs out of the box. To make
// ScrubCheck accurate, download the current quarterly files from CMS and run
// this script to normalize them into data/ptp_edits.tsv and data/mue_edits.tsv.
//
// Where to get the files (public, no login):
//   PTP edits: cms.gov  ->  NCCI for Medicare  ->  PTP Coding Edits
//   MUE edits: cms.gov  ->  NCCI for Medicare  ->  Medically Unlikely Edits
// CMS ships these as Excel (.xlsx) and tab-delimited ASCII. This script reads
// CSV or tab-delimited text, so if you only have the .xlsx, open it and
// "Save As" CSV first (one sheet per file).
//
// Usage:
//   node scripts/import-cms.js --type ptp  path/to/ptp_practitioner.csv
//   node scripts/import-cms.js --type mue  path/to/mue_practitioner.csv
// If --type is omitted the script guesses from the columns.
//
// CMS occasionally tweaks column order. The script maps by header name where it
// can and prints a few normalized rows at the end so you can eyeball the result.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function parseArgs(argv) {
  const args = { type: null, file: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--type') args.type = (argv[++i] || '').toLowerCase();
    else if (!args.file) args.file = argv[i];
  }
  return args;
}

// Split a line on the detected delimiter, respecting simple double-quotes.
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === delim && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function detectDelimiter(headerLine) {
  const tabs = (headerLine.match(/\t/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return tabs >= commas ? '\t' : ',';
}

function norm(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Find the index of the first column whose normalized header matches any needle.
function col(headers, needles) {
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    if (needles.some((n) => h.includes(n))) return i;
  }
  return -1;
}

function normalizeDate(v) {
  const s = (v || '').trim();
  if (!s || s === '*') return '*';
  // YYYYMMDD
  if (/^\d{8}$/.test(s)) return s;
  // MM/DD/YYYY or M/D/YYYY
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  // YYYY-MM-DD
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return `${d[1]}${d[2]}${d[3]}`;
  return s; // leave anything else; the loader fails open on unknown formats
}

function readRows(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('File has no data rows.');
  const delim = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delim);
  const rows = lines.slice(1).map((l) => splitLine(l, delim));
  return { headers, rows, delim };
}

function guessType(headers) {
  const h = headers.map(norm).join('|');
  if (h.includes('column1') || h.includes('column2')) return 'ptp';
  if (h.includes('mue') || h.includes('maximumunits') || h.includes('unitsofservice')) return 'mue';
  return null;
}

function importPtp(headers, rows) {
  const iC1 = col(headers, ['column1', 'col1']);
  const iC2 = col(headers, ['column2', 'col2']);
  const iPrior = col(headers, ['priorto', 'inexistence', '1996']);
  const iEff = col(headers, ['effective']);
  const iDel = col(headers, ['deletion', 'deleted', 'termination']);
  const iMod = col(headers, ['modifier']);
  const iRat = col(headers, ['rationale', 'reason']);
  if (iC1 < 0 || iC2 < 0 || iMod < 0) {
    throw new Error('Could not find Column 1 / Column 2 / Modifier columns. Pass a PTP file or check the header row.');
  }
  const out = ['column_1\tcolumn_2\tprior_to_1996\teffective_date\tdeletion_date\tmodifier\trationale'];
  let n = 0;
  for (const r of rows) {
    const c1 = (r[iC1] || '').trim().toUpperCase();
    const c2 = (r[iC2] || '').trim().toUpperCase();
    if (!c1 || !c2) continue;
    out.push([
      c1, c2,
      iPrior >= 0 ? (r[iPrior] || '').trim() : '',
      iEff >= 0 ? normalizeDate(r[iEff]) : '',
      iDel >= 0 ? normalizeDate(r[iDel]) : '*',
      (r[iMod] || '9').trim() || '9',
      iRat >= 0 ? (r[iRat] || '').trim() : '',
    ].join('\t'));
    n++;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'ptp_edits.tsv'), out.join('\n') + '\n');
  return n;
}

function importMue(headers, rows) {
  const iCode = col(headers, ['hcpcs', 'cpt', 'code']);
  const iVal = col(headers, ['muevalue', 'mue', 'maximumunits', 'unitsofservice', 'value']);
  const iMai = col(headers, ['adjudication', 'mai', 'indicator']);
  const iRat = col(headers, ['rationale', 'reason']);
  if (iCode < 0 || iVal < 0) {
    throw new Error('Could not find HCPCS/CPT code or MUE value columns. Pass an MUE file or check the header row.');
  }
  const out = ['hcpcs_cpt_code\tmue_value\tmai\trationale'];
  let n = 0;
  for (const r of rows) {
    const code = (r[iCode] || '').trim().toUpperCase();
    const val = (r[iVal] || '').trim();
    if (!code || val === '') continue;
    out.push([
      code, val,
      iMai >= 0 ? (r[iMai] || '').trim() : '',
      iRat >= 0 ? (r[iRat] || '').trim() : '',
    ].join('\t'));
    n++;
  }
  fs.writeFileSync(path.join(DATA_DIR, 'mue_edits.tsv'), out.join('\n') + '\n');
  return n;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: node scripts/import-cms.js --type ptp|mue <file.csv|file.tsv>');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`File not found: ${args.file}`);
    process.exit(1);
  }
  const { headers, rows } = readRows(args.file);
  const type = args.type || guessType(headers);
  if (type !== 'ptp' && type !== 'mue') {
    console.error('Could not determine file type. Re-run with --type ptp or --type mue.');
    console.error('Detected headers:', headers.join(' | '));
    process.exit(1);
  }

  const n = type === 'ptp' ? importPtp(headers, rows) : importMue(headers, rows);
  const outFile = type === 'ptp' ? 'data/ptp_edits.tsv' : 'data/mue_edits.tsv';
  console.log(`\nImported ${n} ${type.toUpperCase()} rows -> ${outFile}`);

  // Echo a few normalized rows for a sanity check.
  const written = fs.readFileSync(path.join(DATA_DIR, type === 'ptp' ? 'ptp_edits.tsv' : 'mue_edits.tsv'), 'utf8')
    .split('\n').slice(0, 4).join('\n');
  console.log('\nFirst rows written (verify the mapping looks right):');
  console.log(written);
  console.log('\nSet SCRUBCHECK_DATASET=custom in your .env so the UI shows you are on real data.');
  console.log('Restart the server to load it.\n');
}

main();
