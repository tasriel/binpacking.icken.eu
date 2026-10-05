#!/usr/bin/env node
"use strict";
/*
 * Prüft eine Regelliste auf zwei Arten:
 *   1. Belegt: Jedes Muster wird an der Ecke und an Zufallspunkten seines Bereichs
 *      nachgebaut. Kein Karton darf aus dem Bin ragen oder einen anderen schneiden.
 *   2. Vollständig: An zufälligen Kartons (ganze mm) wird die Anzahl laut Liste mit
 *      dem Löser verglichen (Blockmuster, optional zusätzlich Suche).
 *
 * Aufruf:  node tools/validate-rules.js rules/603x403x404.json [--samples 5000] [--search-ms 0] [--seed 1]
 *
 * Listen für den konischen Bin (rules/konisch-….json) erkennt das Werkzeug selbst. Dort
 * prüft es jedes Muster vollständig (Wände, Überschneidung, Auflage) und vergleicht die
 * Liste mit dem Lagenmuster-Löser und mit der schnellen Rechnung von „Karton prüfen“.
 */
const fs = require("fs");
const P = require("../packcore.js");
const C = require("../cone.js");
const R = require("../cone-rules.js");

/**
 * @param {string[]} argv
 * @returns {{file: string, samples: number, searchMs: number, seed: number}}
 */
function parseArgs(argv) {
  /** @type {string[]} */ const pos = [];
  /** @type {Record<string, string>} */ const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]);
  }
  if (!pos[0]) {
    console.error("Aufruf: node tools/validate-rules.js <rules/….json> [--samples 5000] [--search-ms 0] [--seed 1]");
    process.exit(1);
  }
  return { file: pos[0], samples: Number(flags.samples || 5000), searchMs: Number(flags["search-ms"] || 0), seed: Number(flags.seed || 1) };
}

/**
 * @param {{x: number, y: number, z: number, dx: number, dy: number, dz: number}[]} pl @param {number[]} bin
 * @returns {string | null} Fehlerbeschreibung oder null
 */
function placementError(pl, bin) {
  const e = 1e-6;
  for (const p of pl) {
    if (p.x < -e || p.y < -e || p.z < -e || p.x + p.dx > bin[0] + e || p.y + p.dy > bin[1] + e || p.z + p.dz > bin[2] + e) return "ragt aus dem Bin";
  }
  for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) {
    const a = pl[i], b = pl[j];
    if (a.x < b.x + b.dx - e && b.x < a.x + a.dx - e && a.y < b.y + b.dy - e && b.y < a.y + a.dy - e && a.z < b.z + b.dz - e && b.z < a.z + a.dz - e) {
      return `Karton ${i + 1} und ${j + 1} überschneiden sich`;
    }
  }
  return null;
}

/** @param {number} seed @returns {() => number} */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

/**
 * Prüft eine Liste für den konischen Bin.
 * @param {import("../cone-rules.js").ConeRulesData} data @param {number} samples @param {number} seed
 */
