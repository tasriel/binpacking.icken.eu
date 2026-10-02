#!/usr/bin/env node
"use strict";
/*
 * Erzeugt die Regelliste für einen Bin, schreibt sie nach rules/<Schlüssel>.json
 * und trägt den Bin in rules/index.json ein. Die Seite lädt sie dann automatisch.
 * Mit --txt entsteht zusätzlich eine Textdatei mit einer Regel pro Zeile.
 *
 * Quader-Bin:
 *   node tools/generate-rules.js <L> <B> <H> [--quality fast|std|full] [--nmax 30] [--out rules] [--txt datei.txt]
 *   Beispiel: node tools/generate-rules.js 603 403 404 --quality full
 * Konischer Bin (Öffnung Länge, Breite, Randhöhe, Boden Länge, Breite, Höhe des konischen Teils):
 *   node tools/generate-rules.js --cone <obenL> <obenB> <Rand> <untenL> <untenB> <konischH> [--quality …] [--nmax 30] [--out rules] [--txt datei.txt]
 *   Beispiel: node tools/generate-rules.js --cone 558 374 65 515 336 344 --quality full
 */
const fs = require("fs");
const path = require("path");
const P = require("../packcore.js");
const C = require("../cone.js");
const R = require("../cone-rules.js");

const USAGE = "Aufruf: node tools/generate-rules.js <L> <B> <H> [--quality fast|std|full] [--nmax 30] [--out rules] [--txt datei.txt]\n"
  + "   oder: node tools/generate-rules.js --cone <obenL> <obenB> <Rand> <untenL> <untenB> <konischH> [dieselben Optionen]";

/**
 * @param {string[]} argv
 * @returns {{bin: number[], cone: boolean, quality: "fast" | "std" | "full", nmax: number, out: string, txt: string | null}}
 */
function parseArgs(argv) {
  /** @type {string[]} */ const pos = [];
  /** @type {Record<string, string>} */ const flags = {};
  let cone = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cone") cone = true;
    else if (a.startsWith("--")) { flags[a.slice(2)] = argv[i + 1]; i++; } else pos.push(a);
  }
  const need = cone ? 6 : 3;
  const bin = pos.slice(0, need).map(Number);
  if (bin.length !== need || bin.some((v) => !(v >= 0)) || (!cone && bin.some((v) => !(v > 0)))) {
    console.error(USAGE);
    process.exit(1);
  }
  const quality = /** @type {"fast" | "std" | "full"} */ (flags.quality || "full");
  if (!(quality in P.QUALITY_PRESETS)) { console.error(`Unbekannte Genauigkeit „${quality}“.`); process.exit(1); }
  const nmax = Number(flags.nmax || 30);
  if (!(nmax >= 2 && nmax <= 60)) { console.error("--nmax muss zwischen 2 und 60 liegen."); process.exit(1); }
  return { bin, cone, quality, nmax, out: flags.out || path.join(__dirname, "..", "rules"), txt: flags.txt || null };
}

/**
 * Trägt den Bin in rules/index.json ein, damit die Seite die Liste findet.
 * @param {string} dir @param {string} key
 */
function updateIndex(dir, key) {
  const file = path.join(dir, "index.json");
  /** @type {string[]} */ let keys = [];
  try { keys = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { keys = []; }
  if (!keys.includes(key)) keys.push(key);
  keys.sort();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");
}

/**
 * @param {number} t0 @returns {(p: object) => void} Fortschritt auf stderr, höchstens alle zwei Sekunden
 */
function progress(t0) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    const prog = /** @type {Record<string, any>} */ (p);
    const where = prog.phase === "grid" ? `Raster ${prog.step} mm, Linie ${prog.done}/${prog.total}`
      : prog.phase === "random" ? `Zufallslinien ${prog.done}, ohne neue Regel seit ${prog.sinceNew}/${prog.patience}`
      : prog.phase;
    process.stderr.write(`\r${Math.round((now - t0) / 1000)} s · ${where} · ${prog.rules} Regeln        `);
  };
}

/**
 * @param {{score: number}[]} rules @param {string} key @param {number} t0 @param {boolean} aborted @param {string} out @param {string | null} txt
 */
function report(rules, key, t0, aborted, out, txt) {
  /** @type {Record<number, number>} */ const perCount = {};
  for (const r of rules) perCount[r.score] = (perCount[r.score] || 0) + 1;
  console.log(`${rules.length} Regeln für ${key} in ${((Date.now() - t0) / 1000).toFixed(0)} s` + (aborted ? " (Zeitlimit erreicht)" : ""));
  console.log("Regeln je Anzahl:", JSON.stringify(perCount));
  console.log(`Geschrieben: ${path.join(out, key)}.json` + (txt ? ` und ${txt}` : ""));
}

function main() {
  const { bin, cone, quality, nmax, out, txt } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  fs.mkdirSync(out, { recursive: true });
  if (cone) {
    /** @type {import("../cone.js").ConeBin} */ const cb = { topL: bin[0], topW: bin[1], rimH: bin[2], botL: bin[3], botW: bin[4], coneH: bin[5] };
    const err = C.coneBinError(cb);
    if (err) { console.error(err); process.exit(1); }
    const res = R.generateConeRules(cb, R.coneGenOptions(quality, nmax), progress(t0));
    process.stderr.write("\n");
    const data = R.packConeRules(res, quality);
    const key = R.coneBinKey(cb);
    fs.writeFileSync(path.join(out, `${key}.json`), JSON.stringify(data));
    updateIndex(out, key);
    if (txt) fs.writeFileSync(txt, R.coneRulesToText(cb, nmax, R.unpackConeRules(data), true));
    report(res.rules, key, t0, res.meta.aborted, out, txt);
    return;
  }
  const res = P.generateRules(bin, P.genOptions(quality, nmax), progress(t0));
  process.stderr.write("\n");
  const data = P.packRulesData(res, quality);
  const key = P.binKeyOf(bin);
  fs.writeFileSync(path.join(out, `${key}.json`), JSON.stringify(data));
  updateIndex(out, key);
  if (txt) fs.writeFileSync(txt, P.rulesToText(bin, nmax, P.unpackRules(data), true));
  report(res.rules, key, t0, res.meta.aborted, out, txt);
}

main();
