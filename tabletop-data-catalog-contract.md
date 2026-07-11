# Treasure Board catalog bundle schema v2

The `tabletop-data` release consumed by Campaign Accountant must publish a schema-version 2 bundle.

## Archive entries

- `meta.json`: set `schemaVersion` to `2` and retain the existing provenance fields.
- `equipment.json`: JSON array using the item contract below.
- `traits.json`: JSON array using the trait contract below.
- `icons/`: unchanged content-addressable image inputs referenced by `img`.

## Equipment item

Existing required fields remain: `id`, `name`, `type`, `rarity`, `level`, `price.copper`, `traits`, `description`, and optional `img`.

Add these normalized optional fields. Use `null` when a value is absent or inapplicable; do not emit numeric zero as a substitute for an inapplicable value.

```json
{
  "bulk": 0.1,
  "usage": "held-in-one-hand",
  "hands": 1,
  "source": { "title": "Player Core", "remaster": true },
  "material": { "type": "cold-iron", "grade": "standard" },
  "size": "med",
  "hardness": 5,
  "hp": 20,
  "category": "martial",
  "group": "sword",
  "baseItem": "longsword",
  "weapon": {
    "damageDice": 1, "damageDie": "d8", "damageType": "slashing",
    "range": null, "reload": null, "canBeAmmo": false, "splashDamage": null,
    "potency": 0, "striking": 0, "propertyRunes": []
  },
  "armor": {
    "acBonus": 6, "dexCap": 0, "checkPenalty": -3, "speedPenalty": -10,
    "strength": 4, "potency": 0, "resilient": 0, "propertyRunes": []
  },
  "consumable": {
    "category": "potion", "uses": 1, "maxUses": 1,
    "effectKind": "healing", "formula": "1d8", "damageType": null
  }
}
```

Rules:

- Slugs and enum-like values are stable lowercase kebab-case.
- `price.copper` remains an integer.
- `bulk` is numeric in normal Bulk units (`0.1` represents light Bulk and `0` negligible Bulk).
- `hands`, ranges, counts, bonuses, penalties, HP, and hardness are JSON numbers.
- Only emit `weapon`, `armor`, or `consumable` for the applicable item family.
- Preserve the complete normalized object; Campaign Accountant stores it as JSONB.

## Trait metadata

```json
{
  "slug": "invested",
  "label": "Invested",
  "description": "An item with this trait...",
  "group": "general"
}
```

`slug` and `label` are required. `description` and `group` may be null. Include metadata for every trait referenced by an equipment item. Resolve labels/descriptions from PF2e localization/configuration during bundle generation; equipment records alone only contain slugs.

## Acceptance samples

Publish at least one ordinary gear item, weapon, armor, and consumable exercising the applicable fields. The v2 bundle must be generated from the configured Foundry revision and must not derive activation, access, frequency, requirements, PFS status, spoilers, or arbitrary mechanical effects from description prose.
