"use strict";
/*
 * cone-app.js: Bedienung des Reiters „Konischer Bin“.
 * Nutzt die Helfer aus app.js ($, fmt, len, U, dimsText, esc, readNums, writeLen, bindUnitSelect, unitOf,
 * makeWorker, startJob, copyText, drawSVG, ORIENT, orient, orientSummary, fetchPreIndex, exactOptions,
 * exactControls, estimateGen, genProgress, setAutoRes, resText, stepText, boxListHtml, durText)
 * und die Rechenkerne cone.js und cone-rules.js.
 */

/**
 * @typedef {ConePlacement & {count?: number, n?: number[], num?: number}} ConeItem  Karton oder Block (count = Kartons darin)
 * @typedef {{kind: "check" | "loaded" | "rule", carton: number[] | null, items: ConeItem[], blocks: boolean, total: number,
 *   eyebrow: string, note: string, rule: {rows: ConeRow[], count: number} | null, noRule: string, patText: string | null,
 *   boxes?: ConeItem[]}} ConeView
 *   blocks: items sind Blöcke statt einzelner Kartons. noRule: warum es keine Regel gibt.
 * @typedef {ConeStoredRule & {example: number[] | null, id: number, root: TreeNode, ref: number[] | null}} ConeUiRule
 * @typedef {{nmax: number, quality: string, source: string, res: number, meta?: {aborted?: boolean}, stats?: object}} ConeRulesInfo
 * @typedef {{id: number, result: ConeAnalysis | null, mode: "quick" | "exact", level: ExactLevel | null, estMs: number,
 *   done: {dpWork: number, searchMs: number}}} ConeCheck
 */

const coneState = {
  bin: /** @type {ConeBin} */ ({ ...CONE_DEFAULT }),
  carton: /** @type {number[] | null} */ (null),
  check: /** @type {ConeCheck | null} */ (null),
  view: /** @type {ConeView | null} */ (null),
  step: /** @type {number | null} */ (null),
  rules: /** @type {ConeUiRule[]} */ ([]),
  rulesInfo: /** @type {ConeRulesInfo | null} */ (null),
  filter: "all",
  ready: false
};
const CONE_FIELDS = /** @type {(keyof ConeBin)[]} */ (["topL", "topW", "rimH", "botL", "botW", "coneH"]);
const CONE_STORE = "kartonregeln:konisch";
const NO_RULE_FREE = "Keine Regel: Dieses Muster ist kein Lagenmuster.";
const NO_RULE_BIG = `Keine Regel: Regeln leitet die Seite nur für Muster bis ${CONE_RULE_MAX} Kartons ab.`;

/* ---------- Bin-Maße ---------- */
/** @returns {ConeBin | null} */
function readConeBin() {
  const f = UNIT_MM[unitOf("#cb-unit")];
  /** @type {Record<string, number>} */ const b = {};
  for (const k of CONE_FIELDS) b[k] = Math.round(parseFloat(String(/** @type {HTMLInputElement} */ ($("#cb-" + k)).value).replace(",", ".")) * f * 10) / 10;
  const bin = /** @type {ConeBin} */ (/** @type {unknown} */ (b));
  const err = coneBinError(bin);
  const el = $("#cb-err");
  el.hidden = !err;
  if (err) { el.textContent = err; return null; }
  return bin;
}
/** @param {ConeBin} b */
function writeConeBin(b) {
  for (const k of CONE_FIELDS) writeLen("#cb-" + k, /** @type {number} */ (b[k]), "#cb-unit");
}
/** @param {ConeBin} b @returns {string} z. B. "Öffnung 558 × 374, Boden 515 × 336, Höhe 409 mm" */
function coneBinText(b) { return `Öffnung ${len(b.topL)} × ${len(b.topW)}, Boden ${len(b.botL)} × ${len(b.botW)}, Höhe ${len(coneHeight(b))} ${U()}`; }
function renderConeFacts() {
  const b = coneState.bin;
  const pct = (/** @type {number} */ d) => (b.coneH > 0 ? fmt(Math.atan(d / b.coneH) * 180 / Math.PI) : "0");
  const dl = (b.topL - b.botL) / 2, dw = (b.topW - b.botW) / 2;
  const vol = coneVolume(b) / 1e6;
  $("#cb-facts").innerHTML = `<span>Gesamthöhe <b>${len(coneHeight(b))} ${U()}</b></span>
    <span>Wand je Seite um <b>${len(dl)} ${U()}</b> (Länge, ${pct(dl)}°) und <b>${len(dw)} ${U()}</b> (Breite, ${pct(dw)}°) geneigt</span>
    <span>Volumen <b>${vol >= 1000 ? fmt(vol / 1000) + " m³" : fmt(vol) + " l"}</b></span>`;
}
/** Neue Bin-Maße übernehmen: Regeln und Ergebnis gehören zum eingestellten Bin */
function coneBinChanged() {
  coneState.view = null;
  renderConeFacts();
  stopConeGen();
  setAutoRes("#cg-res", Math.max(coneState.bin.topL, coneState.bin.topW, coneHeight(coneState.bin)));
  loadConeRules();
  startConeCheck();
  requestConeGenEstimate();
}
let coneBinTimer = 0;
$("#cb-form").addEventListener("input", (e) => {
  if ((/** @type {HTMLElement} */ (e.target)).id === "cb-unit") return;
  clearTimeout(coneBinTimer);
  coneBinTimer = window.setTimeout(() => {
    const b = readConeBin();
    if (!b) return;
    coneState.bin = b;
    try { localStorage.setItem(CONE_STORE, JSON.stringify(b)); } catch (e2) { /* Speicher nicht verfügbar */ }
    coneBinChanged();
  }, 400);
});
$("#cb-form").addEventListener("submit", (e) => e.preventDefault());
$("#cb-reset").addEventListener("click", () => {
  coneState.bin = { ...CONE_DEFAULT };
  writeConeBin(coneState.bin);
  try { localStorage.removeItem(CONE_STORE); } catch (e) { /* Speicher nicht verfügbar */ }
  $("#cb-err").hidden = true;
  coneBinChanged();
});

