// lib/explain.js — the optional AI layer.
//
// The deterministic core already knows exactly what's wrong and why. This
// layer's only job is voice: turn the structured facts into one or two
// sentences a biller can read and act on. It is grounded ENTIRELY in the
// facts the scrubber computed — the prompt forbids inventing any coding or
// clinical claim beyond what's passed in. If no API key is configured, the
// app falls back to the built-in templated explanations and never calls this.

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You explain medical-billing edit results to a biller in plain English.

You will receive a JSON array of "findings". Each finding already contains the
full determination (the code pair or code, the rule, the modifier indicator or
MUE value, and a "conclusion"). Your job is ONLY to rephrase each finding as a
clear, concise explanation a biller can act on.

Hard rules:
- Ground every sentence ONLY in the facts given. Do NOT introduce any CPT/HCPCS
  knowledge, bundling relationship, clinical fact, or dollar figure that is not
  present in the finding.
- 1-2 sentences per finding. No preamble, no restating the code descriptions
  verbatim, no markdown.
- Name the concrete next step when there is one (e.g. "append modifier 25 only
  if the visit was a separately identifiable service").
- This is educational guidance over reference data, not billing advice or a
  guarantee of payment. Do not claim certainty about what a payer will do.

Return ONLY a valid JSON object mapping each finding's "id" (as a string) to its
explanation string. No code fences, no commentary. Example:
{"1": "...", "2": "..."}`;

async function explain(result) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { enabled: false, explanations: {} };
  }
  // Nothing worth explaining if there are no real findings.
  const actionable = result.findings.filter((f) => f.severity !== 'ok');
  if (actionable.length === 0) return { enabled: true, explanations: {} };

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const payload = actionable.map((f) => ({
    id: f.id,
    type: f.type,
    severity: f.severity,
    facts: f.facts,
  }));

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    const text = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
      .replace(/^```json\s*|\s*```$/g, '');
    const explanations = JSON.parse(text);
    return { enabled: true, explanations };
  } catch (err) {
    // Never let the AI layer break the core result; just signal it was skipped.
    console.error('explain() failed, falling back to templated text:', err.message);
    return { enabled: true, explanations: {}, error: err.message };
  }
}

module.exports = { explain };
