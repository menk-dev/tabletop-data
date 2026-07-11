/**
 * treasureboard-data ingest
 * -------------------------
 * Transforms the Foundry VTT PF2e "equipment" (and closely-related "equipment-effects") packs
 * into a slim, self-contained search bundle. This is the ONLY place that knows anything about the
 * pf2e data shape.
 *
 * Input  (a local sparse checkout of foundryvtt/pf2e, path from PF2E_SRC):
 *   <PF2E_SRC>/packs/pf2e/equipment/*.json         — one flat Foundry document per item
 *   <PF2E_SRC>/packs/pf2e/equipment-effects/*.json — the "Effect: …" docs equipment activates
 *   <PF2E_SRC>/static/icons/**                     — the icon files those documents reference
 *
 * Output (written to OUT_DIR, default ./dist):
 *   equipment.json   — array of slim EquipmentRecord, sorted by id (stable)
 *   effects.json     — array of slim EffectRecord (equipment-effects), sorted by id (stable)
 *   icons/<hash><ext> — every referenced icon, deduped by content hash
 *   meta.json        — provenance: upstream repo/branch/sha, counts, generatedAt
 *
 * Equipment and effects cross-reference each other by name; those links are resolved to
 * bundle-local ids (see cleanDescription / References). The consuming app never sees pf2e; it
 * only downloads this bundle and serves it.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";

// ---------------------------------------------------------------------------
// Config (env-driven; sensible local defaults so `npm run ingest` just works)
// ---------------------------------------------------------------------------
const PF2E_SRC = process.env.PF2E_SRC ?? "./pf2e-src";
const OUT_DIR = process.env.OUT_DIR ?? "./dist";
const UPSTREAM_REPO = process.env.UPSTREAM_REPO ?? "foundryvtt/pf2e";
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH ?? "(unknown)";
const UPSTREAM_SHA = process.env.UPSTREAM_SHA ?? "(unknown)";

const EQUIPMENT_DIR = path.join(PF2E_SRC, "packs", "pf2e", "equipment");
const EQUIPMENT_EFFECTS_DIR = path.join(PF2E_SRC, "packs", "pf2e", "equipment-effects");
// pf2e stores its own icons under static/; an `img` of `systems/pf2e/icons/x` resolves to
// `static/icons/x`. NOTE: ~half of equipment items instead point at bare `icons/<foundry-core>`
// paths (icons/weapons, icons/commodities, …) which are Foundry VTT *core* art — NOT in this
// repo and not ours to redistribute. Those fall back to pf2e's own default-icons/<type> glyphs.
const STATIC_DIR = path.join(PF2E_SRC, "static");
const DEFAULT_ICONS_DIR = path.join(STATIC_DIR, "icons", "default-icons");
const ICONS_OUT_DIR = path.join(OUT_DIR, "icons");
const TRAITS_CONFIG = path.join(PF2E_SRC, "src", "scripts", "config", "traits.ts");
const EN_LOCALIZATION = path.join(PF2E_SRC, "static", "lang", "en.json");

// v4: normalized catalog-family blocks and trait metadata; the v3 stats/reference fields remain
// available as compatibility data.
const SCHEMA_VERSION = 4;

// PF2e coin denominations expressed in copper (the smallest unit).
const COPPER_PER: Record<string, number> = { pp: 1000, gp: 100, sp: 10, cp: 1 };
const DENOM_ORDER = ["pp", "gp", "sp", "cp"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface RawPrice {
  value?: Record<string, number>;
  per?: number;
}

interface Price {
  /** Total value of one `per`-lot, in copper. 0 = free / no listed price. */
  copper: number;
  /** How many units the price buys (e.g. 4 arrows for X). Usually 1. */
  per: number;
  /** Human display, e.g. "2 gp, 5 sp" (with " per 4" suffix when per > 1). */
  text: string;
}

/**
 * A cross-item link parsed out of a description's Foundry `@UUID[...]` enricher.
 * `kind` is a normalized category (equipment/spell/condition/effect/action/feat/…).
 * `id` + `resolved:true` appear ONLY for links that point at a document shipped in this same
 * bundle — i.e. `kind:"equipment"` (into equipment.json) or `kind:"effect"` (into effects.json).
 * Everything else lives in a pack we don't ingest, so it is surfaced by `{kind,name}` with
 * `resolved:false`. See README "References".
 */
interface Reference {
  kind: string;
  name: string;
  id?: string;
  resolved: boolean;
}

/** Encumbrance. `value` is pf2e Bulk (0 = negligible, <1 = Light); `text` renders it ("—"/"L"/"3"). */
/** A precious material and its grade (e.g. cold iron / standard). null when the item is mundane. */
interface Material {
  type: string; // adamantine, cold-iron, silver, dawnsilver, …
  grade: string | null; // low | standard | high
}

/** A dice-pool damage expression, pre-rendered to a display string (e.g. "1d8 piercing"). */
interface WeaponDamage {
  dice: number;
  die: string; // "d4".."d12"
  damageType: string;
  text: string;
}

