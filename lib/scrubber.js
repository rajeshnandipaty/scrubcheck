// lib/scrubber.js — the deterministic core. No API key, no network.
//
// Given a list of claim lines, it answers two questions Medicare's NCCI
// program would ask before paying:
//   1. PTP: are any two of these procedures bundled (and is a modifier in play)?
//   2. MUE: does any single code exceed its daily unit cap?
// Everything here is a hash lookup against the tables in lib/data.js.

const data = require('./data');

// Distinct-procedural-service modifiers that can bypass a PTP edit whose
// modifier indicator is 1.
const DISTINCT_MODS = new Set(['59', 'XE', 'XS', 'XP', 'XU']);
// For a minor procedure that bundles an E/M visit, the bypass is modifier 25.
const EM_BYPASS = '25';

function isEM(code) {
  // Office/outpatient and other E/M visit codes live in the 99202–99499 band.
  return /^99[2-4]\d\d$/.test(code);
}

const MAI_MEANING = {
  '1': 'Line edit — the cap applies per claim line; units above it on one line deny, but clinically distinct services may sometimes be split onto separate lines with appropriate modifiers.',
  '2': 'Date-of-service edit (policy) — an absolute cap rooted in anatomy or coding policy. It cannot be bypassed; units above the cap will deny.',
  '3': 'Date-of-service edit (clinical) — a cap based on typical clinical use. Units above it deny on the initial claim but may be payable on appeal with documentation of medical necessity.',
};

// "CODE[-MOD...] [UNITS]" per line. A bare trailing integer is units; modifiers
// attach to the code with hyphens (e.g. 99214-25) or appear as alpha tokens.
function parseLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const codeToken = tokens.shift();
  const parts = codeToken.split('-');
  const code = parts.shift().toUpperCase();
  const modifiers = parts.map((m) => m.toUpperCase()).filter(Boolean);
  let units = 1;
  for (const t of tokens) {
    if (/^\d{1,3}$/.test(t)) units = parseInt(t, 10);
    else modifiers.push(t.toUpperCase());
  }
  return { raw: line.trim(), code, modifiers, units };
}

function parseClaim(text) {
  return (text || '')
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean);
}

const SEVERITY_RANK = { deny: 3, modifier: 2, review: 1, ok: 0, info: 0 };

function lookupPtp(a, b) {
  // Edits are directional; return whichever ordering exists and is active.
  return (
    data.ptp.get(`${a}|${b}`) ||
    data.ptp.get(`${b}|${a}`) ||
    null
  );
}

