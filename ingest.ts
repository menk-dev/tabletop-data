/**
 * treasureboard-data ingest
 * -------------------------
 * Transforms the Foundry VTT PF2e "equipment" pack into a slim, self-contained search
 * bundle. This is the ONLY place that knows anything about the pf2e data shape.
 *
 * Input  (a local sparse checkout of foundryvtt/pf2e, path from PF2E_SRC):
 *   <PF2E_SRC>/packs/pf2e/equipment/*.json   — one flat Foundry document per item
 *   <PF2E_SRC>/static/icons/**               — the icon files those documents reference
 *
 * Output (written to OUT_DIR, default ./dist):
 *   equipment.json   — array of slim EquipmentRecord, sorted by id (stable)
 *   icons/<hash><ext> — every referenced icon, deduped by content hash
 *   meta.json        — provenance: upstream repo/branch/sha, counts, generatedAt
 *
 * The consuming app never sees pf2e; it only downloads this bundle and serves it.
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
// pf2e stores its own icons under static/; an `img` of `systems/pf2e/icons/x` resolves to
// `static/icons/x`. NOTE: ~half of equipment items instead point at bare `icons/<foundry-core>`
// paths (icons/weapons, icons/commodities, …) which are Foundry VTT *core* art — NOT in this
// repo and not ours to redistribute. Those fall back to pf2e's own default-icons/<type> glyphs.
const STATIC_DIR = path.join(PF2E_SRC, "static");
const DEFAULT_ICONS_DIR = path.join(STATIC_DIR, "icons", "default-icons");
const ICONS_OUT_DIR = path.join(OUT_DIR, "icons");

const SCHEMA_VERSION = 1;

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
  baseItem: string | null;
  /** Filename within the bundle's icons/ dir, e.g. "ab12…f.webp"; null if unresolved. */
  img: string | null;
}

// Shape of the bits we read from a raw Foundry equipment document. Everything is optional
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
    publication?: { title?: string; remaster?: boolean };
    traits?: { rarity?: string; value?: string[] };
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

/**
 * Turn Foundry-flavoured HTML (with @UUID/@Check/@Damage enrichers, inline rolls and
 * action-glyph spans) into clean, safe, human-readable HTML. Best-effort: we resolve the
 * common enrichers to their display label / a readable phrase and drop the rest, then run
 * sanitize-html to keep only a safe tag subset. Not a full Foundry enricher — see README.
 */
function cleanDescription(html: string | undefined): string {
  if (!html) return "";
  let out = html;

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

  // Any labelled enricher `@Foo[...]{Label}` -> its label (covers most UUID/Damage/Check refs).
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
      "h1", "h2", "h3", "h4", "blockquote", "span",
    ],
    allowedAttributes: {}, // strip everything (classes, styles, data-*)
  });

  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Fresh output dir every run.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(ICONS_OUT_DIR, { recursive: true });

  const files = (await readdir(EQUIPMENT_DIR)).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`No .json files found in ${EQUIPMENT_DIR}. Is PF2E_SRC a pf2e checkout?`);
  }

  const records: EquipmentRecord[] = [];
  const writtenIcons = new Set<string>(); // hash+ext filenames already copied
  let parseErrors = 0;
  let realIcons = 0; // items that got their bespoke pf2e icon
  let fallbackIcons = 0; // items that fell back to a default-icon glyph
  let unresolved = 0; // items with no icon at all (should be ~0)

  for (const file of files) {
    const full = path.join(EQUIPMENT_DIR, file);
    let doc: RawDoc;
    try {
      doc = JSON.parse(await readFile(full, "utf8")) as RawDoc;
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

    const type = doc.type ?? "equipment";

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
    records.push({
      id: doc._id,
      name: doc.name,
      type,
      level: sys.level?.value ?? 0,
      description: cleanDescription(sys.description?.value),
      rarity: sys.traits?.rarity ?? "common",
      price: normalizePrice(sys.price),
      traits: sys.traits?.value ?? [],
      quantity: sys.quantity ?? 1,
      publicationTitle: sys.publication?.title ?? null,
      remaster: sys.publication?.remaster ?? false,
      baseItem: sys.baseItem ?? null,
      img: imgName,
    });
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  await writeFile(path.join(OUT_DIR, "equipment.json"), JSON.stringify(records));

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    upstreamRepo: UPSTREAM_REPO,
    upstreamBranch: UPSTREAM_BRANCH,
    upstreamSha: UPSTREAM_SHA,
    generatedAt: new Date().toISOString(),
    itemCount: records.length,
    iconCount: writtenIcons.size,
    realIcons,
    fallbackIcons,
    unresolved,
    parseErrors,
  };
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(
    `\n✓ ${records.length} items, ${writtenIcons.size} unique icons ` +
      `(${realIcons} bespoke, ${fallbackIcons} type-fallback, ${unresolved} unresolved, ` +
      `${parseErrors} skipped) from ${UPSTREAM_REPO}@${UPSTREAM_SHA.slice(0, 8)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