/** A consumable's fixed damage (bombs), which pf2e stores as a formula string, not a dice pool. */
interface ConsumableDamage {
  formula: string; // "3d6"
  damageType: string;
  text: string; // "3d6 acid"
}

/** Magic runes etched onto a weapon. null when the item carries none. */
interface WeaponRunes {
  potency: number; // +1..+3 to hit
  striking: number; // 1..3 = striking / greater / major (extra damage dice)
  property: string[]; // named property runes, e.g. ["flaming"]
}

/** Magic runes etched onto armor. null when the item carries none. */
interface ArmorRunes {
  potency: number; // +1..+3 to AC
  resilient: number; // 1..3 = resilient / greater / major (bonus to saves)
  property: string[];
}

/** Magic runes etched onto a shield. null when the item carries none. */
interface ShieldRunes {
  reinforcing: number; // tier of reinforcing rune (raises shield Hardness/HP)
}

interface WeaponStats {
  damage: WeaponDamage | null;
  category: string; // simple | martial | advanced
  group: string | null; // bow, sword, … (drives critical specialization)
  range: number | null; // range increment in feet; null for melee-only
  reload: string | null; // actions to reload; null when not applicable
  runes: WeaponRunes | null;
}

interface ArmorStats {
  acBonus: number;
  dexCap: number;
  checkPenalty: number;
  speedPenalty: number;
  strength: number | null; // Strength score to ignore the check penalty; null if unset
  category: string; // light | medium | heavy | unarmored
  group: string | null; // leather, plate, …
  runes: ArmorRunes | null;
}

interface ShieldStats {
  acBonus: number;
  hardness: number; // absorbs this much damage when raised
  hp: { max: number }; // shield breaks at 0 / is destroyed at half
  speedPenalty: number;
  runes: ShieldRunes | null;
}

interface ConsumableStats {
  category: string; // potion | scroll | wand | elixir | poison | bomb | …
  uses: { max: number; autoDestroy: boolean } | null; // multi-charge items only (null when single-use)
  damage: ConsumableDamage | null; // bombs; null otherwise
}

/**
 * Type-specific mechanical stats — the numbers a player uses to judge an item. Present only for the
 * four combat-relevant types; the shape is discriminated by the record's `type`. null for every
 * other type (treasure, backpack, ammo, generic worn equipment, …), which carries no such block.
 */
type ItemStats = WeaponStats | ArmorStats | ShieldStats | ConsumableStats;

interface EquipmentRecord {
  id: string;
  name: string;
  type: string;
  level: number;
  description: string;
  rarity: string;
  price: Price;
  traits: string[];
  quantity: number;
  publicationTitle: string | null;
  remaster: boolean;
  source: { title: string; remaster: boolean } | null;
  baseItem: string | null;
  bulk: number | null;
  usage: string | null;
  hands: number | null;
  /** Precious material + grade, or null when mundane. */
  material: Material | null;
  size: string | null;
  hardness: number | null;
  hp: number | null;
  category: string | null;
  group: string | null;
  weapon?: CatalogWeapon;
  armor?: CatalogArmor;
  consumable?: CatalogConsumable;
  /** Mechanical stat block, shape keyed by `type`; null for types without one. See ItemStats. */
  stats: ItemStats | null;
  /** Filename within the bundle's icons/ dir, e.g. "ab12…f.webp"; null if unresolved. */
  img: string | null;
  /** Deduped outbound links from the description; see Reference. */
  references: Reference[];
}

interface CatalogWeapon {
  damageDice: number | null;
  damageDie: string | null;
  damageType: string | null;
  range: number | null;
  reload: number | null;
  canBeAmmo: boolean;
  splashDamage: number | null;
  potency: number;
  striking: number;
  propertyRunes: string[];
}

interface CatalogArmor {
  acBonus: number;
  dexCap: number;
  checkPenalty: number;
  speedPenalty: number;
  strength: number | null;
  potency: number;
  resilient: number;
  propertyRunes: string[];
}

interface CatalogConsumable {
  category: string | null;
  uses: number;
  maxUses: number;
  effectKind: "damage" | "healing" | null;
  formula: string | null;
  damageType: string | null;
}

interface TraitRecord {
  slug: string;
  label: string;
  description: string | null;
  group: string | null;
}

/** How long an effect lasts. `value` is in `unit`s (-1 / "unlimited" = indefinite). */
interface Duration {
  value: number;
  unit: string;
  sustained: boolean;
}

/**
 * A slim "Effect: …" document from the equipment-effects pack — the rules a piece of equipment
 * applies when activated. Shares equipment's common fields but carries a duration instead of a
 * price. Equipment links to these (kind "effect"); their own descriptions link back to equipment.
 */
interface EffectRecord {
  id: string;
  name: string;
  type: string;
  level: number;
  description: string;
  rarity: string;
  traits: string[];
  duration: Duration | null;
  publicationTitle: string | null;
  remaster: boolean;
  img: string | null;
  references: Reference[];
}