function scrub(text) {
  const lines = parseClaim(text);
  lines.forEach((l) => (l.description = data.describe(l.code)));
  const findings = [];
  let nextId = 1;

  // Flag any codes we have no record of at all, so the user isn't misled into
  // thinking "no findings" means "fully validated".
  for (const ln of lines) {
    const known =
      data.describe(ln.code) ||
      data.mue.has(ln.code) ||
      [...data.ptp.keys()].some((k) => k.startsWith(ln.code + '|') || k.endsWith('|' + ln.code));
    if (!known) {
      findings.push({
        id: nextId++,
        type: 'unknown_code',
        severity: 'info',
        codes: [ln.code],
        title: `${ln.code} is not in the loaded edit set`,
        facts: {
          code: ln.code,
          message:
            'No PTP or MUE entry was found for this code in the currently loaded data. That is not a clean bill of health — it only means this code is outside the loaded tables. Load the full CMS quarterly files for complete coverage.',
        },
      });
    }
  }

  // PTP: every unordered pair of codes on the claim.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i];
      const B = lines[j];
      if (A.code === B.code) continue;
      const edit = lookupPtp(A.code, B.code);
      if (!edit || !edit.active) continue;

      // The "column 2" code is the one that gets denied. Figure out which of
      // our two lines is column 2 so we check the modifier on the right one.
      const col2Code = edit.column2;
      const col2Line = A.code === col2Code ? A : B;
      const col1Code = edit.column1;

      const base = {
        id: nextId++,
        type: 'ptp',
        codes: [col1Code, col2Code],
        column1: col1Code,
        column2: col2Code,
        modifierIndicator: edit.modifier,
        rationale: edit.rationale,
        descriptions: {
          [col1Code]: data.describe(col1Code),
          [col2Code]: data.describe(col2Code),
        },
      };

      if (edit.modifier === '0') {
        findings.push({
          ...base,
          severity: 'deny',
          title: `${col1Code} + ${col2Code} are bundled and cannot be unbundled`,
          facts: {
            ...base,
            indicatorMeaning:
              'Modifier indicator 0: this pair can never be reported together. No modifier overrides it.',
            conclusion: `${col2Code} will be denied when billed with ${col1Code}.`,
          },
        });
      } else if (edit.modifier === '1') {
        const wantsMod = isEM(col2Code) ? EM_BYPASS : '59 (or XE/XS/XP/XU)';
        const hasBypass = isEM(col2Code)
          ? col2Line.modifiers.includes(EM_BYPASS)
          : col2Line.modifiers.some((m) => DISTINCT_MODS.has(m));
        findings.push({
          ...base,
          severity: hasBypass ? 'ok' : 'modifier',
          appliedModifiers: col2Line.modifiers,
          bypassPresent: hasBypass,
          title: hasBypass
            ? `${col1Code} + ${col2Code} bundle bypassed by a modifier on ${col2Code}`
            : `${col1Code} + ${col2Code} are bundled — a modifier on ${col2Code} may be required`,
          facts: {
            ...base,
            indicatorMeaning:
              'Modifier indicator 1: these are normally bundled, but a modifier on the column-2 code may allow separate payment when the services were genuinely distinct.',
            neededModifier: wantsMod,
            appliedModifiers: col2Line.modifiers,
            bypassPresent: hasBypass,
            conclusion: hasBypass
              ? `A bypass modifier is present on ${col2Code}; if the distinct-service criteria are met and documented, both may be payable.`
              : `Without an appropriate modifier on ${col2Code}, it will be denied. Add the modifier only if the services were truly separate and the record supports it.`,
          },
        });
      }
    }
  }

  // MUE: per-code daily unit cap.
  for (const ln of lines) {
    const m = data.mue.get(ln.code);
    if (!m || isNaN(m.value)) continue;
    if (ln.units > m.value) {
      const severity = m.mai === '2' ? 'deny' : 'review';
      findings.push({
        id: nextId++,
        type: 'mue',
        severity,
        codes: [ln.code],
        title: `${ln.code}: ${ln.units} units exceeds the MUE cap of ${m.value}`,
        facts: {
          code: ln.code,
          description: data.describe(ln.code),
          billedUnits: ln.units,
          mueValue: m.value,
          mai: m.mai,
          maiMeaning: MAI_MEANING[m.mai] || 'Unrecognized MUE adjudication indicator.',
          rationale: m.rationale,
          conclusion:
            severity === 'deny'
              ? `Units above ${m.value} will be denied and cannot be appealed for this code.`
              : `Units above ${m.value} will deny initially; payment may be possible on appeal with documentation.`,
        },
      });
    }
  }

  // Overall status = worst finding.
  let status = 'ok';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[status]) status = f.severity;
  }
  if (findings.every((f) => f.severity === 'info' || f.severity === 'ok')) {
    status = findings.some((f) => f.severity === 'info') ? 'info' : 'ok';
  }

  return {
    status,
    lineCount: lines.length,
    lines,
    findings,
    summary: summarize(findings),
  };
}

function summarize(findings) {
  const deny = findings.filter((f) => f.severity === 'deny').length;
  const modifier = findings.filter((f) => f.severity === 'modifier').length;
  const review = findings.filter((f) => f.severity === 'review').length;
  return { deny, modifier, review, total: findings.length };
}

module.exports = { scrub, parseClaim, MAI_MEANING };