function validateCone(data, samples, seed) {
  const bin = data.cone, nmax = data.nmax, grid = data.res || 1;
  const rand = rng(seed);
  const rules = R.unpackConeRules(data).map((r) => {
    const p = R.parseConeAny(r.pat);
    if (p.kind !== "layers") throw new Error(`Kein Lagenmuster: ${r.pat}`);
    return { ...r, root: p.root, ref: p.ref };
  });

  // 1. Belegt: am Bezugskarton, knapp innerhalb der Ecken und an Zufallspunkten des Bereichs nachbauen
  let checks = 0, bad = 0, textMismatch = 0;
  for (const r of rules) {
    const derived = R.coneRule(r.root, bin, r.ref);
    if (R.rowsText(derived.rows) !== R.rowsText(r.rows)) textMismatch++;
    const V = P.polyVertices(/** @type {any[]} */ (r.rows).concat(R.coneDomainRows()));
    /** @type {number[][]} */ const pts = r.ref ? [r.ref] : [];
    // Ecken minimal nach innen ziehen: genau auf der Grenze entscheidet sonst die Rechengenauigkeit
    const mid = [0, 1, 2].map((e) => V.reduce((acc, v) => acc + v[e], 0) / Math.max(1, V.length));
    for (const v of V) pts.push(v.map((x, e) => x + (mid[e] - x) * 1e-4));
    for (let k = 0; k < 6 && V.length; k++) {
      const w = V.map(() => rand());
      const sum = w.reduce((a, b) => a + b, 0);
      pts.push([0, 1, 2].map((e) => V.reduce((acc, v, i) => acc + v[e] * w[i] / sum, 0)));
    }
    for (const q of pts) {
      if (q[2] < 1) continue;
      checks++;
      const placed = R.coneLayout(r.root, q, bin);
      const errs = C.coneCheck(bin, placed);
      if (errs.length || placed.length !== r.count) {
        bad++;
        if (bad <= 5) console.log(`Fehler in „${R.coneRuleText(r.rows, r.score)}“ bei ${q.map((v) => v.toFixed(1)).join("x")}: ${errs[0] || "Anzahl stimmt nicht"}`);
      }
    }
  }
  console.log(`Belegt: ${rules.length} Regeln, ${checks} Nachbauten, ${bad} Fehler, ${textMismatch} Muster mit abweichender Regel`);

  // 2. Vollständig: Zufallskartons gegen Lagenmuster-Löser und schnelle Rechnung
  // Zufallskartons auf dem Raster der Liste (ganze mm oder ganze cm)
  const [M0, M1, M2] = [bin.topL, bin.topW, C.coneHeight(bin)].sort((a, b) => b - a).map((v) => Math.floor(v / grid + 1e-9));
  let checked = 0, lower = 0, higher = 0, lowerQuick = 0, higherQuick = 0, wrong = 0;
  /** @type {string[]} */ const examples = [];
  const t0 = Date.now();
  while (checked < samples) {
    const c = [Math.floor(rand() * M0) + 1, Math.floor(rand() * M1) + 1, Math.floor(rand() * M2) + 1].sort((a, b) => b - a).map((v) => v * grid);
    if (c[1] > M1 * grid || c[2] > M2 * grid) continue;
    const hit = R.lookupConeRules(rules, c);
    if (hit.index >= 0) {
      const placed = R.coneLayout(rules[hit.index].root, c, bin);
      if (C.coneCheck(bin, placed).length || placed.length !== rules[hit.index].count) wrong++;
    }
    if (hit.score >= nmax) continue;
    const lp = R.coneLayerPattern(c, bin, { enough: nmax });
    const solver = lp ? Math.min(lp.count, nmax) : 0;
    const quick = Math.min(C.analyzeCone(c, bin, 0).count, nmax);
    checked++;
    if (solver > hit.score) { lower++; if (examples.length < 10) examples.push(`${c.join("x")}: Liste ${hit.score}, Löser ${solver}`); }
    if (solver < hit.score) higher++;
    if (quick > hit.score) lowerQuick++;
    if (quick < hit.score) higherQuick++;
  }
  const pct = (/** @type {number} */ n) => (100 * n / Math.max(1, checked)).toFixed(2) + " %";
  console.log(`Vollständig: ${checked} Kartons unter ${nmax} im Raster ${grid} mm geprüft in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${wrong} Muster ungültig`);
  console.log(`  Liste unter Lagenmuster-Löser: ${lower} (${pct(lower)}), darüber: ${higher} (${pct(higher)})`);
  console.log(`  Liste unter schneller Rechnung von „Karton prüfen“: ${lowerQuick} (${pct(lowerQuick)}), darüber: ${higherQuick} (${pct(higherQuick)})`);
  if (examples.length) console.log("  Beispiele: " + examples.join("; "));
  process.exitCode = bad || wrong ? 1 : 0;
}

