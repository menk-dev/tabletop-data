import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("generates schema v5 records, check bonuses, and trait metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-v5-"));
  const source = path.join(root, "pf2e");
  const pack = path.join(source, "packs/pf2e/equipment");
  const effectPack = path.join(source, "packs/pf2e/equipment-effects");
  const out = path.join(root, "dist");
  await mkdir(pack, { recursive: true });
  await mkdir(effectPack, { recursive: true });
  await mkdir(path.join(source, "static/lang"), { recursive: true });
  await mkdir(path.join(source, "src/scripts/config"), { recursive: true });
  const common = {
    img: "missing.webp",
    system: { level: { value: 1 }, description: { value: "<p>Structured only.</p>" },
      price: { value: { gp: 1 } }, publication: { title: "Player Core", remaster: true },
      bulk: { value: 0.1 }, usage: { value: "held-in-one-hand", hands: 1 },
      traits: { rarity: "common", value: ["invested", "chaotic"] } },
  };
  const docs = [
    { ...common, _id: "aaaaaaaaaaaaaaaa", name: "Gear", type: "equipment", system: {
      ...common.system,
      rules: [
        { key: "FlatModifier", selector: ["athletics", "perception", "attack"], type: "item",
          value: 2, predicate: ["action:climb"] },
        { key: "FlatModifier", selector: "arcana", value: "@item.system.runes.potency" },
        { key: "FlatModifier", selector: "dex-skill-check", type: "circumstance", value: -1 },
        { key: "FlatModifier", selector: "{item|flags.system.rulesSelections.skill}", value: 1 },
        { key: "FlatModifier", selector: "saving-throw", value: 3 },
        { key: "FlatModifier", selector: "medicine", value: { invalid: true } },
        null,
      ],
    } },
    { ...common, _id: "bbbbbbbbbbbbbbbb", name: "Sword", type: "weapon", system: {
      ...common.system, baseItem: "longsword", category: "martial", group: "sword", size: "med",
      damage: { dice: 1, die: "d8", damageType: "slashing" }, reload: { value: "-" },
      runes: { potency: 0, striking: 0, property: [] }, usage: { ...common.system.usage, canBeAmmo: false } } },
    { ...common, _id: "cccccccccccccccc", name: "Plate", type: "armor", system: {
      ...common.system, category: "heavy", group: "plate", acBonus: 6, dexCap: 0,
      checkPenalty: -3, speedPenalty: -10, strength: 4 } },
    { ...common, _id: "dddddddddddddddd", name: "Acid", type: "consumable", system: {
      ...common.system, category: "bomb", uses: { value: 1, max: 1 },
      damage: { formula: "1d6", type: "acid" } } },
  ];
  await Promise.all(docs.map((doc) => writeFile(path.join(pack, `${doc._id}.json`), JSON.stringify(doc))));
  await writeFile(path.join(effectPack, "effect.json"), JSON.stringify({
    ...common, _id: "eeeeeeeeeeeeeeee", name: "Effect: Gear", type: "effect", system: {
      ...common.system,
      rules: [{ key: "FlatModifier", selector: ["sailing-lore", "skill-check"], value: 1 }],
    },
  }));
  await writeFile(path.join(source, "src/scripts/config/traits.ts"), `
const equipmentTraits = {
 invested: "PF2E.TraitInvested",
};
const weaponTraits = {
 invested: "PF2E.TraitInvested",
};
const armorTraits = {
 invested: "PF2E.TraitInvested",
};
const consumableTraits = {
 invested: "PF2E.TraitInvested",
};
const shieldTraits = {
};
const traitDescriptions: Record<string, string> = {
 invested: "PF2E.TraitDescriptionInvested",
};
`);
  await writeFile(path.join(source, "static/lang/en.json"), JSON.stringify({ PF2E: {
    TraitInvested: "Invested", TraitDescriptionInvested: "An invested item.",
  } }));
  await run(process.execPath, ["--import", "tsx", "ingest.ts"], {
    cwd: path.resolve("."), env: { ...process.env, PF2E_SRC: source, OUT_DIR: out },
  });
  const records = JSON.parse(await readFile(path.join(out, "equipment.json"), "utf8"));
  const effects = JSON.parse(await readFile(path.join(out, "effects.json"), "utf8"));
  const traits = JSON.parse(await readFile(path.join(out, "traits.json"), "utf8"));
  const meta = JSON.parse(await readFile(path.join(out, "meta.json"), "utf8"));
  const named = (name: string) => records.find((record: { name: string }) => record.name === name);
  assert.equal(meta.schemaVersion, 5);
  assert.equal(meta.traitCount, 2);
  assert.deepEqual({ bulk: named("Gear").bulk, usage: named("Gear").usage, hands: named("Gear").hands },
    { bulk: 0.1, usage: "held-in-one-hand", hands: 1 });
  assert.deepEqual(named("Gear").source, { title: "Player Core", remaster: true });
  assert.deepEqual(named("Gear").skillBonuses, [
    { skill: "athletics", amount: 2, formula: null, bonusType: "item",
      predicate: ["action:climb"] },
    { skill: "arcana", amount: null, formula: "@item.system.runes.potency", bonusType: null,
      predicate: null },
  ]);
  assert.deepEqual(named("Gear").otherCheckBonuses, [
    { selector: "perception", category: "perception", amount: 2, formula: null,
      bonusType: "item", predicate: ["action:climb"] },
    { selector: "dex-skill-check", category: "skill-check", amount: -1, formula: null,
      bonusType: "circumstance", predicate: null },
    { selector: "{item|flags.system.rulesSelections.skill}", category: "dynamic", amount: 1,
      formula: null, bonusType: null, predicate: null },
  ]);
  assert.deepEqual(effects[0].skillBonuses, []);
  assert.deepEqual(effects[0].otherCheckBonuses, [
    { selector: "sailing-lore", category: "lore", amount: 1, formula: null, bonusType: null,
      predicate: null },
    { selector: "skill-check", category: "skill-check", amount: 1, formula: null,
      bonusType: null, predicate: null },
  ]);
  assert.deepEqual(named("Sword").skillBonuses, []);
  assert.equal("weapon" in named("Gear"), false);
  assert.deepEqual(named("Sword").weapon, { damageDice: 1, damageDie: "d8", damageType: "slashing",
    range: null, reload: null, canBeAmmo: false, splashDamage: null, potency: 0, striking: 0,
    propertyRunes: [] });
  assert.equal(named("Plate").armor.checkPenalty, -3);
  assert.deepEqual(named("Acid").consumable, { category: "bomb", uses: 1, maxUses: 1,
    effectKind: "damage", formula: "1d6", damageType: "acid" });
  assert.deepEqual(traits, [
    { slug: "chaotic", label: "Chaotic", description: null, group: null },
    { slug: "invested", label: "Invested", description: "An invested item.", group: "general" },
  ]);
});