/* ---------- Regeln laden, speichern, nachschlagen ---------- */
/** @param {ConeRulesData} data @returns {ConeUiRule[]} */
function inflateConeRules(data) {
  const dom = coneDomainRows();
  /** @type {ConeUiRule[]} */ const out = [];
  for (const r of unpackConeRules(data)) {
    try {
      const p = parseConeAny(r.pat);
      if (p.kind !== "layers") continue;
      const example = coneExample(polyVertices(/** @type {Row[]} */ (r.rows).concat(dom)), r.rows, p.ref);
      out.push({ ...r, example, id: out.length, root: p.root, ref: p.ref });
    } catch (e) { /* unlesbare Regel überspringen */ }
  }
  return out;
}
function coneStorageKey() { return "kartonregeln:" + coneBinKey(coneState.bin); }
/** @type {Map<string, ConeRulesData | null>} */ const conePreCache = new Map();
/** @param {string} key @returns {Promise<ConeRulesData | null>} vorberechnete Liste aus rules/ */
async function fetchConePre(key) {
  if (conePreCache.has(key)) return /** @type {ConeRulesData | null} */ (conePreCache.get(key));
  let data = null;
  if ((await fetchPreIndex()).includes(key)) {
    try {
      const res = await fetch(`rules/${encodeURIComponent(key)}.json`, { cache: "no-cache" });
      if (res.ok) data = await res.json();
    } catch (e) { data = null; }
  }
  conePreCache.set(key, data);
  return data;
}
async function loadConeRules() {
  const key = coneBinKey(coneState.bin);
  const rank = (/** @type {any} */ d) => (d ? ({ fast: 1, std: 2, full: 3 }[/** @type {"fast"} */ (d.quality)] || 0) : -1);
  let data = null, source = "";
  try { const s = localStorage.getItem(coneStorageKey()); if (s) { data = JSON.parse(s); source = "saved"; } } catch (e) { data = null; }
  const pre = await fetchConePre(key);
  if (key !== coneBinKey(coneState.bin)) return;
  if (pre && (!data || rank(pre) > rank(data))) { data = pre; source = "pre"; }
  setConeRules(data && data.rules && data.cone ? data : null, source);
}
/** Zeile unter den Knöpfen: woher die Liste stammt, oder dass es noch keine gibt */
function renderConeSource() {
  const info = coneState.rulesInfo;
  if (!info) {
    $("#cg-source").textContent = `Für diesen Bin (${coneBinText(coneState.bin)}) gibt es noch keine Regelliste. Wähle Raster und Genauigkeit und starte die Berechnung. Sie läuft im Hintergrund, du kannst die Seite währenddessen weiter benutzen.`;
    return;
  }
  const q = CONE_QUALITY[/** @type {"fast" | "std" | "full"} */ (info.quality)];
  const when = info.source === "pre" ? "Vorberechnet" : info.source === "saved" ? "In diesem Browser gespeichert" : "Gerade berechnet";
  $("#cg-source").textContent = `${when}: ${coneState.rules.length} Regeln für diesen Bin (${coneBinText(coneState.bin)}), Höchstanzahl ${info.nmax}, Genauigkeit „${q ? q.label : info.quality}“, Raster ${resText(info.res)}.`
    + (info.meta && info.meta.aborted ? " Die Berechnung hat ihr Zeitlimit erreicht; die Liste kann Lücken haben." : "");
}
/** @param {ConeRulesData | null} data @param {string} source */
function setConeRules(data, source) {
  if (!data) {
    coneState.rules = []; coneState.rulesInfo = null;
    $("#cr-body").hidden = true;
    renderConeSource();
    renderConeResult();
    if (!coneState.view || coneState.view.kind === "check") showConeCheck();
    return;
  }
  coneState.rules = inflateConeRules(data);
  coneState.rulesInfo = { nmax: data.nmax, quality: data.quality, source, res: data.res || 1, meta: data.meta, stats: data.stats };
  (/** @type {HTMLInputElement} */ ($("#cg-nmax"))).value = String(data.nmax);
  renderConeSource();
  $("#cr-body").hidden = false;
  coneState.filter = "all";
  renderConeRuleStats(); renderConeFilter(); renderConeRuleList(); renderConeResult();
  if (!coneState.view || coneState.view.kind === "check") showConeCheck();
}
/** @returns {ConeRulesData} */
function coneExportData() {
  const info = /** @type {ConeRulesInfo} */ (coneState.rulesInfo);
  return { cone: coneState.bin, nmax: info.nmax, quality: info.quality, res: info.res, meta: info.meta, stats: info.stats,
    rules: coneState.rules.map((r) => /** @type {[number, number, number[], string, string]} */ ([r.score, r.count, packRows(r.rows), r.pat, r.src])) };
}
/** @param {ConeRulesData} data @returns {boolean} */
function saveConeRules(data) {
  try { localStorage.setItem(coneStorageKey(), JSON.stringify(data)); return true; } catch (e) { return false; }
}
/** @param {number[]} c sortiert @returns {{score: number, rule: ConeUiRule | null}} */
function coneLookup(c) {
  let best = 0, hit = null;
  if (c[2] < 1) return { score: 0, rule: null };
  for (const r of coneState.rules) if (r.score > best && rowsHold(r.rows, c, 1e-7)) { best = r.score; hit = r; }
  return { score: best, rule: hit };
}

/* ---------- Karton prüfen ---------- */
let coneJob = /** @type {{stop: () => void} | null} */ (null);
let coneSeq = 0;
/**
 * Stufen für „Genau rechnen“. dpWork: Aufwand für die Lagenmuster. searchMs: Zeit für
 * verschränkte Lagen und die freie Suche (nur bis CONE_HEAVY_MAX Kartons möglich).
 * Die schnelle Rechnung nutzt CONE_QUICK_WORK und sucht nicht.
 * @type {ExactLevel[]}
 */
