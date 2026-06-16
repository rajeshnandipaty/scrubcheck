// server.js — small Express server for ScrubCheck.
//
// Two endpoints, deliberately separated:
//   POST /api/scrub    deterministic, instant, no API key, no network. The core.
//   POST /api/explain  optional. Enriches findings with Claude-written prose,
//                      only if ANTHROPIC_API_KEY is set. Costs ~a fraction of a
//                      cent per claim and is the ONLY thing that touches an API.
// Keeping them apart is the whole architecture: the linter works for everyone
// offline; the explanation layer is a visible, optional upgrade.

require('dotenv').config();
const express = require('express');

const data = require('./lib/data');
const { scrub } = require('./lib/scrubber');
const { explain } = require('./lib/explain');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Lets the UI show whether the AI layer is available and how much data is loaded.
app.get('/api/status', (req, res) => {
  res.json({
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    counts: data.counts,
    dataset: process.env.SCRUBCHECK_DATASET || 'sample',
  });
});

app.post('/api/scrub', (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text.trim()) return res.status(400).json({ error: 'No codes provided.' });
  try {
    res.json(scrub(text));
  } catch (err) {
    console.error('scrub failed:', err);
    res.status(500).json({ error: 'Could not analyze the claim.' });
  }
});

app.post('/api/explain', async (req, res) => {
  const result = req.body && req.body.result;
  if (!result || !Array.isArray(result.findings)) {
    return res.status(400).json({ error: 'Send a scrub result to explain.' });
  }
  const out = await explain(result);
  res.json(out);
});

app.listen(PORT, () => {
  const ai = process.env.ANTHROPIC_API_KEY ? 'on' : 'off (templated explanations)';
  console.log(`\nScrubCheck running at http://localhost:${PORT}`);
  console.log(`  Loaded ${data.counts.ptp} active PTP edits, ${data.counts.mue} MUE entries.`);
  console.log(`  AI explanation layer: ${ai}\n`);
});
