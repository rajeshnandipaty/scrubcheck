# ScrubCheck

> Paste a claim's procedure codes and see what Medicare's NCCI program will bundle or cap before you submit, with the reason for each flag.

ScrubCheck takes the procedure codes from a claim and runs the same two checks a payer runs before paying: PTP (are any two of these procedures bundled?) and MUE (does any single code exceed its daily unit cap?). It returns a remittance-style readout, with a verdict per line and a plain-English explanation per conflict, so denials get caught at the desk instead of three weeks later on an EOB.

## What it does

You type one procedure per line, attach modifiers with a hyphen, and put units after a space:

```
99214-25
20610
80053
80048
36415  3
```

ScrubCheck answers instantly and offline:

- **Hard bundles.** A comprehensive metabolic panel (`80053`) and a basic metabolic panel (`80048`) cannot both be billed, because the comprehensive already includes the basic. Modifier indicator `0` means no modifier overrides it.
- **Modifier-eligible bundles.** A minor procedure (`20610`) bundles the office visit billed with it, unless the visit was separately identifiable and carries modifier `25`. Modifier indicator `1` means a modifier can apply, so ScrubCheck checks whether you already used an appropriate one and tells you if it is missing.
- **Unit-cap overages.** Billing `36415` (venipuncture) three times against an MUE of 2. It distinguishes an absolute policy cap (MAI 2, not appealable) from a clinical cap (MAI 3, payable on appeal with documentation).
- **Codes it does not recognize.** These are flagged explicitly, so "no findings" is never mistaken for "fully validated."

Each finding cites the rule behind it: the PTP pair and modifier indicator, or the MUE value and MAI.

## How it is built

The whole thing is built around one split.

The core is deterministic and runs with no API key and no network. Every check is a hash lookup against the CMS edit tables. This is the part that has to be right, so it owes nothing to a model.

The explanation layer is optional, and it is the only thing that touches an API. With an Anthropic key configured, an "Explain with Claude" button rewrites each finding's facts as one or two sentences a biller can act on, grounded only in the facts the engine already computed. The prompt forbids introducing any coding or clinical claim that was not passed in. Without a key, the app falls back to built-in templated explanations and stays fully usable.

That separation is the point. Correctness lives in the code, phrasing lives in the model, and the model never decides whether two codes bundle.

## Setup

### Requirements

- Node.js 18+ (use [nvm](https://github.com/nvm-sh/nvm) if you do not have it)
- An Anthropic API key is optional, and is only needed for the AI explanation layer

### Install and run

```bash
git clone https://github.com/rajeshnandipaty/scrubcheck.git
cd scrubcheck
npm install
cp .env.example .env      # optional: add a key to enable "Explain with Claude"
npm start
```

Open `http://localhost:3000`. `Ctrl+C` stops it.

## Using real CMS data

The repo ships with a small sample of edits so it runs out of the box. The values are illustrative, chosen to exercise every path, and are not a current copy of Medicare's tables. To make it accurate, load the real quarterly files (public, free, no login):

- **PTP edits:** cms.gov, NCCI for Medicare, PTP Coding Edits
- **MUE edits:** cms.gov, NCCI for Medicare, Medically Unlikely Edits

```bash
node scripts/import-cms.js --type ptp  ~/Downloads/ptp_practitioner.csv
node scripts/import-cms.js --type mue  ~/Downloads/mue_practitioner.csv
```

The importer reads CSV or tab-delimited text (if you only have the `.xlsx`, save it as CSV first), maps columns by header name, normalizes dates, and prints the first rows so you can confirm the mapping. Then set `SCRUBCHECK_DATASET=custom` in `.env` and restart. See [`data/README.md`](data/README.md) for details.

## What I learned

- **Correctness and fluency are different jobs.** The temptation with an LLM is to hand it the whole task. But "do these two codes bundle?" has a right answer that lives in a table, and a model that is 98% right on that is 100% wrong on the 2% of claims that matter. Splitting the deterministic check from the generated explanation made the tool both trustworthy and readable, and it left the prompt with one job: say this clearly. That is a job models are good at.
- **The modifier indicator is the whole thing.** A `0` and a `1` look identical until you know that one is an absolute bundle and the other means "document the distinct service and append the modifier." Encoding that distinction, and checking whether the user already applied a bypass modifier, is what turns a code list into actionable feedback.
- **Public reference data has quirks.** CMS encodes "still active" as `*`, ships dates in more than one format, and reorders columns between quarters. The importer maps by header name and fails open on unknown date formats rather than silently dropping edits.

## Why this is not hosted publicly

The core would be safe to host, since it is just lookups. But the honest reason to keep it local is the same as the [glossary-flashcards](https://github.com/rajeshnandipaty/glossary-flashcards) project: the explanation layer makes paid API calls against my account, and a public demo invites abuse. So it runs locally, the source is here, and a demo video is on [my portfolio](https://rajeshnandipaty.com).

## Not billing advice

ScrubCheck is an educational tool over public and sample data. It does not guarantee payment and is not a substitute for certified coding software or a certified coder. Verify against the current CMS NCCI edit files before submitting real claims.

## Project layout

```
scrubcheck/
├── server.js                Express server: serves the UI, /api/scrub, optional /api/explain
├── lib/
│   ├── data.js              Loads edit tables into in-memory lookup maps
│   ├── scrubber.js          The deterministic core: PTP and MUE checks
│   └── explain.js           Optional Claude layer (grounded in the engine's facts)
├── public/
│   ├── index.html           UI shell
│   ├── style.css            Clinical-panel styling
│   └── app.js               Input handling and remittance-style rendering
├── data/
│   ├── ptp_edits.tsv        Sample PTP edits (CMS layout)
│   ├── mue_edits.tsv        Sample MUE edits (CMS layout)
│   ├── code_descriptions.json
│   └── README.md            How to load the real CMS files
├── scripts/
│   └── import-cms.js        Normalizes a real CMS quarterly file into data/
├── package.json
├── .env.example
└── .gitignore
```