const CONE_EXACT_LEVELS = [
  { key: "1", label: "Gründlich", dpWork: 3e8, searchMs: 8000 },
  { key: "2", label: "Sehr gründlich", dpWork: 3e9, searchMs: 30000 },
  { key: "3", label: "Maximal", dpWork: 3e10, searchMs: 120000 }
];
let coneLevel = "1";
/** @param {ConeCheck} ck @returns {{level: ExactLevel, ms: number}[]} Stufen, die noch etwas bringen */
function coneExactOptions(ck) {
  const r = ck.result;
  if (!r || !r.final) return [];
  return exactOptions({ effort: r.effort, approx: r.approx, searchable: !!r.heavy && r.status === "open", done: ck.done }, CONE_EXACT_LEVELS);
}
/** @param {ExactLevel | null} [level] null = schnelle Rechnung, sonst genaue Rechnung in dieser Stufe */
function startConeCheck(level = null) {
  const dims = readNums(["#cc-a", "#cc-b", "#cc-c"], "#cc-unit");
  if (!dims) { coneState.carton = null; coneState.check = null; renderConeResult(); showConeCheck(); return; }
  saveDims("konisch-karton", dims);
  coneState.carton = [...dims].sort((a, b) => b - a);
  const id = ++coneSeq;
  const old = level ? coneState.check : null;
  const opt = old ? coneExactOptions(old).find((o) => o.level === level) : null;
  const estMs = opt ? opt.ms : level ? level.searchMs : 0;
  coneState.check = { id, result: old && old.result ? { ...old.result, final: false } : null, mode: level ? "exact" : "quick", level, estMs, done: old ? old.done : { dpWork: 0, searchMs: 0 } };
  if (coneJob) coneJob.stop();
  const msg = { type: "cone", id, carton: coneState.carton, bin: coneState.bin, budget: level ? level.searchMs : 0, symWork: level ? level.dpWork : CONE_QUICK_WORK };
  const local = () => {
    if (!coneState.check || coneState.check.id !== id) return;
    // ohne Hintergrundrechnung blockiert die Seite, deshalb hier nur wenig Aufwand
    onConeMsg({ type: "cone", id, result: analyzeConeLayers(msg.carton, msg.bin, level ? 1500 : 0, undefined, { symWork: Math.min(msg.symWork, 1e8) }) });
  };
  const timeout = () => {
    if (!coneState.check || coneState.check.id !== id || !coneState.check.result) return;
    coneState.check.result = { ...coneState.check.result, final: true };
    renderConeResult();
  };
  coneJob = startJob(msg, onConeMsg, local, (d) => !!(d.result && d.result.final), level ? estMs * 4 + level.searchMs + 20000 : 15000, timeout);
  renderConeResult();
}
/** @param {any} d */
function onConeMsg(d) {
  if (d.type !== "cone" || !coneState.check || d.id !== coneState.check.id) return;
  const ck = coneState.check;
  ck.result = /** @type {ConeAnalysis} */ (d.result);
  if (ck.result.final && ck.level) ck.done = { dpWork: ck.level.dpWork, searchMs: ck.level.searchMs };
  renderConeResult();
  if (!coneState.view || coneState.view.kind === "check") showConeCheck();
}
let coneCkTimer = 0;
$("#cc-form").addEventListener("input", (e) => {
  if ((/** @type {HTMLElement} */ (e.target)).id === "cc-unit") return;
  clearTimeout(coneCkTimer); coneCkTimer = window.setTimeout(() => startConeCheck(), 350);
});
$("#cc-result").addEventListener("change", (e) => {
  const t = /** @type {HTMLSelectElement} */ (e.target);
  if (t.id === "cc-level") coneLevel = t.value;
});
$("#cc-result").addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.id === "cc-exact") {
    const sel = /** @type {HTMLSelectElement | null} */ (document.querySelector("#cc-level"));
    const level = CONE_EXACT_LEVELS.find((l) => l.key === (sel ? sel.value : coneLevel));
    if (level) { coneLevel = level.key; startConeCheck(level); }
  }
  if (t.id === "cc-add-rule") addConeCheckAsRule();
  if (t.id === "cc-cancel" && coneState.check && coneState.check.result) {
    if (coneJob) coneJob.stop();
    const ck = coneState.check;
    coneState.check = { ...ck, id: ++coneSeq, result: { ...(/** @type {ConeAnalysis} */ (ck.result)), final: true }, mode: ck.done.searchMs > 0 ? "exact" : "quick", level: null };
    renderConeResult();
  }
  const sr = t.closest("[data-show-rule]");
  if (sr) showConeRule(+(/** @type {string} */ ((/** @type {HTMLElement} */ (sr)).dataset.showRule)));
});
$("#cc-form").addEventListener("submit", (e) => e.preventDefault());

/**
 * Kartons eines Lagenmusters für Anzeige und Zeichnung; bei sehr vielen Kartons Blöcke.
 * @param {TreeNode} root @param {number[]} carton @returns {{items: ConeItem[], blocks: boolean, total: number}}
 */
function coneItems(root, carton) {
  const total = treeCount(root);
  const blocks = total > DRAW_MAX;
  return { items: blocks ? coneBlockLayout(root, carton, coneState.bin) : coneLayout(root, carton, coneState.bin), blocks, total };
}
/**
 * Bestes bekanntes Ergebnis: eigener Löser oder Regelliste.
 * @returns {{source: "own" | "list", count: number, items: ConeItem[], blocks: boolean, rule: ConeUiRule | null,
 *   list: {score: number, rule: ConeUiRule | null}} | null}
 */