// Shape of the bits we read from a raw Foundry equipment/effect document. Everything is optional
// because upstream is a moving dev branch and we default defensively.
interface RawDoc {
  _id?: string;
  name?: string;
  type?: string;
  img?: string;
  system?: {
    level?: { value?: number };
    quantity?: number;
    baseItem?: string | null;
    description?: { value?: string };
    price?: RawPrice;
    duration?: { value?: number; unit?: string; sustained?: boolean };
    publication?: { title?: string; remaster?: boolean };
    traits?: { rarity?: string; value?: string[] };
    // --- v3 mechanical fields (all optional; shapes vary by item type) ---
    bulk?: { value?: number };
    usage?: { value?: string; hands?: number | string; canBeAmmo?: boolean };
    material?: { type?: string | null; grade?: string | null };
    size?: string;
    // weapon
    damage?: { damageType?: string; dice?: number; die?: string; formula?: string; type?: string };
    category?: string; // weapon / armor / consumable proficiency-or-kind
    group?: string | null; // weapon / armor group
    range?: number | null; // weapon range increment
    reload?: { value?: string | number };
    splashDamage?: { value?: number } | number;
    runes?: {
      potency?: number;
      striking?: number;
      resilient?: number;
      reinforcing?: number;
      property?: string[];
    };
    // armor / shield
    acBonus?: number;
    dexCap?: number;
    checkPenalty?: number;
    speedPenalty?: number;
    strength?: number | null;
    hardness?: number;
    hp?: { max?: number; value?: number };
    // consumable
    uses?: { max?: number; value?: number; autoDestroy?: boolean };
    spell?: { name?: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function normalizePrice(raw: RawPrice | undefined): Price {
  const value = raw?.value ?? {};
  const per = raw?.per && raw.per > 0 ? raw.per : 1;
  let copper = 0;
  const parts: string[] = [];
  for (const denom of DENOM_ORDER) {
    const amount = value[denom];
    if (typeof amount === "number" && amount !== 0) {
      copper += amount * COPPER_PER[denom];
      parts.push(`${amount} ${denom}`);
    }
  }
  let text = parts.join(", ");
  if (text && per > 1) text += ` per ${per}`;
  return { copper, per, text };
}

function normalizeDuration(
  raw: { value?: number; unit?: string; sustained?: boolean } | undefined,
): Duration | null {
  if (!raw || raw.unit == null) return null;
  return {
    value: typeof raw.value === "number" ? raw.value : 0,
    unit: raw.unit,
    sustained: Boolean(raw.sustained),
  };
}

function normalizeBulk(raw: { value?: number } | undefined): number | null {
  return typeof raw?.value === "number" ? raw.value : null;
}

function normalizeUsage(raw: { value?: string } | undefined): string | null {
  const value = raw?.value?.trim();
  return value || null;
}

function normalizeHands(raw: number | string | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const match = /^\d+/.exec(raw.trim());
  return match ? Number(match[0]) : null;
}

/** Precious-material block -> {type, grade}, or null when the item is mundane. */
function normalizeMaterial(
  raw: { type?: string | null; grade?: string | null } | undefined,
): Material | null {
  if (!raw?.type) return null;
  return { type: raw.type, grade: raw.grade ?? null };
}

/** Weapon damage {damageType, dice, die} -> pool + "1d8 piercing" text; null if incomplete. */
function normalizeWeaponDamage(
  raw: { damageType?: string; dice?: number; die?: string } | undefined,
): WeaponDamage | null {
  if (!raw?.die || !raw.damageType) return null;
  const dice = typeof raw.dice === "number" ? raw.dice : 1;
  return { dice, die: raw.die, damageType: raw.damageType, text: `${dice}${raw.die} ${raw.damageType}` };
}

/** Consumable damage {formula, type} (bombs) -> formula + "3d6 acid" text; null if none. */
function normalizeConsumableDamage(
  raw: { formula?: string; type?: string } | undefined,
): ConsumableDamage | null {
  if (!raw?.formula) return null;
  const damageType = raw.type ?? "";
  return {
    formula: raw.formula,
    damageType,
    text: damageType ? `${raw.formula} ${damageType}` : raw.formula,
  };
}

/** Actions-to-reload -> string, or null when not applicable ("", "-", or absent). */
function normalizeReload(raw: { value?: string | number } | undefined): string | null {
  if (raw?.value == null) return null;
  const s = String(raw.value).trim();
  return s === "" || s === "-" ? null : s;
}

function numericReload(raw: { value?: string | number } | undefined): number | null {
  const value = normalizeReload(raw);
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function catalogWeapon(sys: NonNullable<RawDoc["system"]>): CatalogWeapon {
  const splash = typeof sys.splashDamage === "number" ? sys.splashDamage : sys.splashDamage?.value;
  return {
    damageDice: typeof sys.damage?.dice === "number" ? sys.damage.dice : null,
    damageDie: sys.damage?.die ?? null,
    damageType: sys.damage?.damageType ?? null,
    range: typeof sys.range === "number" ? sys.range : null,
    reload: numericReload(sys.reload),
    canBeAmmo: Boolean(sys.usage?.canBeAmmo),
    splashDamage: typeof splash === "number" ? splash : null,
    potency: sys.runes?.potency ?? 0,
    striking: sys.runes?.striking ?? 0,
    propertyRunes: sys.runes?.property ?? [],
  };
}

function catalogArmor(sys: NonNullable<RawDoc["system"]>): CatalogArmor {
  return {
    acBonus: sys.acBonus ?? 0,
    dexCap: sys.dexCap ?? 0,
    checkPenalty: sys.checkPenalty ?? 0,
    speedPenalty: sys.speedPenalty ?? 0,
    strength: typeof sys.strength === "number" ? sys.strength : null,
    potency: sys.runes?.potency ?? 0,
    resilient: sys.runes?.resilient ?? 0,
    propertyRunes: sys.runes?.property ?? [],
  };
}

function catalogConsumable(sys: NonNullable<RawDoc["system"]>): CatalogConsumable {
  const maxUses = typeof sys.uses?.max === "number" && sys.uses.max > 0 ? sys.uses.max : 1;
  const uses = typeof sys.uses?.value === "number" ? sys.uses.value : maxUses;
  const formula = sys.damage?.formula ?? null;
  return {
    category: sys.category ?? null,
    uses,
    maxUses,
    effectKind: formula ? "damage" : sys.traits?.value?.includes("healing") ? "healing" : null,
    formula,
    damageType: formula ? (sys.damage?.type ?? null) : null,
  };
}

type RawRunes = {
  potency?: number;
  striking?: number;
  resilient?: number;
  reinforcing?: number;
  property?: string[];
} | undefined;

/** Weapon runes -> {potency, striking, property}, or null when the weapon carries none. */
function weaponRunes(raw: RawRunes): WeaponRunes | null {
  const potency = raw?.potency ?? 0;
  const striking = raw?.striking ?? 0;
  const property = raw?.property ?? [];
  if (!potency && !striking && property.length === 0) return null;
  return { potency, striking, property };
}

/** Armor runes -> {potency, resilient, property}, or null when the armor carries none. */
function armorRunes(raw: RawRunes): ArmorRunes | null {
  const potency = raw?.potency ?? 0;
  const resilient = raw?.resilient ?? 0;
  const property = raw?.property ?? [];
  if (!potency && !resilient && property.length === 0) return null;
  return { potency, resilient, property };
}

/** Shield runes -> {reinforcing}, or null when the shield carries none. */
function shieldRunes(raw: RawRunes): ShieldRunes | null {
  const reinforcing = raw?.reinforcing ?? 0;
  return reinforcing ? { reinforcing } : null;
}

/** Multi-charge tracking -> {max, autoDestroy}; null for single-use items (max <= 1). */
function normalizeUses(
  raw: { max?: number; autoDestroy?: boolean } | undefined,
): { max: number; autoDestroy: boolean } | null {
  if (typeof raw?.max !== "number" || raw.max <= 1) return null;
  return { max: raw.max, autoDestroy: Boolean(raw.autoDestroy) };
}

/**
 * Build the type-specific mechanical stat block a player reads to judge an item. Only weapon,
 * armor, shield and consumable carry one; every other type returns null. Shape is discriminated by
 * `type` (see ItemStats) — the consumer switches on the record's `type` to know which shape to read.
 */
function buildStats(type: string, sys: NonNullable<RawDoc["system"]>): ItemStats | null {
  switch (type) {
    case "weapon":
      return {
        damage: normalizeWeaponDamage(sys.damage),
        category: sys.category ?? "",
        group: sys.group ?? null,
        range: typeof sys.range === "number" ? sys.range : null,
        reload: normalizeReload(sys.reload),
        runes: weaponRunes(sys.runes),
      };
    case "armor":
      return {
        acBonus: sys.acBonus ?? 0,
        dexCap: sys.dexCap ?? 0,
        checkPenalty: sys.checkPenalty ?? 0,
        speedPenalty: sys.speedPenalty ?? 0,
        strength: typeof sys.strength === "number" ? sys.strength : null,
        category: sys.category ?? "",
        group: sys.group ?? null,
        runes: armorRunes(sys.runes),
      };
    case "shield":
      return {
        acBonus: sys.acBonus ?? 0,
        hardness: sys.hardness ?? 0,
        hp: { max: sys.hp?.max ?? 0 },
        speedPenalty: sys.speedPenalty ?? 0,
        runes: shieldRunes(sys.runes),
      };
    case "consumable":
      return {
        category: sys.category ?? "",
        uses: normalizeUses(sys.uses),
        damage: normalizeConsumableDamage(sys.damage),
      };
    default:
      return null;
  }
}

/** Absolute path under static/ for a literal Foundry `img`, or null if the path is unusable. */
function explicitIconPath(img: string | undefined): string | null {
  if (!img) return null;
  let rel = img.trim();
  if (rel.startsWith("systems/pf2e/")) rel = rel.slice("systems/pf2e/".length);
  if (rel.startsWith("/") || rel.includes("..")) return null; // no traversal / absolute paths
  return path.join(STATIC_DIR, rel);
}

/**
 * Ordered list of candidate icon source paths to try for an item. The literal pf2e icon comes
 * first; when it doesn't exist (Foundry-core `icons/…` paths we can't ship), we fall back to
 * pf2e's own type-based default-icon so every item still gets a local, licensed image.
 */
function iconCandidates(img: string | undefined, type: string): string[] {
  const candidates: string[] = [];
  const explicit = explicitIconPath(img);
  if (explicit) candidates.push(explicit);
  for (const name of [`${type}.webp`, `${type}.svg`, "equipment.webp", "mystery-man.svg"]) {
    candidates.push(path.join(DEFAULT_ICONS_DIR, name));
  }
  return candidates;
}

// Name<->id index for ONE ingested source (its docs), so descriptions can resolve links into it.
// Built in pass 1 (once every doc's name/id is known) before any description is cleaned.
interface SourceIndex {
  nameToId: Map<string, string>; // doc name -> its Foundry _id (unique within the source)
  idToName: Map<string, string>; // _id -> name (for the rare id-form reference)
  ambiguous: Set<string>; // names shared by >1 doc — never auto-resolved
}
// One index per ingested source, keyed by the source's resolver key ("equipment" | "effect").
interface RefResolver {
  byKind: Map<string, SourceIndex>;
}
function indexFor(resolver: RefResolver, key: string): SourceIndex {
  let idx = resolver.byKind.get(key);
  if (!idx) {
    idx = { nameToId: new Map(), idToName: new Map(), ambiguous: new Set() };
    resolver.byKind.set(key, idx);
  }
  return idx;
}

// Compendium pack id -> the resolver key of the local source that ingests it. ONLY packs we
// actually bundle appear here; a reference into any other pack is surfaced but left unresolved
// (and never counted as dangling). The resolver key equals the reference `kind` for our sources.
// Note equipment-effects resolves but its sibling *-effects packs (spell-effects, …) do NOT — they
// share the "effect" kind for display yet live outside the bundle.
const PACK_SOURCE: Record<string, string> = {
  "equipment-srd": "equipment", equipment: "equipment",
  "equipment-effects": "effect",
};

// Foundry pack id -> a stable, normalized reference kind the consumer can switch on. Packs not
// listed fall through packToKind()'s heuristics. equipment-srd is the compendium id of the very
// pack we ingest (whose on-disk folder is `equipment`), so both map to "equipment".
const PACK_KIND: Record<string, string> = {
  "equipment-srd": "equipment", equipment: "equipment",
  "spells-srd": "spell",
  conditionitems: "condition",
  "equipment-effects": "effect", "spell-effects": "effect", "other-effects": "effect",
  "bestiary-effects": "effect", "feat-effects": "effect", "campaign-effects": "effect",
  actionspf2e: "action",
  "feats-srd": "feat", classfeatures: "feat", ancestryfeatures: "feat",
  deities: "deity",
  journals: "journal",
  "rollable-tables": "table",
  vehicles: "vehicle",
  "familiar-abilities": "familiar-ability",
  "bestiary-ability-glossary-srd": "creature-ability",
};
function packToKind(pack: string): string {
  if (PACK_KIND[pack]) return PACK_KIND[pack];
  if (/bestiar|monster/i.test(pack)) return "creature";
  return "other";
}

/** Escape a string for safe interpolation into HTML text or a double-quoted attribute. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FOUNDRY_ID = /^[A-Za-z0-9]{16}$/;

/**
 * Turn Foundry-flavoured HTML (with @UUID/@Check/@Damage enrichers, inline rolls and
 * action-glyph spans) into clean, safe, human-readable HTML, AND collect the cross-item links.
 *
 * Every `@UUID[...]` (labelled or not) becomes a consistent `<a class="ref">` anchor whose text
 * is the display name and whose `data-kind` + (`data-id` | `data-name`) let a consumer render a
 * real link — while the same links are also returned as a deduped structured list so consumers
 * don't have to parse HTML. Links into a pack we bundle (equipment, equipment-effects) are
 * resolved to their bundle-local id; links into packs we don't ingest carry `data-name` only.
 * Other enrichers (@Check/@Damage, inline rolls, action glyphs) are still flattened to text.
 * `dangling` counts links that pointed at a bundled pack yet failed to resolve (expected 0).
 * Best-effort — see README.
 */
function cleanDescription(
  html: string | undefined,
  resolver: RefResolver,
): { html: string; references: Reference[]; dangling: number } {
  if (!html) return { html: "", references: [], dangling: 0 };
  let out = html;
  const refs: Reference[] = [];
  let dangling = 0;

  // Action-glyph spans -> readable text. Letters/digits map to the action economy.
  const GLYPH: Record<string, string> = {
    "1": "(1 action)", a: "(1 action)",
    "2": "(2 actions)", d: "(2 actions)",
    "3": "(3 actions)", t: "(3 actions)",
    r: "(reaction)", f: "(free action)",
  };
  out = out.replace(
    /<span[^>]*class="[^"]*action-glyph[^"]*"[^>]*>\s*([^<\s])\s*<\/span>/gi,
    (_m, ch: string) => GLYPH[ch.toLowerCase()] ?? "",
  );

  // @UUID[...] (labelled or not) -> a structured, consistent <a class="ref"> anchor + a Reference.
  // Handled BEFORE the generic labelled-enricher flatten below so labelled UUIDs keep their target.
  out = out.replace(
    /@UUID\[([^\]]*)\](?:\{([^}]*)\})?/g,
    (_m, body: string, label: string | undefined) => {
      const parts = body.split(".");
      // Only Compendium.<scope>.<pack>.<DocType>.<target…> carries a pack + resolvable target.
      if (parts[0] !== "Compendium" || parts.length < 5) {
        return (label ?? parts[parts.length - 1] ?? "").trim(); // world/relative ref -> plain text
      }
      const pack = parts[2];
      const target = parts.slice(4).join("."); // a doc name, or (rarely) a 16-char Foundry id
      const kind = packToKind(pack);
      const byId = FOUNDRY_ID.test(target);

      // Resolve links into a pack we bundle (equipment, equipment-effects) to a bundle-local id;
      // leave links into un-ingested packs external. `idx` is defined iff we ingest `pack`, so a
      // miss there is a genuine dangling link — whereas a miss with no `idx` is simply external.
      const srcKey = PACK_SOURCE[pack];
      const idx = srcKey ? resolver.byKind.get(srcKey) : undefined;
      let id: string | undefined;
      let resolved = false;
      let name = (label ?? (byId ? "" : target)).trim();
      if (idx) {
        if (byId) {
          if (idx.idToName.has(target)) {
            id = target;
            resolved = true;
            if (!name) name = idx.idToName.get(target)!;
          }
        } else if (!idx.ambiguous.has(target)) {
          const rid = idx.nameToId.get(target);
          if (rid) {
            id = rid;
            resolved = true;
          }
        }
        if (!resolved) dangling++;
      }
      if (!name) name = target; // last-resort display fallback (e.g. unresolved id-form ref)

      refs.push({ kind, name, ...(id ? { id } : {}), resolved });
      const attrs = id
        ? `data-kind="${kind}" data-id="${esc(id)}"`
        : `data-kind="${esc(kind)}" data-name="${esc(name)}"`;
      return `<a class="ref" ${attrs}>${esc(name || "link")}</a>`;
    },
  );

  // Any remaining labelled enricher `@Foo[...]{Label}` -> its label (@Damage/@Check/etc.).
  out = out.replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1");

  // Unlabelled @Check[type:reflex|dc:20|...] -> "reflex check".
  out = out.replace(/@Check\[([^\]]*)\]/g, (_m, body: string) => {
    const type = /type:([a-z-]+)/i.exec(body)?.[1] ?? body.split("|")[0];
    return type ? `${type} check` : "";
  });

  // Unlabelled @Damage[2d6[acid]] -> "2d6 acid".
  out = out.replace(/@Damage\[([^\]]*)\]/g, (_m, body: string) =>
    body.replace(/\[/g, " ").replace(/\]/g, "").replace(/\|.*$/, "").trim(),
  );

