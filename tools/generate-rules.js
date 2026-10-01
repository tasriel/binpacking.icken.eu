#!/usr/bin/env node
"use strict";
/*
 * Erzeugt die Regelliste für einen Bin, schreibt sie nach rules/<L>x<B>x<H>.json
 * und trägt den Bin in rules/index.json ein. Die Seite lädt sie dann automatisch.
 * Mit --txt entsteht zusätzlich eine Textdatei mit einer Regel pro Zeile.
 *
 * Aufruf:  node tools/generate-rules.js <L> <B> <H> [--quality fast|std|full] [--nmax 30] [--out rules] [--txt datei.txt]
 * Beispiel: node tools/generate-rules.js 603 403 404 --quality full
 */
const fs = require("fs");
const path = require("path");
const P = require("../packcore.js");

/**
 * @param {string[]} argv
 * @returns {{bin: number[], quality: "fast" | "std" | "full", nmax: number, out: string, txt: string | null}}
 */
function parseArgs(argv) {
  /** @type {string[]} */ const pos = [];
  /** @type {Record<string, string>} */ const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { flags[a.slice(2)] = argv[i + 1]; i++; } else pos.push(a);
  }
  const bin = pos.slice(0, 3).map(Number);
  if (bin.length !== 3 || bin.some((v) => !(v > 0))) {
    console.error("Aufruf: node tools/generate-rules.js <L> <B> <H> [--quality fast|std|full] [--nmax 30] [--out rules] [--txt datei.txt]");
    process.exit(1);
  }
  const quality = /** @type {"fast" | "std" | "full"} */ (flags.quality || "full");
  if (!(quality in P.QUALITY_PRESETS)) { console.error(`Unbekannte Genauigkeit „${quality}“.`); process.exit(1); }
  const nmax = Number(flags.nmax || 30);
  if (!(nmax >= 2 && nmax <= 60)) { console.error("--nmax muss zwischen 2 und 60 liegen."); process.exit(1); }
  return { bin, quality, nmax, out: flags.out || path.join(__dirname, "..", "rules"), txt: flags.txt || null };
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

function main() {
  const { bin, quality, nmax, out, txt } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  let last = 0;
  const res = P.generateRules(bin, P.genOptions(quality, nmax), (p) => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    const prog = /** @type {Record<string, any>} */ (p);
    const where = prog.phase === "grid" ? `Raster ${prog.step} mm, Linie ${prog.done}/${prog.total}`
      : prog.phase === "random" ? `Zufallslinien ${prog.done}, ohne neue Regel seit ${prog.sinceNew}/${prog.patience}`
      : prog.phase;
    process.stderr.write(`\r${Math.round((now - t0) / 1000)} s · ${where} · ${prog.rules} Regeln        `);
  });
  process.stderr.write("\n");
  const data = P.packRulesData(res, quality);
  const key = P.binKeyOf(bin);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${key}.json`), JSON.stringify(data));
  updateIndex(out, key);
  if (txt) fs.writeFileSync(txt, P.rulesToText(bin, nmax, P.unpackRules(data), true));
  /** @type {Record<number, number>} */ const perCount = {};
  for (const r of res.rules) perCount[r.score] = (perCount[r.score] || 0) + 1;
  console.log(`${res.rules.length} Regeln für ${key} in ${((Date.now() - t0) / 1000).toFixed(0)} s` + (res.meta.aborted ? " (Zeitlimit erreicht)" : ""));
  console.log("Regeln je Anzahl:", JSON.stringify(perCount));
  console.log(`Geschrieben: ${path.join(out, key)}.json` + (txt ? ` und ${txt}` : ""));
}

main();