function bestForCone() {
  const ck = coneState.check;
  if (!ck || !ck.result || !coneState.carton) return null;
  const r = ck.result;
  const list = coneState.rules.length ? coneLookup(coneState.carton) : { score: 0, rule: null };
  const nmax = coneState.rulesInfo ? coneState.rulesInfo.nmax : Infinity;
  if (list.rule && list.score > Math.min(r.count, nmax)) {
    const it = coneItems(list.rule.root, coneState.carton);
    return { source: "list", count: list.rule.count, items: it.items, blocks: it.blocks, rule: list.rule, list };
  }
  if (!r.placements.length && r.count > 0 && r.layers) {
    // sehr viele Kartons: das Ergebnis enthält nur das Lagenmuster
    try {
      const p = parseConeAny(r.layers);
      if (p.kind === "layers") { const it = coneItems(p.root, coneState.carton); return { source: "own", count: r.count, items: it.items, blocks: it.blocks, rule: null, list }; }
    } catch (e) { /* dann ohne Zeichnung */ }
  }
  return { source: "own", count: r.count, items: r.placements, blocks: false, rule: null, list };
}

/** @param {ConeItem[]} P Kartons oder Blöcke @returns {string} z. B. "am Boden 4 · ab 100 mm 6" */
function coneLevels(P) {
  /** @type {Map<number, number>} */ const lv = new Map();
  for (const p of P) {
    // ein Block mit mehreren Kartons übereinander zählt auf jeder seiner Ebenen
    const nz = p.n ? p.n[2] : 1, per = (p.count || 1) / nz, dz = p.dz / nz;
    for (let k = 0; k < nz; k++) { const z = Math.round((p.z + k * dz) * 10) / 10; lv.set(z, (lv.get(z) || 0) + per); }
  }
  const all = [...lv.entries()].sort((a, b) => a[0] - b[0]);
  const text = (/** @type {[number, number]} */ [z, n]) => (z === 0 ? `am Boden ${n}` : `ab ${len(z)} ${U()} ${n}`);
  return all.length <= 8 ? all.map(text).join(" · ") : `${all.slice(0, 3).map(text).join(" · ")} · … · ${text(all[all.length - 1])} (${all.length} Ebenen)`;
}
function renderConeResult() {
  const el = $("#cc-result");
  const ck = coneState.check;
  if (!coneState.carton || !ck) { el.innerHTML = `<div class="r-count">–</div><div class="r-main">Bitte drei positive Maße bis 100 m eingeben.</div>`; return; }
  const r = ck.result;
  const b = coneState.bin;
  const where = `à <b>${dimsText(coneState.carton)}</b> ${U()} im konischen Bin`;
  const best = bestForCone();
  if (!r || !best) { el.innerHTML = `<div class="r-count">…<small>Kartons</small></div><div class="r-main"><span>${where}</span><span class="chip run">rechnet</span></div><div class="r-sub">&nbsp;</div>`; return; }
  const nmax = coneState.rulesInfo ? coneState.rulesInfo.nmax : null;
  const opts = coneExactOptions(ck);
  const searchable = !!r.heavy && r.status === "open";
  let chip;
  if (r.status === "optimal" || best.count >= r.upper) chip = `<span class="chip ok">optimal, mehr passen nicht</span>`;
  else if (r.status === "searched" && best.count <= r.count) chip = `<span class="chip ok">vollständig durchsucht, mehr passen nicht</span>`;
  else if (!r.final) chip = ck.mode === "exact" ? `<span class="chip run">rechnet genau, ${durText(ck.estMs)}</span> <button type="button" class="btn small" id="cc-cancel">Abbrechen</button>` : `<span class="chip run">rechnet</span>`;
  else {
    const label = r.approx ? "ungefähr: vereinfacht gerechnet" : ck.mode === "quick" && searchable ? "ungefähr: schnelle Rechnung, nur Lagen aus Blockmustern" : searchable ? `offen: ${best.count + 1} nicht ausgeschlossen` : "bestes Lagenmuster";
    chip = `<span class="chip open">${label}${isFinite(r.upper) ? ` · höchstens ${r.upper} möglich` : ""}</span>${exactControls(opts, coneLevel, "cc")}`;
  }
  const parts = [];
  if (best.count > 0) {
    if (best.items.length) parts.push(`<span>Ebenen: ${coneLevels(best.items)}</span>`);
    if (!best.blocks && best.items.length <= DRAW_MAX) {
      const sup = coneMinSupport(best.items);
      if (sup < 0.995) parts.push(`<span>kleinste Auflage ${Math.round(sup * 100)} %</span>`);
    }
    if (r.topCuboid > 0) parts.push(`<span>Zum Vergleich, gerader Bin: mit Bodenmaß ${r.bottomCuboid}, mit Öffnungsmaß ${r.topCuboid}</span>`);
  } else parts.push(`<span>Der Karton passt in keiner Lage in den Bin.</span>`);
  if (r.final && best.count > 0 && best.count < r.upper && r.status === "open" && !opts.length && !r.heavy) {
    parts.push(`<span>Verschränkte Lagen und die freie Suche gibt es nur, solange höchstens ${CONE_HEAVY_MAX} Kartons in den Bin passen; ob mehr als ${best.count} passen, bleibt offen.</span>`);
  }
  if (coneState.rules.length) {
    const L = best.list;
    if (best.source === "list") parts.push(`<span>Das Muster stammt aus der Regelliste. Der Einzellöser hat ${r.count} gefunden.</span>`);
    else if (Math.min(r.count, nmax || Infinity) > L.score) {
      parts.push(`<span>Die Regelliste kennt hier nur ${L.score}.${r.hasRule ? ` <button type="button" class="link" id="cc-add-rule">Muster als Regel übernehmen</button>` : r.layers ? "" : " Das Muster ist kein Lagenmuster und lässt sich nicht als Regel übernehmen."}</span>`);
    } else if (L.rule) parts.push(`<span>Laut Regelliste ${L.score}${nmax && L.score >= nmax ? " oder mehr" : ""} · <button type="button" class="link" data-show-rule="${L.rule.id}">Regel ${L.rule.id + 1} anzeigen</button></span>`);
  }
  el.innerHTML = `<div class="r-count">${best.count}<small>${best.count === 1 ? "Karton" : "Kartons"}</small></div>
    <div class="r-main"><span>${where} (${coneBinText(b)})</span>${chip}</div>
    <div class="r-sub">${parts.join("")}</div>`;
  if (coneState.rules.length) markConeHit();
}
function addConeCheckAsRule() {
  const ck = coneState.check, info = coneState.rulesInfo, c = coneState.carton;
  if (!ck || !ck.result || !ck.result.layers || !ck.result.hasRule || !info || !c) return;
  const p = parseConeAny(ck.result.layers);
  if (p.kind !== "layers") return;
  const rule = coneRule(p.root, coneState.bin, c);
  if (!rule.ok) return;
  const score = Math.min(rule.count, info.nmax);
  const example = coneExample(polyVertices(/** @type {Row[]} */ (rule.rows).concat(coneDomainRows())), rule.rows, c);
  coneState.rules.push({ score, count: rule.count, rows: rule.rows, pat: ck.result.layers, src: "manual", example, id: 0, root: p.root, ref: c });
  coneState.rules.sort((a, b) => (b.score - a.score) || (vol(b.example) - vol(a.example)));
  coneState.rules.forEach((x, i) => { x.id = i; });
  saveConeRules(coneExportData());
  renderConeRuleStats(); renderConeFilter(); renderConeRuleList(); renderConeResult();
}

