# Edit data

ScrubCheck reads three files in this folder:

| File | What it is |
| --- | --- |
| `ptp_edits.tsv` | Procedure-to-procedure (PTP) bundling edits: which code pairs conflict, and the modifier indicator (0 / 1 / 9). |
| `mue_edits.tsv` | Medically Unlikely Edits (MUE): the per-code daily unit cap and its adjudication indicator (MAI 1 / 2 / 3). |
| `code_descriptions.json` | Short, human-readable descriptions for the codes, used in the UI ledger. |

## The shipped data is a SAMPLE

The values here are **illustrative** — a small set chosen to exercise every
path (hard bundle, modifier-eligible bundle, deleted edit, unit-cap overage,
clean claim, unknown code). They model the real CMS file structure but are
**not** a current, authoritative copy of Medicare's edits. Do not rely on them
for real claims.

## Loading the real CMS files

The real edits are public and free (no login):

- **PTP edits** — cms.gov → *NCCI for Medicare* → *PTP Coding Edits*
- **MUE edits** — cms.gov → *NCCI for Medicare* → *Medically Unlikely Edits*

CMS posts these quarterly as Excel (`.xlsx`) and tab-delimited ASCII. The
importer reads CSV or tab-delimited text, so if you only have the `.xlsx`, open
it and **Save As → CSV** first (one sheet per file). Then:

```bash
node scripts/import-cms.js --type ptp  ~/Downloads/ptp_practitioner.csv
node scripts/import-cms.js --type mue  ~/Downloads/mue_practitioner.csv
```

The importer maps columns by header name, normalizes dates, and writes back
into this folder. It prints the first few rows so you can confirm the mapping
looks right (CMS occasionally changes column order). Set
`SCRUBCHECK_DATASET=custom` in `.env` and restart the server.

Descriptions: the full CPT/HCPCS long-descriptor set is licensed (AMA owns CPT),
so it isn't bundled here. The ledger simply shows "not in loaded set" for codes
without a local description — the bundling and unit-cap checks still run.
