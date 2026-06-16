// app.js — ScrubCheck frontend.
// The deterministic result is rendered immediately from /api/scrub. The
// "Explain with Claude" button is an optional, visible upgrade that swaps the
// templated explanations for AI-written ones via /api/explain.

const $ = (sel) => document.querySelector(sel);

const els = {
  claim: $('#claim'),
  scrub: $('#scrub-btn'),
  clear: $('#clear-btn'),
  samples: $('#samples'),
  empty: $('#empty'),
  results: $('#results'),
  verdict: $('#verdict'),
  lineitems: $('#lineitems'),
  findingsBlock: $('#findings-block'),
  findings: $('#findings'),
  explain: $('#explain-btn'),
  statusData: $('#status-data'),
  statusAi: $('#status-ai'),
};

let aiEnabled = false;
let lastResult = null;

const SAMPLES = [
  { label: 'Bundled ECG', text: '93000\n93005' },
  { label: 'Procedure + visit', text: '20610\n99214' },
  { label: 'Allowed with modifier', text: '20610\n99214-25' },
  { label: 'Panel overlap', text: '80053\n80048' },
  { label: 'Over the unit cap', text: '36415  4' },
  { label: 'Clean claim', text: '99214\n36415  2' },
  { label: 'Multiple edits', text: '99214-25\n20610\n80053\n80048\n36415  3\n99999' },
];

const VERDICT = {
  deny:     { icon: '\u2715', head: 'Will deny',  cls: 'v-deny' },
  modifier: { icon: '!',      head: 'Needs a modifier', cls: 'v-modifier' },
  review:   { icon: '\u2248', head: 'Needs review', cls: 'v-review' },
  ok:       { icon: '\u2713', head: 'Clean',       cls: 'v-ok' },
  info:     { icon: 'i',      head: 'Check coverage', cls: 'v-info' },
};

const BADGE = {
  deny: 'Hard bundle', modifier: 'Modifier', review: 'Unit cap', ok: 'Bypassed', info: 'Not loaded',
};

// ---------- init ----------
init();

async function init() {
  SAMPLES.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'sample';
    b.textContent = s.label;
    b.addEventListener('click', () => {
      els.claim.value = s.text;
      els.claim.focus();
      runScrub();
    });
    els.samples.appendChild(b);
  });

  els.scrub.addEventListener('click', runScrub);
  els.clear.addEventListener('click', () => {
    els.claim.value = '';
    showEmpty();
    els.claim.focus();
  });
  els.claim.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runScrub();
  });
  els.explain.addEventListener('click', runExplain);

  try {
    const r = await fetch('/api/status').then((x) => x.json());
    aiEnabled = r.aiEnabled;
    els.statusData.textContent = `${r.counts.ptp} PTP \u00b7 ${r.counts.mue} MUE \u00b7 ${r.dataset}`;
    els.statusData.classList.add('on');
    els.statusAi.textContent = r.aiEnabled ? 'AI explain: on' : 'AI explain: off';
    els.statusAi.classList.add(r.aiEnabled ? 'on' : 'off');
  } catch {
    els.statusData.textContent = 'offline';
    els.statusAi.textContent = '';
  }
}

