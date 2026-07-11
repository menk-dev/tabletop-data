# treasureboard-data

The **kitchen** for TreasureBoard's PF2e equipment search: a tiny, self-contained repo that
turns the fat Foundry VTT [`pf2e`](https://github.com/foundryvtt/pf2e) equipment and
equipment-effects packs into a slim, ready-to-serve bundle and publishes it as a GitHub Release
asset.

Consuming apps (the Campaign Accountant backend, and anything else) never touch pf2e — they
just download one small tarball from a stable URL and serve it. All pf2e knowledge lives here.

## What it produces

A daily GitHub Actions job rebuilds a bundle and, **only when upstream changed**, (re)publishes
it to the moving `data-latest` release. The tarball `treasureboard-data.tar.gz` contains:

```
equipment.json     # array of slim item records, sorted by id (stable)
traits.json        # metadata for every trait referenced by equipment, sorted by slug
effects.json       # array of slim "Effect: …" records equipment activates, sorted by id
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
  "source": { "title": "Pathfinder GM Core", "remaster": true },
  "baseItem": "alchemical-bomb",
  "bulk": 0.1,                       // normal Bulk units: 0.1 = light, 0 = negligible
  "usage": "held-in-one-hand",       // stable PF2e kebab-case slug
  "hands": 1,
  "material": null,                   // { "type": "cold-iron", "grade": "standard" } when a precious material, else null
  "size": "med", "hardness": null, "hp": null,
  "category": "martial", "group": "bomb",
  "weapon": {                        // only on weapons; armor/consumable use their named block
    "damageDice": 1, "damageDie": "d6", "damageType": "acid",
    "range": 20, "reload": null, "canBeAmmo": false, "splashDamage": 3,
    "potency": 0, "striking": 0, "propertyRunes": []
  },
  "stats": { … },                     // type-specific mechanical block; null for types without one (see Stats)
  "img": "ab12…f.webp",               // filename inside icons/ (.webp or .svg); null only if nothing resolved
  "references": [                     // deduped outbound links parsed from the description
    { "kind": "equipment", "name": "Crowbar (Levered)", "id": "4kz3…", "resolved": true },
    { "kind": "spell", "name": "Fireball", "resolved": false }
  ]
}
```

The schema-v4 normalized fields use `null` for absent or inapplicable values. Numeric zero is kept
only when it is a real value (including negligible Bulk, zero bonuses, and mundane rune ranks).
Only the applicable `weapon`, `armor`, or `consumable` object is emitted. The older `stats` block,
display price fields, references, and publication fields remain as compatibility data.

### `traits.json`

Every slug referenced by an equipment record has one metadata record sourced from the same PF2e
revision's trait configuration and English localization:

```jsonc
{ "slug": "invested", "label": "Invested", "description": "An item with this trait…", "group": "general" }
```

`slug` and `label` are always present. `description` and `group` are `null` where PF2e does not
provide an unambiguous value. Legacy traits retained by equipment after removal from PF2e's active
configuration use a deterministic title-cased slug as their label.

### Stats

The mechanical numbers a player uses to judge an item — damage, AC, penalties, runes — live in a
per-record `stats` object whose **shape is keyed by `type`**. It is present only for the four
combat-relevant types; every other type (`treasure`, `backpack`, `ammo`, generic worn `equipment`,
`kit`) carries `"stats": null`. Switch on the record's `type` to know which shape to read:

```jsonc
// type: "weapon"
"stats": {
  "damage": { "dice": 1, "die": "d8", "damageType": "piercing", "text": "1d8 piercing" }, // null if none
  "category": "martial",              // simple | martial | advanced
  "group": "bow",                     // crit-specialization group; null if unset
  "range": 100,                       // range increment in feet; null for melee-only
  "reload": "0",                      // actions to reload; null when not applicable
  "runes": { "potency": 1, "striking": 1, "property": ["shifting"] } // null when mundane
}
// type: "armor"
"stats": {
  "acBonus": 6, "dexCap": 0, "checkPenalty": -3, "speedPenalty": -10,
  "strength": 4,                      // Str score that removes the check penalty; null if unset
  "category": "heavy",                // unarmored | light | medium | heavy
  "group": "plate",                   // null if unset
  "runes": { "potency": 2, "resilient": 1, "property": ["fortification"] } // null when mundane
}
// type: "shield"
"stats": {
  "acBonus": 2, "hardness": 9, "hp": { "max": 54 }, "speedPenalty": 0,
  "runes": { "reinforcing": 0 }       // null when mundane
}
// type: "consumable"
"stats": {
  "category": "wand",                 // potion | scroll | wand | elixir | poison | bomb | …
  "uses": { "max": 500, "autoDestroy": true }, // multi-charge items only; null when single-use
  "damage": { "formula": "3d6", "damageType": "acid", "text": "3d6 acid" } // bombs; null otherwise
}
```

> **Wands & scrolls** carry the spell they cast as an embedded document rather than a `@UUID` link,
> so it is surfaced in `references[]` as an external `{ "kind": "spell", "name": …, "resolved": false }`
> (deduped against any spell the description already links).

### References

Descriptions link other documents via Foundry `@UUID[…]` enrichers. Rather than flatten those to
bare text (losing the link) we surface each one two ways:

1. **Inline**, as a consistent anchor in `description`:
   `<a class="ref" data-kind="equipment" data-id="4kz3…">Crowbar (Levered)</a>` for in-bundle
   items, or `<a class="ref" data-kind="spell" data-name="Fireball">Fireball</a>` for everything
   else. The anchor text is always the display name, so it degrades gracefully if you ignore the
   attributes. (These are the *only* attributes the sanitizer keeps.)
2. **Structured**, as the per-record `references[]` array above (deduped by kind + target).

`kind` is a normalized category (`equipment`, `spell`, `condition`, `effect`, `action`, `feat`,
`deity`, `creature`, …). **A link is resolved to a bundle-local `id` (`resolved:true`) only when
it targets a pack we actually ship** — `kind:"equipment"` (into `equipment.json`) or
`kind:"effect"` (into `effects.json`) — matched by name (names are unique within each pack). This
makes the equipment↔effect relationship a closed graph in both directions (an item links to its
`Effect: …`, and that effect links back to the item). Every other reference points at a pack this
bundle doesn't ingest (spells, conditions, actions, and the non-equipment `*-effects` packs), so it
carries `{kind, name}` with `resolved:false`: parseable and consistent, but the target lives
outside the bundle. `meta.json` reports `refTotal` / `refResolved` and, as a health signal,
`danglingRefs` — links into a *shipped* pack that nonetheless failed to resolve (expected 0).

### `effects.json` record

Same common fields as an item, minus the physical/economic ones
(`price`/`quantity`/`baseItem`/`bulk`/`usage`/`material`/`stats`), plus a `duration`. These are the
rules an item applies when activated; equipment references them by `kind:"effect"`.

```jsonc
{
  "id": "7Mgp…",
  "name": "Effect: Vaultbreaker's Harness",
  "type": "effect",
  "level": 6,
  "description": "…clean, safe HTML with <a class=\"ref\"> back-links…",
  "rarity": "common",
  "traits": [],
  "duration": { "value": 1, "unit": "minutes", "sustained": false }, // null if none; -1 = indefinite
  "publicationTitle": "Pathfinder #158: Sixty Feet Under",
  "remaster": false,
  "img": "cd34…f.webp",
  "references": [
    { "kind": "equipment", "name": "Vaultbreaker's Harness", "id": "Lmve…", "resolved": true }
  ]
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
  "schemaVersion": 4,
  "upstreamRepo": "foundryvtt/pf2e",
  "upstreamBranch": "v14-dev",        // RESOLVED default branch at build time
  "upstreamSha": "…",                 // exact commit the bundle was built from
  "generatedAt": "2026-07-03T05:00:00.000Z",
  "itemCount": 5672, "traitCount": 400, "effectCount": 690, "iconCount": 0,
  "realIcons": 0, "fallbackIcons": 0, "unresolved": 0, "parseErrors": 0,
  "refTotal": 8566, "refResolved": 2208,  // outbound links; those into shipped packs resolved to id
  "danglingRefs": 0, "ambiguousNames": 0  // health signals — both expected to be 0
}
```

## How it works

- **Source branch is never pinned.** The workflow checks out `foundryvtt/pf2e` with no `ref`,
  so it gets the repo's *default* branch — which pf2e keeps pointed at the current dev branch
  (`v14-dev` → `v15-dev` → …). Major-version bumps are picked up automatically; `meta.json`
  records the resolved branch + commit SHA.
- **Sparse + shallow checkout** of just `packs/pf2e/equipment`, `packs/pf2e/equipment-effects`
  `static/icons`, the English localization, and trait configuration (git-native, no API rate
  limits, no HTTP client). equipment-effects is
  optional: if absent, the build still succeeds and effect links simply stay unresolved.
- **Icons** are deduped by SHA-256 of their bytes and copied as-is (no re-encoding).
  `systems/pf2e/icons/…` resolves to `static/icons/…`; bare `icons/…` (Foundry core art absent
  from this repo) falls back to `static/icons/default-icons/<type>.{webp,svg}` — see the icon
  note above.
- **Prices** are normalized to total copper + a display string (`1 pp = 10 gp = 100 sp = 1000 cp`).
- **Descriptions** are cleaned: action-glyph spans become `(1 action)` etc., `@Check/@Damage` and
  inline `[[/r …]]` rolls are resolved to a readable phrase, and `@UUID[…]` links become
  `<a class="ref">` anchors + a structured `references[]` array (see **References** above). The
  result is run through `sanitize-html` to a safe tag subset. This is **best-effort**, not a full
  Foundry enricher — unusual enrichers may be dropped rather than fully rendered.

## Run it locally

```bash
npm install

# Point at any local pf2e checkout (sparse is fine):
git clone --depth 1 --filter=blob:none --sparse https://github.com/foundryvtt/pf2e pf2e-src
git -C pf2e-src sparse-checkout set packs/pf2e/equipment packs/pf2e/equipment-effects static/icons

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