/* ---------- Packmuster-Ansicht ---------- */
/** @type {{key: string, rule: {rows: ConeRow[], count: number}} | null} zuletzt berechnete Regel zum eigenen Lagenmuster */
let coneOwnRule = null;
/** @param {string} layers Textform @returns {{rows: ConeRow[], count: number} | null} Regel zum Lagenmuster des eigenen Kartons */
function coneOwnRuleOf(layers) {
  const key = coneBinKey(coneState.bin) + "|" + layers;
  if (coneOwnRule && coneOwnRule.key === key) return coneOwnRule.rule;
  try {
    const p = parseConeAny(layers);
    if (p.kind !== "layers") return null;
    const rule = coneRule(p.root, coneState.bin, p.ref);
    coneOwnRule = { key, rule: { rows: rule.rows, count: rule.count } };
    return coneOwnRule.rule;
  } catch (e) { return null; }
}
function showConeCheck() {
  const best = bestForCone();
  const ck = coneState.check;
  if (!best || !ck || !ck.result || !coneState.carton || !best.count) {
    coneState.view = null;
    renderConeViewer();
    return;
  }
  const r = ck.result;
  /** @type {{rows: ConeRow[], count: number} | null} */ let rule = null;
  let patText = null, eyebrow = "Dein Karton", noRule = NO_RULE_FREE;
  if (best.rule) { rule = { rows: best.rule.rows, count: best.rule.count }; patText = best.rule.pat; eyebrow = `Dein Karton · Muster aus Regel ${best.rule.id + 1}`; }
  else if (r.layers) {
    patText = r.layers;
    if (r.hasRule) rule = coneOwnRuleOf(r.layers); else noRule = NO_RULE_BIG;
  }
  coneState.view = { kind: "check", carton: coneState.carton, items: best.items, blocks: best.blocks, total: best.count, eyebrow, note: "", rule, noRule, patText };
  coneState.step = null;
  renderConeViewer();
}
function scrollToConeViewer() {
  $("#cc-viewer").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
/** @param {ConeRow[]} rows @param {number[]} c @returns {string} verletzte Bedingungen als Text */
function coneViolated(rows, c) {
  return rows.filter((k) => dot(k.a, c) > k.b + 1e-7).map((k) => rowText(k, U()).replace("<=", " ≤ ")).join(", ");
}
/**
 * Zeigt ein Lagenmuster: mit dem eigenen Karton, wenn er passt, sonst mit dem größten passenden.
 * @param {TreeNode} root @param {ConeRow[]} rows Bedingungen @param {number} count @param {number[] | null} example
 * @param {string} patText @param {string} eyebrow @param {"loaded" | "rule"} kind
 */
function showConeLayers(root, rows, count, example, patText, eyebrow, kind) {
  let carton = coneState.carton, note = "";
  if (!carton || carton[2] < 1 || !rowsHold(rows, carton, 1e-7)) {
    if (!example) { note = "Mit diesem Bin passt das Muster für keinen Karton."; carton = null; }
    else {
      if (carton) note = `Dein Karton ${dimsText(carton)} ${U()} passt nicht in dieses Muster (verletzt: ${coneViolated(rows, carton)}). Gezeigt mit dem größten passenden Karton ${dimsText(example)} ${U()}.`;
      carton = example;
    }
  }
  const it = carton ? coneItems(root, carton) : { items: [], blocks: false, total: count };
  if (carton) {
    const problems = coneCheck(coneState.bin, [...it.items].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x)));
    if (problems.length) note = `${note ? note + " " : ""}Achtung: ${problems.slice(0, 2).join(" ")}`;
  }
  coneState.view = { kind, carton, items: it.items, blocks: it.blocks, total: it.total, eyebrow, note, rule: { rows, count }, noRule: "", patText };
  coneState.step = null;
  renderConeViewer();
  scrollToConeViewer();
}
/** @param {number} id */
function showConeRule(id) {
  const r = coneState.rules[id];
  if (!r) return;
  showConeLayers(r.root, r.rows, r.count, r.example, r.pat, `Regel ${id + 1} von ${coneState.rules.length}`, "rule");
}
$("#cc-load-btn").addEventListener("click", () => {
  const err = $("#cc-load-err");
  try {
    const parsed = parseConeAny((/** @type {HTMLTextAreaElement} */ ($("#cc-load-in"))).value);
    err.hidden = true;
    if (parsed.kind === "layers" && treeCount(parsed.root) <= CONE_RULE_MAX) {
      // Auflage am eigenen Karton festlegen, wenn er passt, sonst am Bezugskarton des Musters
      const c = coneState.carton;
      let rule = c && c[2] >= 1 ? coneRule(parsed.root, coneState.bin, c) : null;
      let ref = c;
      if (!rule || !c || !rule.ok || !rowsHold(rule.rows, c, 1e-7)) { rule = coneRule(parsed.root, coneState.bin, parsed.ref); ref = rule.ref; }
      const valid = rule.ok && !!ref && rowsHold(rule.rows, ref, 1e-7);
      const example = valid ? coneExample(polyVertices(/** @type {Row[]} */ (rule.rows).concat(coneDomainRows())), rule.rows, ref) : null;
      showConeLayers(parsed.root, rule.rows, rule.count, example, coneLayerString(parsed.root, valid ? ref : parsed.ref), "Geladenes Muster", "loaded");
      return;
    }
    /** @type {ConeItem[]} */ let items;
    let carton, blocks = false, total, patText = null, noRule = NO_RULE_FREE;
    if (parsed.kind === "layers") {
      // großes Lagenmuster: ohne Regel, gezeigt mit dem Bezugskarton oder dem eigenen Karton
      carton = parsed.ref || coneState.carton;
      if (!carton) throw new Error("Zu diesem Muster fehlt der Karton. Schreibe ihn vor das Muster, zum Beispiel K(60x40x30; …), oder gib oben Kartonmaße ein.");
      const it = coneItems(parsed.root, carton);
      items = it.items; blocks = it.blocks; total = it.total;
      patText = coneLayerString(parsed.root, carton); noRule = NO_RULE_BIG;
    } else { items = parsed.placements; carton = parsed.carton; total = items.length; }
    const problems = items.length <= 5000 ? coneCheck(coneState.bin, [...items].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x))) : [];
    const note = problems.length
      ? `Dieses Muster passt nicht zu den eingestellten Bin-Maßen: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` und ${problems.length - 3} weitere Probleme.` : ""}`
      : "";
    coneState.view = { kind: "loaded", carton, items, blocks, total, eyebrow: "Geladenes Muster", note, rule: null, noRule, patText };
    coneState.step = null;
    renderConeViewer();
    scrollToConeViewer();
  } catch (e) {
    err.textContent = (/** @type {Error} */ (e)).message; err.hidden = false;
  }
});
$("#cv-back").addEventListener("click", () => showConeCheck());