  // Any remaining unlabelled enricher -> drop.
  out = out.replace(/@\w+\[[^\]]*\]/g, "");

  // Inline rolls: [[/r 1d6]] / [[/br 2d8]] -> the formula; bare [[...]] -> drop.
  out = out.replace(/\[\[\/[a-z]+\s+([^\]]+?)(?:\s*#[^\]]*)?\]\]/gi, "$1");
  out = out.replace(/\[\[[^\]]*\]\]/g, "");

  out = sanitizeHtml(out, {
    allowedTags: [
      "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sup", "sub",
      "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th",
      "h1", "h2", "h3", "h4", "blockquote", "span", "a",
    ],
    // Keep only our reference anchor's attributes; strip everything else (styles, data-*, href…).
    allowedAttributes: { a: ["class", "data-kind", "data-id", "data-name"] },
  });

  // Dedup references by kind + (id || name), preserving first-seen order.
  const seen = new Set<string>();
  const references = refs.filter((r) => {
    const key = `${r.kind} ${r.id ?? r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { html: out.replace(/\s+/g, " ").trim(), references, dangling };
}

function localizationValue(root: unknown, dottedKey: string): string | null {
  let value: unknown = root;
  for (const part of dottedKey.split(".")) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function traitLabelFallback(slug: string): string {
  return slug.split("-").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function directTraitEntries(source: string, objectName: string): Map<string, string> {
  const declaration = new RegExp(`const ${objectName}(?:\\s*:[^=]+)?\\s*=\\s*\\{`).exec(source);
  if (!declaration) return new Map();
  const start = declaration.index + declaration[0].length;
  const end = source.indexOf("\n};", start);
  if (end < 0) return new Map();
  const entries = new Map<string, string>();
  const pattern = /^\s*(?:"([^"]+)"|([a-zA-Z][\w-]*)):\s*"(PF2E\.[^"]+)"/gm;
  for (const match of source.slice(start, end).matchAll(pattern)) {
    entries.set(match[1] ?? match[2], match[3]);
  }
  return entries;
}

async function buildTraits(slugs: Set<string>): Promise<TraitRecord[]> {
  const [config, localizationText] = await Promise.all([
    readFile(TRAITS_CONFIG, "utf8"),
    readFile(EN_LOCALIZATION, "utf8"),
  ]);
  const localization = JSON.parse(localizationText) as unknown;
  const families = ["equipmentTraits", "weaponTraits", "armorTraits", "consumableTraits", "shieldTraits"];
  const familyMaps = new Map(families.map((name) => [name, directTraitEntries(config, name)]));
  const descriptions = directTraitEntries(config, "traitDescriptions");
  const allLabels = new Map<string, string>();
  const labelPattern = /^\s*(?:"([^"]+)"|([a-zA-Z][\w-]*)):\s*"(PF2E\.Trait(?!Description)[^"]+)"/gm;
  for (const match of config.matchAll(labelPattern)) allLabels.set(match[1] ?? match[2], match[3]);
  for (const family of familyMaps.values()) {
    for (const [slug, key] of family) allLabels.set(slug, key);
  }

  return [...slugs].sort().map((slug) => {
    const labelKey = allLabels.get(slug);
    // The moving PF2e equipment pack can retain legacy alignment traits after their active config
    // and localization entries are removed (for example `chaotic`). Keep the catalog complete with
    // a deterministic slug-derived label; descriptions/groups remain null when no source exists.
    const label = (labelKey ? localizationValue(localization, labelKey) : null) ?? traitLabelFallback(slug);
    const descriptionKey = descriptions.get(slug);
    const memberships = families.filter((family) => familyMaps.get(family)?.has(slug));
    const group = memberships.length === 1
      ? memberships[0].replace(/Traits$/, "").replace(/^equipment$/, "general")
      : memberships.length > 1 ? "general" : null;
    return {
      slug,
      label,
      description: descriptionKey ? localizationValue(localization, descriptionKey) : null,
      group,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Fresh output dir every run.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(ICONS_OUT_DIR, { recursive: true });

  // The packs we ingest, in output order. `key` is both the resolver key and the reference kind;
  // `required` sources hard-fail if absent, optional ones are skipped with a warning (so a local
  // checkout that didn't sparse-fetch equipment-effects still builds — its links stay external).
  const SOURCES = [
    { dir: EQUIPMENT_DIR, key: "equipment", required: true },
    { dir: EQUIPMENT_EFFECTS_DIR, key: "effect", required: false },
  ] as const;

  const writtenIcons = new Set<string>(); // hash+ext filenames already copied
  let parseErrors = 0;
  let realIcons = 0; // docs that got their bespoke pf2e icon
  let fallbackIcons = 0; // docs that fell back to a default-icon glyph
  let unresolved = 0; // docs with no icon at all (should be ~0)

  // --- Pass 1: parse every valid doc and index name<->id per source, so descriptions can resolve
  // references (which target docs BY NAME) to a bundle-local id — including the two directions of
  // the equipment<->effect link. ---
  const docs: { key: string; file: string; doc: RawDoc }[] = [];
  const resolver: RefResolver = { byKind: new Map() };
  for (const src of SOURCES) {
    let files: string[];
    try {
      files = (await readdir(src.dir)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      if (src.required) {
        throw new Error(`Cannot read ${src.dir}. Is PF2E_SRC a pf2e checkout?`);
      }
      console.warn(`· optional source absent, skipping: ${src.dir}`);
      continue;
    }
    if (files.length === 0) {
      if (src.required) throw new Error(`No .json files in ${src.dir}. Is PF2E_SRC a pf2e checkout?`);
      continue;
    }
    const idx = indexFor(resolver, src.key);
    for (const file of files) {
      let doc: RawDoc;
      try {
        doc = JSON.parse(await readFile(path.join(src.dir, file), "utf8")) as RawDoc;
      } catch {
        parseErrors++;
        console.warn(`! skip (bad JSON): ${file}`);
        continue;
      }
      if (!doc._id || !doc.name) {
        parseErrors++;
        console.warn(`! skip (missing _id/name): ${file}`);
        continue;
      }
      docs.push({ key: src.key, file, doc });
      idx.idToName.set(doc._id, doc.name);
      // Names are unique within each source in practice; if two ever collide, refuse to
      // auto-resolve that name (we can't know which doc was meant) and record it as ambiguous.
      if (idx.nameToId.has(doc.name)) idx.ambiguous.add(doc.name);
      else idx.nameToId.set(doc.name, doc._id);
    }
  }

  // --- Pass 2: resolve icons, clean descriptions (+ collect references), build records. ---
  const records: EquipmentRecord[] = [];
  const effects: EffectRecord[] = [];
  let danglingRefs = 0;
  for (const { key, file, doc } of docs) {
    const type = doc.type ?? (key === "effect" ? "effect" : "equipment");

    // Resolve + dedup the icon: real pf2e art if present, else a type default-icon.
    let imgName: string | null = null;
    const candidates = iconCandidates(doc.img, type);
    for (let i = 0; i < candidates.length; i++) {
      const srcPath = candidates[i];
      let bytes: Buffer;
      try {
        bytes = await readFile(srcPath);
      } catch {
        continue; // try next candidate
      }
      const ext = path.extname(srcPath).toLowerCase() || ".webp";
      const name = `${sha256(bytes)}${ext}`;
      if (!writtenIcons.has(name)) {
        await copyFile(srcPath, path.join(ICONS_OUT_DIR, name));
        writtenIcons.add(name);
      }
      imgName = name;
      if (i === 0) realIcons++;
      else fallbackIcons++;
      break;
    }
    if (imgName === null) {
      unresolved++;
      console.warn(`  · no icon resolved for ${file} (img: ${doc.img})`);
    }

    const sys = doc.system ?? {};
    const cleaned = cleanDescription(sys.description?.value, resolver);
    danglingRefs += cleaned.dangling;

    // A wand/scroll carries its spell as an embedded doc rather than a @UUID link; surface it as an
    // (unresolved, external) spell reference so consumers see what the item casts. Skip if the
    // description already linked the same spell.
    if (type === "consumable" && sys.spell?.name) {
      const spellName = sys.spell.name;
      if (!cleaned.references.some((r) => r.kind === "spell" && r.name === spellName)) {
        cleaned.references.push({ kind: "spell", name: spellName, resolved: false });
      }
    }

    // Common fields shared by both record shapes.
    const common = {
      id: doc._id!,
      name: doc.name!,
      type,
      level: sys.level?.value ?? 0,
      description: cleaned.html,
      rarity: sys.traits?.rarity ?? "common",
      traits: sys.traits?.value ?? [],
      publicationTitle: sys.publication?.title ?? null,
      remaster: sys.publication?.remaster ?? false,
      img: imgName,
      references: cleaned.references,
    };

    if (key === "effect") {
      effects.push({ ...common, duration: normalizeDuration(sys.duration) });
    } else {
      records.push({
        ...common,
        price: normalizePrice(sys.price),
        quantity: sys.quantity ?? 1,
        source: sys.publication?.title
          ? { title: sys.publication.title, remaster: Boolean(sys.publication.remaster) }
          : null,
        baseItem: sys.baseItem ?? null,
        bulk: normalizeBulk(sys.bulk),
        usage: normalizeUsage(sys.usage),
        hands: normalizeHands(sys.usage?.hands),
        material: normalizeMaterial(sys.material),
        size: sys.size ?? null,
        hardness: typeof sys.hardness === "number" ? sys.hardness : null,
        hp: typeof sys.hp?.max === "number" ? sys.hp.max : null,
        category: sys.category ?? null,
        group: sys.group ?? null,
        ...(type === "weapon" ? { weapon: catalogWeapon(sys) } : {}),
        ...(type === "armor" ? { armor: catalogArmor(sys) } : {}),
        ...(type === "consumable" ? { consumable: catalogConsumable(sys) } : {}),
        stats: buildStats(type, sys),
      });
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  records.sort(byId);
  effects.sort(byId);
  const traitSlugs = new Set(records.flatMap((record) => record.traits));
  const traits = await buildTraits(traitSlugs);

  // Reference tallies for provenance: how many links we surfaced and how many resolved in-bundle.
  // `danglingRefs` (a health signal, expected 0) is accumulated above from links that pointed at
  // a bundled pack yet missed. `ambiguousNames` sums the never-resolved colliding names per source.
  let refTotal = 0;
  let refResolved = 0;
  for (const r of [...records, ...effects]) {
    for (const ref of r.references) {
      refTotal++;
      if (ref.resolved) refResolved++;
    }
  }
  let ambiguousNames = 0;
  for (const idx of resolver.byKind.values()) ambiguousNames += idx.ambiguous.size;

  await writeFile(path.join(OUT_DIR, "equipment.json"), JSON.stringify(records));
  await writeFile(path.join(OUT_DIR, "effects.json"), JSON.stringify(effects));
  await writeFile(path.join(OUT_DIR, "traits.json"), JSON.stringify(traits));

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    upstreamRepo: UPSTREAM_REPO,
    upstreamBranch: UPSTREAM_BRANCH,
    upstreamSha: UPSTREAM_SHA,
    generatedAt: new Date().toISOString(),
    itemCount: records.length,
    traitCount: traits.length,
    effectCount: effects.length,
    iconCount: writtenIcons.size,
    realIcons,
    fallbackIcons,
    unresolved,
    parseErrors,
    refTotal,
    refResolved,
    danglingRefs,
    ambiguousNames,
  };
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(
    `\n✓ ${records.length} items + ${effects.length} effects, ${writtenIcons.size} unique icons ` +
      `(${realIcons} bespoke, ${fallbackIcons} type-fallback, ${unresolved} unresolved, ` +
      `${parseErrors} skipped) from ${UPSTREAM_REPO}@${UPSTREAM_SHA.slice(0, 8)}\n` +
      `  ${refTotal} references (${refResolved} resolved in-bundle, ${danglingRefs} dangling` +
      `${ambiguousNames ? `, ${ambiguousNames} ambiguous names` : ""})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