function main() {
  const { file, samples, searchMs, seed } = parseArgs(process.argv.slice(2));
  /** @type {any} */ const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.cone) { validateCone(raw, samples, seed); return; }
  /** @type {import("../packcore.js").RulesData} */ const data = raw;
  const bin = data.bin, nmax = data.nmax, grid = data.res || 1;
  const rules = P.unpackRules(data);
  const rand = rng(seed);

  // 1. Belegt
  let checks = 0, bad = 0, textMismatch = 0;
  for (const r of rules) {
    const pat = P.parsePattern(r.pat);
    const derived = P.patternRule(pat, bin);
    if (P.consText(derived.cons) !== P.consText(r.cons)) textMismatch++;
    const V = P.regionVertices(r.cons);
    /** @type {number[][]} */ const pts = [...V];
    for (let k = 0; k < 6; k++) {
      const w = V.map(() => rand());
      const sum = w.reduce((a, b) => a + b, 0);
      pts.push([0, 1, 2].map((e) => V.reduce((acc, v, i) => acc + v[e] * w[i] / sum, 0)));
    }
    for (const q of pts) {
      if (q[2] <= 0.01) continue;
      checks++;
      const err = placementError(P.patternLayout(pat, q), bin);
      if (err) { bad++; if (bad <= 5) console.log(`Fehler in „${P.ruleText(r.cons, r.score)}“ bei ${q.map((v) => v.toFixed(1)).join("x")}: ${err}`); }
    }
  }
  console.log(`Belegt: ${rules.length} Regeln, ${checks} Nachbauten, ${bad} Fehler, ${textMismatch} Muster mit abweichender Regel`);

  // 2. Vollständig
  // Zufallskartons auf dem Raster der Liste (ganze mm oder ganze cm)
  const B = bin.map((v) => Math.floor(v + 1e-9));
  const [M0, M1, M2] = [...B].sort((a, b) => b - a).map((v) => Math.floor(v / grid));
  let checked = 0, lower = 0, higher = 0;
  /** @type {string[]} */ const examples = [];
  const t0 = Date.now();
  while (checked < samples) {
    const c = [Math.floor(rand() * M0) + 1, Math.floor(rand() * M1) + 1, Math.floor(rand() * M2) + 1].sort((a, b) => b - a).map((v) => v * grid);
    if (c[1] > M1 * grid || c[2] > M2 * grid) continue;
    const listed = P.lookupRules(rules, c).score;
    if (listed >= nmax) continue;
    const dp = P.dpSolve(c, B, true, { work: 4e7 });
    let solver = dp ? Math.min(dp.count, nmax) : 0;
    if (searchMs > 0 && solver === listed && solver < nmax && P.upperBoundInt(c, B) > solver) {
      const r = P.portfolioSearch(c, B, solver + 1, searchMs);
      if (r.placements) solver++;
    }
    checked++;
    if (solver > listed) { lower++; if (examples.length < 10) examples.push(`${c.join("x")}: Liste ${listed}, Löser ${solver}`); }
    if (solver < listed) higher++;
  }
  const pct = (/** @type {number} */ n) => (100 * n / Math.max(1, checked)).toFixed(2) + " %";
  console.log(`Vollständig: ${checked} Kartons unter ${nmax} im Raster ${grid} mm geprüft in ${((Date.now() - t0) / 1000).toFixed(0)} s` + (searchMs ? ` (mit Suche ${searchMs} ms)` : " (nur Blockmuster)"));
  console.log(`  Liste unter Löser: ${lower} (${pct(lower)})`);
  console.log(`  Liste über Blockmustern dank verschränkter Muster: ${higher} (${pct(higher)})`);
  if (examples.length) console.log("  Beispiele: " + examples.join("; "));
  process.exitCode = bad ? 1 : 0;
}

main();