function renderConeViewer() {
  const v = coneState.view;
  $("#cv-back").hidden = !v || v.kind === "check" || !coneState.carton;
  if (!v || !v.carton) {
    $("#cv-eyebrow").textContent = "Packmuster";
    $("#cv-title").textContent = v && v.note ? "Kein Karton passt" : "Noch kein Muster";
    $("#cv-meta").textContent = v && v.note ? "" : "Sobald Maße eingegeben sind und mindestens ein Karton passt, erscheint hier das Muster.";
    $("#cv-note").hidden = !(v && v.note); if (v && v.note) $("#cv-note").textContent = v.note;
    $("#cv-rule").textContent = v && v.rule ? coneRuleText(v.rule.rows, v.rule.count, U()) : "–";
    $("#cv-pat").textContent = v && v.patText ? v.patText : "–";
    $("#cv-svg").innerHTML = drawConeSVG([]);
    $("#cv-legend").innerHTML = ""; $("#cv-list").innerHTML = ""; $("#cv-stepper").hidden = true;
    return;
  }
  const boxes = [...v.items].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));
  v.boxes = boxes;
  const n = boxes.length;
  $("#cv-eyebrow").textContent = v.eyebrow;
  $("#cv-title").innerHTML = `${v.total} ${v.total === 1 ? "Karton" : "Kartons"} <span class="u">à ${dimsText(v.carton)} ${U()}</span>`;
  $("#cv-meta").innerHTML = `<b>${v.patText ? "Lagenmuster" : "Freies Muster"}</b>${n ? ` · ${orientSummary(boxes)} · Ebenen: ${coneLevels(boxes)}` : ""}${v.blocks ? ` · Zeichnung zeigt ${n === 1 ? "einen Block" : n + " Blöcke"} statt einzelner Kartons` : ""}`;
  $("#cv-note").hidden = !v.note; $("#cv-note").textContent = v.note;
  $("#cv-rule").textContent = v.rule ? coneRuleText(v.rule.rows, v.rule.count, U()) : v.noRule;
  $("#cv-pat").textContent = v.patText || (n <= 5000 ? coneString(v.carton, boxes) : "Zu viele Kartons für die Textform.");
  const step = coneState.step == null || coneState.step > n ? n : coneState.step;
  const si = /** @type {HTMLInputElement} */ ($("#cv-step"));
  si.max = String(Math.max(1, n)); si.value = String(Math.max(1, step));
  $("#cv-stepper").hidden = n < 2;
  $("#cv-step-out").textContent = stepText(step, n, v.blocks);
  drawConeCurrent(step);
  const kinds = [...new Set(boxes.map(orient))];
  $("#cv-legend").innerHTML = ["flat", "side", "up"].filter((k) => kinds.includes(/** @type {"flat"} */ (k)))
    .map((k) => `<span><i class="sw o-${k}"></i>${ORIENT[/** @type {"flat"} */ (k)].one}</span>`).join("");
  $("#cv-list").innerHTML = boxListHtml(boxes, step, v.blocks);
}
/** @param {ConeItem[]} shown @returns {string} */
function drawConeSVG(shown) {
  const b = coneState.bin;
  const total = coneState.view ? coneState.view.total : 0;
  return drawSVG([b.topL, b.topW, coneHeight(b)], shown.length <= DRAW_MAX ? shown : [], `${total} Kartons im konischen Bin`, { botL: b.botL, botW: b.botW, coneH: b.coneH });
}
/** @param {number} step */
function drawConeCurrent(step) {
  const v = coneState.view;
  if (!v || !v.boxes) return;
  $("#cv-svg").innerHTML = drawConeSVG(v.boxes.slice(0, step).map((p, i) => ({ ...p, num: v.blocks ? p.count : i + 1 })));
}
$("#cv-step").addEventListener("input", (e) => {
  const v = coneState.view;
  if (!v || !v.boxes) return;
  coneState.step = +(/** @type {HTMLInputElement} */ (e.target)).value;
  const n = v.boxes.length;
  $("#cv-step-out").textContent = stepText(coneState.step, n, v.blocks);
  document.querySelectorAll("#cv-list li").forEach((li, i) => li.classList.toggle("later", i >= /** @type {number} */ (coneState.step)));
  drawConeCurrent(coneState.step);
});