// ---------- scrub ----------
async function runScrub() {
  const text = els.claim.value.trim();
  if (!text) { showEmpty(); return; }

  els.scrub.disabled = true;
  els.scrub.textContent = 'Scrubbing\u2026';
  try {
    const result = await fetch('/api/scrub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((x) => x.json());

    if (result.error) throw new Error(result.error);
    lastResult = result;
    render(result);
  } catch (err) {
    renderError(err.message);
  } finally {
    els.scrub.disabled = false;
    els.scrub.textContent = 'Scrub claim';
  }
}

function render(result) {
  els.empty.hidden = true;
  els.results.hidden = false;

  // verdict banner
  const v = VERDICT[result.status] || VERDICT.ok;
  const s = result.summary;
  let meta;
  if (result.status === 'ok') meta = 'No NCCI conflicts or unit-cap issues in the loaded set.';
  else {
    const bits = [];
    if (s.deny) bits.push(`${s.deny} hard ${s.deny === 1 ? 'conflict' : 'conflicts'}`);
    if (s.modifier) bits.push(`${s.modifier} needing a modifier`);
    if (s.review) bits.push(`${s.review} over a unit cap`);
    meta = bits.length ? bits.join(' \u00b7 ') : 'Review the notes below.';
  }
  els.verdict.className = `verdict ${v.cls}`;
  els.verdict.innerHTML =
    `<div class="verdict-icon">${v.icon}</div>` +
    `<div class="verdict-text"><p class="verdict-head">${v.head}</p>` +
    `<p class="verdict-meta">${esc(meta)}</p></div>`;

  // per-code worst severity, for the ledger chips
  const worst = {};
  const rank = { deny: 3, modifier: 2, review: 1, info: 0, ok: -1 };
  for (const f of result.findings) {
    for (const c of f.codes) {
      if (!(c in worst) || rank[f.severity] > rank[worst[c]]) worst[c] = f.severity;
    }
  }

  // ledger
  els.lineitems.innerHTML = result.lines.map((ln) => {
    const sev = worst[ln.code] ?? 'ok';
    const chipText = sev === 'ok' ? 'OK' : sev === 'info' ? 'Not loaded' :
      sev === 'deny' ? 'Deny' : sev === 'modifier' ? 'Modifier' : 'Review';
    const mods = ln.modifiers.map((m) => `<span class="li-mod">${esc(m)}</span>`).join('');
    const desc = ln.description ? esc(ln.description) : '<em style="opacity:.6">not in loaded set</em>';
    const units = ln.units > 1 ? `\u00d7${ln.units}` : '';
    return `<div class="lineitem">
      <span class="li-code">${esc(ln.code)}${mods}</span>
      <span class="li-desc">${desc}</span>
      <span class="li-units">${units}</span>
      <span class="li-chip chip-${sev}">${chipText}</span>
    </div>`;
  }).join('');

  // findings
  if (result.findings.length === 0) {
    els.findingsBlock.hidden = true;
  } else {
    els.findingsBlock.hidden = false;
    els.findings.innerHTML = result.findings.map(renderFinding).join('');
    const actionable = result.findings.some((f) => f.severity !== 'ok' && f.severity !== 'info');
    els.explain.hidden = !(aiEnabled && actionable);
    els.explain.disabled = false;
    els.explain.textContent = 'Explain with Claude';
  }
}

function renderFinding(f) {
  const body = templatedText(f);
  const rules = ruleTags(f).map((t) => `<span class="rule-tag">${t}</span>`).join('');
  return `<div class="finding f-${f.severity}" data-id="${f.id}">
    <div class="f-head">
      <span class="f-badge">${esc(BADGE[f.severity] || f.type)}</span>
      <span class="f-title">${esc(f.title)}</span>
    </div>
    <p class="f-body" id="body-${f.id}">${esc(body)}</p>
    ${rules ? `<div class="f-rule">${rules}</div>` : ''}
  </div>`;
}

// Built-in explanation, used when the AI layer is off or hasn't run.
function templatedText(f) {
  const x = f.facts || {};
  if (f.type === 'ptp') {
    return `${x.indicatorMeaning} ${x.conclusion}`;
  }
  if (f.type === 'mue') {
    return `${x.maiMeaning} ${x.conclusion}`;
  }
  if (f.type === 'unknown_code') {
    return x.message;
  }
  return x.conclusion || '';
}

function ruleTags(f) {
  const x = f.facts || {};
  if (f.type === 'ptp') {
    const tags = [
      `<b>PTP edit</b> ${esc(x.column1)} \u2194 ${esc(x.column2)}`,
      `<b>Modifier indicator</b> ${esc(x.modifierIndicator)}`,
    ];
    if (x.rationale) tags.push(esc(x.rationale));
    if (x.neededModifier && !x.bypassPresent) tags.push(`<b>Modifier</b> ${esc(x.neededModifier)}`);
    return tags;
  }
  if (f.type === 'mue') {
    return [
      `<b>MUE</b> cap ${esc(x.mueValue)}`,
      `<b>Billed</b> ${esc(x.billedUnits)}`,
      `<b>MAI</b> ${esc(x.mai)}`,
    ];
  }
  return [];
}

// ---------- AI explain ----------
async function runExplain() {
  if (!lastResult) return;
  els.explain.disabled = true;
  els.explain.textContent = 'Asking Claude\u2026';
  // show inline loading on each actionable finding
  for (const f of lastResult.findings) {
    if (f.severity === 'ok' || f.severity === 'info') continue;
    const node = document.getElementById(`body-${f.id}`);
    if (node) { node.classList.add('f-loading'); node.textContent = 'rewriting\u2026'; }
  }
  try {
    const out = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: lastResult }),
    }).then((x) => x.json());

    for (const f of lastResult.findings) {
      const node = document.getElementById(`body-${f.id}`);
      if (!node) continue;
      node.classList.remove('f-loading');
      const ai = out.explanations && out.explanations[String(f.id)];
      if (ai) {
        node.classList.add('is-ai');
        node.innerHTML = `${esc(ai)}<span class="f-ai-tag">via Claude</span>`;
      } else {
        node.textContent = templatedText(f); // fall back if a given id was skipped
      }
    }
    els.explain.textContent = out.enabled === false ? 'AI not configured' : 'Explained';
  } catch {
    for (const f of lastResult.findings) {
      const node = document.getElementById(`body-${f.id}`);
      if (node) { node.classList.remove('f-loading'); node.textContent = templatedText(f); }
    }
    els.explain.disabled = false;
    els.explain.textContent = 'Retry explain';
  }
}

// ---------- helpers ----------
function showEmpty() {
  els.results.hidden = true;
  els.empty.hidden = false;
  lastResult = null;
}
function renderError(msg) {
  els.empty.hidden = true;
  els.results.hidden = false;
  els.verdict.className = 'verdict v-info';
  els.verdict.innerHTML =
    `<div class="verdict-icon">i</div><div class="verdict-text">` +
    `<p class="verdict-head">Couldn't scrub that</p>` +
    `<p class="verdict-meta">${esc(msg)}</p></div>`;
  els.lineitems.innerHTML = '';
  els.findingsBlock.hidden = true;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
