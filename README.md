# treasureboard-data

The **kitchen** for TreasureBoard's PF2e equipment search: a tiny, self-contained repo that
turns the fat Foundry VTT [`pf2e`](https://github.com/foundryvtt/pf2e) equipment pack into a
slim, ready-to-serve bundle and publishes it as a GitHub Release asset.

Consuming apps (the Campaign Accountant backend, and anything else) never touch pf2e — they
just download one small tarball from a stable URL and serve it. All pf2e knowledge lives here.

## What it produces

A daily GitHub Actions job rebuilds a bundle and, **only when upstream changed**, (re)publishes
it to the moving `data-latest` release. The tarball `treasureboard-data.tar.gz` contains:

```
equipment.json     # array of slim records, sorted by id (stable)
icons/<hash><ext>  # every referenced icon, deduped by content hash
meta.json          # provenance + counts (also uploaded as a standalone asset)
```

Stable download URL for consumers (no auth — this repo is public):

```
https://github.com/<owner>/treasureboard-data/releases/download/data-latest/treasureboard-data.tar.gz
```

### `equipment.json` record

```jsonc
{
  "id": "jC8GmH0Un6vDxdMj",          // Foundry _id (stable)
  "name": "Acid Flask (Greater)",
  "type": "weapon",                   // Foundry doc type (weapon/armor/consumable/…)
  "level": 11,
  "description": "…clean, safe HTML…", // enrichers resolved, unsafe tags stripped
  "rarity": "common",
  "price": { "copper": 25000, "per": 1, "text": "250 gp" },
  "traits": ["acid", "alchemical", "bomb", "consumable", "splash"],
  "quantity": 1,
  "publicationTitle": "Pathfinder GM Core",
  "remaster": true,
  "baseItem": "alchemical-bomb",
  "img": "ab12…f.webp"                // filename inside icons/ (.webp or .svg); null only if nothing resolved
}
```

> **Icons — important.** Only ~half of equipment items reference pf2e's own art
> (`systems/pf2e/icons/…`); the rest point at bare `icons/…` paths that are **Foundry VTT core
> icons**, which ship with the paid Foundry software and are **not** in this repo (nor ours to
> redistribute). For those, `img` falls back to pf2e's own type glyph
> (`static/icons/default-icons/<type>.{webp,svg}`), so every item still has a **local, licensed**
> icon — roughly half just show a generic type glyph instead of bespoke art. `meta.json` reports
> the `realIcons` / `fallbackIcons` split. Because fallback filenames include a `.svg` extension
> for some types, a consumer serving these must set `image/svg+xml` vs `image/webp` by extension.

### `meta.json`

```jsonc
{
  "schemaVersion": 1,
  "upstreamRepo": "foundryvtt/pf2e",
  "upstreamBranch": "v14-dev",        // RESOLVED default branch at build time
  "upstreamSha": "…",                 // exact commit the bundle was built from
  "generatedAt": "2026-07-03T05:00:00.000Z",
  "itemCount": 5672, "iconCount": 0,
  "realIcons": 0, "fallbackIcons": 0, "unresolved": 0, "parseErrors": 0
}
```

## How it works

- **Source branch is never pinned.** The workflow checks out `foundryvtt/pf2e` with no `ref`,
  so it gets the repo's *default* branch — which pf2e keeps pointed at the current dev branch
  (`v14-dev` → `v15-dev` → …). Major-version bumps are picked up automatically; `meta.json`
  records the resolved branch + commit SHA.
- **Sparse + shallow checkout** of just `packs/pf2e/equipment` and `static/icons` (git-native,
  no API rate limits, no HTTP client).
- **Icons** are deduped by SHA-256 of their bytes and copied as-is (no re-encoding).
  `systems/pf2e/icons/…` resolves to `static/icons/…`; bare `icons/…` (Foundry core art absent
  from this repo) falls back to `static/icons/default-icons/<type>.{webp,svg}` — see the icon
  note above.
- **Prices** are normalized to total copper + a display string (`1 pp = 10 gp = 100 sp = 1000 cp`).
- **Descriptions** are cleaned: action-glyph spans become `(1 action)` etc., common Foundry
  enrichers (`@UUID/@Check/@Damage`, inline `[[/r …]]` rolls) are resolved to their label or a
  readable phrase, and the result is run through `sanitize-html` to a safe tag subset. This is
  **best-effort**, not a full Foundry enricher — unusual enrichers may be dropped rather than
  fully rendered.

## Run it locally

```bash
npm install

# Point at any local pf2e checkout (sparse is fine):
git clone --depth 1 --filter=blob:none --sparse https://github.com/foundryvtt/pf2e pf2e-src
git -C pf2e-src sparse-checkout set packs/pf2e/equipment static/icons

PF2E_SRC=./pf2e-src npm run ingest   # writes ./dist
```

Env vars: `PF2E_SRC` (default `./pf2e-src`), `OUT_DIR` (default `./dist`),
`UPSTREAM_REPO`/`UPSTREAM_BRANCH`/`UPSTREAM_SHA` (recorded into `meta.json`; set by CI).

## Layout

```
ingest.ts                     # the whole transform (single script)
package.json / tsconfig.json  # tsx runtime, sanitize-html
.github/workflows/refresh.yml # daily cron + manual dispatch → publish data-latest
```