/* ---------- Regeln erzeugen ---------- */
let coneGenWorker = /** @type {Worker | null} */ (null);
let coneGenId = 0;
/** @returns {{nmax: number, quality: "fast"|"std"|"full", res: number} | null} Einstellungen der Regelerzeugung */
function coneGenSettings() {
  const nmax = Math.round(+(/** @type {HTMLInputElement} */ ($("#cg-nmax"))).value);
  if (!(nmax >= 2 && nmax <= NMAX_LIMIT)) return null;
  return { nmax, quality: /** @type {"fast"|"std"|"full"} */ ((/** @type {HTMLSelectElement} */ ($("#cg-quality"))).value), res: +(/** @type {HTMLSelectElement} */ ($("#cg-res"))).value || 1 };
}
const coneGenEst = { w: /** @type {Worker | null} */ (null), t: 0, ms: 0 };
function requestConeGenEstimate() {
  const g = coneGenSettings();
  if (!g) { $("#cg-est").textContent = ""; return; }
  estimateGen({ type: "genest", cone: true, bin: coneState.bin, quality: g.quality, nmax: g.nmax, res: g.res }, "#cg-est", coneGenEst);
}
for (const id of ["#cg-nmax", "#cg-quality", "#cg-res"]) $(id).addEventListener("change", requestConeGenEstimate);
function stopConeGen() {
  if (coneGenWorker) { coneGenWorker.terminate(); coneGenWorker = null; }
  $("#cg-progress").hidden = true; $("#cg-stop").hidden = true;
  (/** @type {HTMLButtonElement} */ ($("#cg-start"))).disabled = false;
}
$("#cg-stop").addEventListener("click", () => { stopConeGen(); $("#cg-source").textContent = "Berechnung abgebrochen."; if (coneState.rules.length) loadConeRules(); });
$("#cg-start").addEventListener("click", () => {
  const g = coneGenSettings();
  if (!g) { $("#cg-source").textContent = `Die Höchstanzahl muss zwischen 2 und ${NMAX_LIMIT} liegen.`; return; }
  const b = readConeBin();
  if (!b) return;
  coneState.bin = b;
  stopConeGen();
  coneGenId = ++coneSeq;
  coneGenWorker = makeWorker(onConeGenMsg, () => { stopConeGen(); $("#cg-source").textContent = "Die Hintergrundberechnung konnte nicht starten. Öffne die Seite über einen Webserver statt als Datei."; });
  if (!coneGenWorker) { $("#cg-source").textContent = "Dieser Browser erlaubt keine Hintergrundberechnung. Die Regeln lassen sich hier leider nicht erzeugen."; return; }
  // Zeitlimit: mindestens das der Voreinstellung, bei großen Bins das Vierfache der Schätzung
  const opt = coneGenOptions(g.quality, g.nmax, g.res, Math.max(CONE_QUALITY[g.quality].maxMs, 4 * coneGenEst.ms));
  coneGenWorker.postMessage({ type: "conegen", id: coneGenId, bin: coneState.bin, opt, quality: g.quality });
  $("#cg-progress").hidden = false; $("#cg-stop").hidden = false;
  (/** @type {HTMLButtonElement} */ ($("#cg-start"))).disabled = true;
  $("#cg-status").textContent = "Startet …"; $("#cg-bar").style.width = "0%";
});
/** @param {any} d */
function onConeGenMsg(d) {
  if (d.id !== coneGenId) return;
  if (d.type === "progress") {
    const g = coneGenSettings();
    const pr = genProgress(d.p, g ? g.res : 1);
    $("#cg-bar").style.width = (pr.frac * 100).toFixed(1) + "%";
    $("#cg-status").textContent = pr.text;
  } else if (d.type === "conegen") {
    stopConeGen();
    const data = /** @type {ConeRulesData} */ (d.data);
    if (coneBinKey(data.cone) !== coneBinKey(coneState.bin)) return;
    const saved = saveConeRules(data);
    setConeRules(data, "new");
    if (!saved) $("#cg-source").textContent += " Die Liste ließ sich in diesem Browser nicht speichern; nach dem Neuladen ist sie weg. Sichere sie mit „Als Textdatei speichern“.";
  }
}

/* ---------- Regelliste anzeigen ---------- */
function renderConeRuleStats() {
  const R = coneState.rules, info = /** @type {ConeRulesInfo} */ (coneState.rulesInfo);
  const nmax = info.nmax;
  /** @type {Record<string, number>} */ const kinds = { dp: 0, grid: 0, manual: 0 };
  R.forEach((r) => { kinds[r.src] = (kinds[r.src] || 0) + 1; });
  $("#cr-stats").innerHTML = `<span><b>${R.length}</b> Regeln</span><span><b>${kinds.grid}</b> einfache Gitter am Boden</span><span><b>${kinds.dp}</b> Lagenmuster</span>${kinds.manual ? `<span><b>${kinds.manual}</b> selbst übernommen</span>` : ""}<span>„then ${nmax}“ heißt ${nmax} oder mehr</span>`;
  /** @type {number[]} */ const per = new Array(nmax + 1).fill(0);
  R.forEach((r) => per[r.score]++);
  const mx = Math.max(1, ...per);
  $("#cr-hist").innerHTML = per.slice(1).map((c, i) => `<button type="button" data-n="${i + 1}" class="${coneState.filter === String(i + 1) ? "on" : ""}" title="${i + 1} Kartons: ${c} Regeln" aria-label="${i + 1} Kartons, ${c} Regeln"><i style="height:${(c / mx * 100).toFixed(0)}%"></i></button>`).join("");
  $("#cr-hist-axis").innerHTML = `<span>1</span><span>Anzahl Kartons</span><span>${nmax}</span>`;
}
$("#cr-hist").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b) return;
  coneState.filter = coneState.filter === b.dataset.n ? "all" : /** @type {string} */ (b.dataset.n);
  (/** @type {HTMLSelectElement} */ ($("#cr-filter"))).value = coneState.filter;
  renderConeRuleStats(); renderConeRuleList();
});
function renderConeFilter() {
  const nmax = (/** @type {ConeRulesInfo} */ (coneState.rulesInfo)).nmax;
  const opts = [`<option value="all">Alle</option>`];
  for (let n = nmax; n >= 1; n--) { const c = coneState.rules.filter((r) => r.score === n).length; if (c) opts.push(`<option value="${n}">${n}${n === nmax ? " oder mehr" : ""} (${c})</option>`); }
  $("#cr-filter").innerHTML = opts.join("");
  (/** @type {HTMLSelectElement} */ ($("#cr-filter"))).value = coneState.filter;
}
$("#cr-filter").addEventListener("change", (e) => { coneState.filter = (/** @type {HTMLSelectElement} */ (e.target)).value; renderConeRuleStats(); renderConeRuleList(); });
function renderConeRuleList() {
  const nmax = (/** @type {ConeRulesInfo} */ (coneState.rulesInfo)).nmax;
  const hit = coneState.carton ? coneLookup(coneState.carton).rule : null;
  /** @type {Map<number, number>} */ const per = new Map();
  coneState.rules.forEach((r) => per.set(r.score, (per.get(r.score) || 0) + 1));
  const rows = [];
  let cur = -1, shown = 0, total = 0;
  for (const r of coneState.rules) {
    if (coneState.filter !== "all" && String(r.score) !== coneState.filter) continue;
    total++;
    if (shown >= RULE_ROWS_MAX) continue;
    shown++;
    if (r.score !== cur) {
      cur = r.score;
      const c = per.get(cur) || 0;
      rows.push(`<tr class="grp"><th colspan="4">${cur}${cur === nmax ? " oder mehr" : ""} ${cur === 1 ? "Karton" : "Kartons"}<span>${c} ${c === 1 ? "Regel" : "Regeln"}</span></th></tr>`);
    }
    rows.push(`<tr class="${hit === r ? "hit" : ""}"><td class="rule">${esc(coneRuleText(r.rows, r.score, U()))}</td><td class="ex">${r.example ? dimsText(r.example) : "–"}</td><td class="pat"><span title="${esc(r.pat)}">${esc(r.pat)}</span></td><td><button type="button" class="btn small" data-show-rule="${r.id}">Zeigen</button></td></tr>`);
  }
  $("#cr-list").innerHTML = rows.join("") + moreRowsHtml(shown, total);
}
$("#cr-list").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("[data-show-rule]");
  if (b) showConeRule(+(/** @type {string} */ ((/** @type {HTMLElement} */ (b)).dataset.showRule)));
});
/** @param {boolean} withPat @returns {string} */
function coneExportText(withPat) { return coneRulesToText(coneState.bin, (/** @type {ConeRulesInfo} */ (coneState.rulesInfo)).nmax, coneState.rules, withPat, U()); }
$("#cr-copy-all").addEventListener("click", (e) => copyText(coneExportText(true), /** @type {HTMLElement} */ (e.currentTarget)));
$("#cr-copy-rules").addEventListener("click", (e) => copyText(coneExportText(false), /** @type {HTMLElement} */ (e.currentTarget)));
$("#cr-download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([coneExportText(true)], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `regeln_${coneBinKey(coneState.bin)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
/* Markierung der Regel, die für den aktuellen Karton gilt */
function markConeHit() {
  const hit = coneState.carton ? coneLookup(coneState.carton).rule : null;
  document.querySelectorAll("#cr-list tr.hit").forEach((tr) => tr.classList.remove("hit"));
  if (!hit) return;
  const btn = document.querySelector(`#cr-list [data-show-rule="${hit.id}"]`);
  if (btn) { const tr = btn.closest("tr"); if (tr) tr.classList.add("hit"); }
}

/* ---------- Start: beim ersten Öffnen des Reiters ---------- */
rerenderHooks.push(() => {
  if (!coneState.ready) return;
  renderConeFacts();
  renderConeSource();
  renderConeResult();
  renderConeViewer();
  if (coneState.rules.length) renderConeRuleList();
});
tabInit.cone = () => {
  bindUnitSelect("#cb-unit", CONE_FIELDS.map((k) => "#cb-" + k));
  bindUnitSelect("#cc-unit", ["#cc-a", "#cc-b", "#cc-c"]);
  restoreDims("konisch-karton", ["#cc-a", "#cc-b", "#cc-c"], "#cc-unit");
  try {
    const saved = JSON.parse(localStorage.getItem(CONE_STORE) || "null");
    if (saved && !coneBinError(saved)) { coneState.bin = saved; writeConeBin(saved); }
  } catch (e) { /* Speicher nicht verfügbar */ }
  coneState.ready = true;
  renderConeFacts();
  renderConeViewer();
  setAutoRes("#cg-res", Math.max(coneState.bin.topL, coneState.bin.topW, coneHeight(coneState.bin)));
  loadConeRules();
  startConeCheck();
  requestConeGenEstimate();
};
