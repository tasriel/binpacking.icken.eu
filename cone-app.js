"use strict";
/*
 * cone-app.js: Bedienung des Reiters „Konischer Bin“.
 * Nutzt die Helfer aus app.js ($, fmt, dimsText, esc, readNums, makeWorker, startJob, copyText,
 * drawSVG, ORIENT, orient, orientSummary, fetchPreIndex) und die Rechenkerne cone.js und cone-rules.js.
 */

/**
 * @typedef {{kind: "check" | "loaded" | "rule", carton: number[] | null, placements: ConePlacement[], eyebrow: string,
 *   note: string, ruleText: string | null, patText: string | null, boxes?: ConePlacement[]}} ConeView
 * @typedef {ConeStoredRule & {example: number[] | null, text: string, id: number, root: TreeNode, ref: number[] | null}} ConeUiRule
 * @typedef {{nmax: number, quality: string, source: string, meta?: object, stats?: object}} ConeRulesInfo
 */

const coneState = {
  bin: /** @type {ConeBin} */ ({ ...CONE_DEFAULT }),
  carton: /** @type {number[] | null} */ (null),
  check: /** @type {{id: number, result: ConeAnalysis | null, mode: "quick" | "exact"} | null} */ (null),
  view: /** @type {ConeView | null} */ (null),
  step: /** @type {number | null} */ (null),
  rules: /** @type {ConeUiRule[]} */ ([]),
  rulesInfo: /** @type {ConeRulesInfo | null} */ (null),
  filter: "all"
};
const CONE_FIELDS = /** @type {(keyof ConeBin)[]} */ (["topL", "topW", "rimH", "botL", "botW", "coneH"]);
const CONE_STORE = "kartonregeln:konisch";

/* ---------- Bin-Maße ---------- */
/** @returns {ConeBin | null} */
function readConeBin() {
  /** @type {Record<string, number>} */ const b = {};
  for (const k of CONE_FIELDS) b[k] = parseFloat(String(/** @type {HTMLInputElement} */ ($("#cb-" + k)).value).replace(",", "."));
  const bin = /** @type {ConeBin} */ (/** @type {unknown} */ (b));
  const err = coneBinError(bin);
  const el = $("#cb-err");
  el.hidden = !err;
  if (err) { el.textContent = err; return null; }
  return bin;
}
/** @param {ConeBin} b */
function writeConeBin(b) {
  for (const k of CONE_FIELDS) (/** @type {HTMLInputElement} */ ($("#cb-" + k))).value = String(b[k]);
}
/** @param {ConeBin} b @returns {string} z. B. "Öffnung 558 × 374, Boden 515 × 336, Höhe 409 mm" */
function coneBinText(b) { return `Öffnung ${fmt(b.topL)} × ${fmt(b.topW)}, Boden ${fmt(b.botL)} × ${fmt(b.botW)}, Höhe ${fmt(coneHeight(b))} mm`; }
function renderConeFacts() {
  const b = coneState.bin;
  const pct = (/** @type {number} */ d) => (b.coneH > 0 ? fmt(Math.atan(d / b.coneH) * 180 / Math.PI) : "0");
  const dl = (b.topL - b.botL) / 2, dw = (b.topW - b.botW) / 2;
  $("#cb-facts").innerHTML = `<span>Gesamthöhe <b>${fmt(coneHeight(b))} mm</b></span>
    <span>Wand je Seite um <b>${fmt(dl)} mm</b> (Länge, ${pct(dl)}°) und <b>${fmt(dw)} mm</b> (Breite, ${pct(dw)}°) geneigt</span>
    <span>Volumen <b>${fmt(coneVolume(b) / 1e6)} l</b></span>`;
}
/** Neue Bin-Maße übernehmen: Regeln und Ergebnis gehören zum eingestellten Bin */
function coneBinChanged() {
  coneState.view = null;
  renderConeFacts();
  stopConeGen();
  loadConeRules();
  startConeCheck();
}
let coneBinTimer = 0;
$("#cb-form").addEventListener("input", () => {
  clearTimeout(coneBinTimer);
  coneBinTimer = window.setTimeout(() => {
    const b = readConeBin();
    if (!b) return;
    coneState.bin = b;
    try { localStorage.setItem(CONE_STORE, JSON.stringify(b)); } catch (e) { /* Speicher nicht verfügbar */ }
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
      out.push({ ...r, example, text: coneRuleText(r.rows, r.score), id: out.length, root: p.root, ref: p.ref });
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
/** @param {ConeRulesData | null} data @param {string} source */
function setConeRules(data, source) {
  if (!data) {
    coneState.rules = []; coneState.rulesInfo = null;
    $("#cr-body").hidden = true;
    $("#cg-source").textContent = `Für diesen Bin (${coneBinText(coneState.bin)}) gibt es noch keine Regelliste. Wähle die Genauigkeit und starte die Berechnung. Sie läuft im Hintergrund, du kannst die Seite währenddessen weiter benutzen.`;
    renderConeResult();
    if (!coneState.view || coneState.view.kind === "check") showConeCheck();
    return;
  }
  coneState.rules = inflateConeRules(data);
  coneState.rulesInfo = { nmax: data.nmax, quality: data.quality, source, meta: data.meta, stats: data.stats };
  (/** @type {HTMLInputElement} */ ($("#cg-nmax"))).value = String(data.nmax);
  const q = CONE_QUALITY[/** @type {"fast" | "std" | "full"} */ (data.quality)];
  const when = source === "pre" ? "Vorberechnet" : source === "saved" ? "In diesem Browser gespeichert" : "Gerade berechnet";
  $("#cg-source").textContent = `${when}: ${coneState.rules.length} Regeln für diesen Bin (${coneBinText(coneState.bin)}), Höchstanzahl ${data.nmax}, Genauigkeit „${q ? q.label : data.quality}“.`;
  $("#cr-body").hidden = false;
  coneState.filter = "all";
  renderConeRuleStats(); renderConeFilter(); renderConeRuleList(); renderConeResult();
  if (!coneState.view || coneState.view.kind === "check") showConeCheck();
}
/** @returns {ConeRulesData} */
function coneExportData() {
  const info = /** @type {ConeRulesInfo} */ (coneState.rulesInfo);
  return { cone: coneState.bin, nmax: info.nmax, quality: info.quality, meta: info.meta, stats: info.stats,
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
/** Rechenzeit für „Genau rechnen“ in ms. Die schnelle Rechnung nutzt nur Lagen aus Blockmustern. */
const CONE_EXACT_MS = 8000;
/** @param {boolean} [exact] true = mit verschränkten Lagen und freier Suche */
function startConeCheck(exact = false) {
  const dims = readNums(["#cc-a", "#cc-b", "#cc-c"]);
  if (!dims) { coneState.carton = null; coneState.check = null; renderConeResult(); showConeCheck(); return; }
  coneState.carton = [...dims].sort((a, b) => b - a);
  const id = ++coneSeq;
  const prev = exact && coneState.check && coneState.check.result ? { ...coneState.check.result, final: false } : null;
  coneState.check = { id, result: prev, mode: exact ? "exact" : "quick" };
  if (coneJob) coneJob.stop();
  const msg = { type: "cone", id, carton: coneState.carton, bin: coneState.bin, budget: exact ? CONE_EXACT_MS : 0 };
  const local = () => {
    if (!coneState.check || coneState.check.id !== id) return;
    onConeMsg({ type: "cone", id, result: analyzeConeLayers(msg.carton, msg.bin, exact ? 1500 : 0) });
  };
  const timeout = () => {
    if (!coneState.check || coneState.check.id !== id || !coneState.check.result) return;
    coneState.check.result = { ...coneState.check.result, final: true };
    renderConeResult();
  };
  coneJob = startJob(msg, onConeMsg, local, (d) => !!(d.result && d.result.final), msg.budget, timeout);
  renderConeResult();
}
/** @param {any} d */
function onConeMsg(d) {
  if (d.type !== "cone" || !coneState.check || d.id !== coneState.check.id) return;
  coneState.check.result = /** @type {ConeAnalysis} */ (d.result);
  renderConeResult();
  if (!coneState.view || coneState.view.kind === "check") showConeCheck();
}
let coneCkTimer = 0;
$("#cc-form").addEventListener("input", () => { clearTimeout(coneCkTimer); coneCkTimer = window.setTimeout(() => startConeCheck(), 350); });
$("#cc-result").addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.id === "cc-exact") startConeCheck(true);
  if (t.id === "cc-add-rule") addConeCheckAsRule();
  if (t.id === "cc-cancel" && coneState.check && coneState.check.result) {
    if (coneJob) coneJob.stop();
    coneState.check = { id: ++coneSeq, result: { ...coneState.check.result, final: true }, mode: "quick" };
    renderConeResult();
  }
  const sr = t.closest("[data-show-rule]");
  if (sr) showConeRule(+(/** @type {string} */ ((/** @type {HTMLElement} */ (sr)).dataset.showRule)));
});
$("#cc-form").addEventListener("submit", (e) => e.preventDefault());

/**
 * Bestes bekanntes Ergebnis: eigener Löser oder Regelliste.
 * @returns {{source: "own" | "list", count: number, placements: ConePlacement[], rule: ConeUiRule | null,
 *   list: {score: number, rule: ConeUiRule | null}} | null}
 */
function bestForCone() {
  const ck = coneState.check;
  if (!ck || !ck.result || !coneState.carton) return null;
  const r = ck.result;
  const list = coneState.rules.length ? coneLookup(coneState.carton) : { score: 0, rule: null };
  const nmax = coneState.rulesInfo ? coneState.rulesInfo.nmax : Infinity;
  if (list.rule && list.score > Math.min(r.count, nmax)) {
    return { source: "list", count: list.rule.count, placements: coneLayout(list.rule.root, coneState.carton, coneState.bin), rule: list.rule, list };
  }
  return { source: "own", count: r.count, placements: r.placements, rule: null, list };
}

/** @param {ConePlacement[]} P @returns {string} z. B. "Boden 4 · ab 100 mm 6" */
function coneLevels(P) {
  /** @type {Map<number, number>} */ const lv = new Map();
  for (const p of P) { const k = Math.round(p.z * 10) / 10; lv.set(k, (lv.get(k) || 0) + 1); }
  return [...lv.entries()].sort((a, b) => a[0] - b[0]).map(([z, n]) => (z === 0 ? `am Boden ${n}` : `ab ${fmt(z)} mm ${n}`)).join(" · ");
}
function renderConeResult() {
  const el = $("#cc-result");
  const ck = coneState.check;
  if (!coneState.carton || !ck) { el.innerHTML = `<div class="r-count">–</div><div class="r-main">Bitte drei positive Maße eingeben.</div>`; return; }
  const r = ck.result;
  const b = coneState.bin;
  const where = `à <b>${dimsText(coneState.carton)}</b> mm im konischen Bin`;
  const best = bestForCone();
  if (!r || !best) { el.innerHTML = `<div class="r-count">…<small>Kartons</small></div><div class="r-main"><span>${where}</span><span class="chip run">rechnet</span></div><div class="r-sub">&nbsp;</div>`; return; }
  const nmax = coneState.rulesInfo ? coneState.rulesInfo.nmax : null;
  let chip;
  if (r.status === "optimal" || best.count >= r.upper) chip = `<span class="chip ok">optimal, mehr passen nicht</span>`;
  else if (r.status === "searched" && best.count <= r.count) chip = `<span class="chip ok">vollständig durchsucht, mehr passen nicht</span>`;
  else if (!r.final) chip = ck.mode === "exact" ? `<span class="chip run">rechnet genau</span> <button type="button" class="btn small" id="cc-cancel">Abbrechen</button>` : `<span class="chip run">rechnet</span>`;
  else if (ck.mode === "quick") chip = `<span class="chip open">schnelle Rechnung, mehr ist möglich</span> <button type="button" class="btn small" id="cc-exact">Genau rechnen</button>`;
  else chip = `<span class="chip open">offen: ${best.count + 1} nicht ausgeschlossen</span>`;
  const parts = [];
  if (best.count > 0) {
    parts.push(`<span>Ebenen: ${coneLevels(best.placements)}</span>`);
    const sup = coneMinSupport(best.placements);
    if (sup < 0.995) parts.push(`<span>kleinste Auflage ${Math.round(sup * 100)} %</span>`);
    if (r.topCuboid > 0) parts.push(`<span>Zum Vergleich, gerader Bin: mit Bodenmaß ${r.bottomCuboid}, mit Öffnungsmaß ${r.topCuboid}</span>`);
  } else parts.push(`<span>Der Karton passt in keiner Lage in den Bin.</span>`);
  if (coneState.rules.length) {
    const L = best.list;
    if (best.source === "list") parts.push(`<span>Das Muster stammt aus der Regelliste. Der Einzellöser hat ${r.count} gefunden.</span>`);
    else if (Math.min(r.count, nmax || Infinity) > L.score) {
      parts.push(`<span>Die Regelliste kennt hier nur ${L.score}.${r.layers ? ` <button type="button" class="link" id="cc-add-rule">Muster als Regel übernehmen</button>` : " Das Muster ist kein Lagenmuster und lässt sich nicht als Regel übernehmen."}</span>`);
    } else if (L.rule) parts.push(`<span>Laut Regelliste ${L.score}${nmax && L.score >= nmax ? " oder mehr" : ""} · <button type="button" class="link" data-show-rule="${L.rule.id}">Regel ${L.rule.id + 1} anzeigen</button></span>`);
  }
  el.innerHTML = `<div class="r-count">${best.count}<small>${best.count === 1 ? "Karton" : "Kartons"}</small></div>
    <div class="r-main"><span>${where} (${coneBinText(b)})</span>${chip}</div>
    <div class="r-sub">${parts.join("")}</div>`;
  if (coneState.rules.length) markConeHit();
}
function addConeCheckAsRule() {
  const ck = coneState.check, info = coneState.rulesInfo, c = coneState.carton;
  if (!ck || !ck.result || !ck.result.layers || !info || !c) return;
  const p = parseConeAny(ck.result.layers);
  if (p.kind !== "layers") return;
  const rule = coneRule(p.root, coneState.bin, c);
  if (!rule.ok) return;
  const score = Math.min(rule.count, info.nmax);
  const example = coneExample(polyVertices(/** @type {Row[]} */ (rule.rows).concat(coneDomainRows())), rule.rows, c);
  coneState.rules.push({ score, count: rule.count, rows: rule.rows, pat: ck.result.layers, src: "manual", example, text: coneRuleText(rule.rows, score), id: 0, root: p.root, ref: c });
  coneState.rules.sort((a, b) => (b.score - a.score) || (vol(b.example) - vol(a.example)));
  coneState.rules.forEach((x, i) => { x.id = i; });
  saveConeRules(coneExportData());
  renderConeRuleStats(); renderConeFilter(); renderConeRuleList(); renderConeResult();
}

/* ---------- Packmuster-Ansicht ---------- */
/** @type {{key: string, text: string} | null} zuletzt berechnete Regel zum eigenen Lagenmuster */
let coneOwnRule = null;
/** @param {string} layers Textform @returns {string | null} Regel zum Lagenmuster des eigenen Kartons */
function coneOwnRuleText(layers) {
  const key = coneBinKey(coneState.bin) + "|" + layers;
  if (coneOwnRule && coneOwnRule.key === key) return coneOwnRule.text;
  try {
    const p = parseConeAny(layers);
    if (p.kind !== "layers") return null;
    const rule = coneRule(p.root, coneState.bin, p.ref);
    coneOwnRule = { key, text: coneRuleText(rule.rows, rule.count) };
    return coneOwnRule.text;
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
  let ruleText = null, patText = null, eyebrow = "Dein Karton";
  if (best.rule) { ruleText = best.rule.text; patText = best.rule.pat; eyebrow = `Dein Karton · Muster aus Regel ${best.rule.id + 1}`; }
  else if (ck.result.layers) { ruleText = coneOwnRuleText(ck.result.layers); patText = ruleText ? ck.result.layers : null; }
  coneState.view = { kind: "check", carton: coneState.carton, placements: best.placements, eyebrow, note: "", ruleText, patText };
  coneState.step = null;
  renderConeViewer();
}
function scrollToConeViewer() {
  $("#cc-viewer").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
/** @param {ConeRow[]} rows @param {number[]} c @returns {string} verletzte Bedingungen als Text */
function coneViolated(rows, c) {
  return rows.filter((k) => dot(k.a, c) > k.b + 1e-7).map((k) => rowText(k).replace("<=", " ≤ ")).join(", ");
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
      if (carton) note = `Dein Karton ${dimsText(carton)} passt nicht in dieses Muster (verletzt: ${coneViolated(rows, carton)}). Gezeigt mit dem größten passenden Karton ${dimsText(example)} mm.`;
      carton = example;
    }
  }
  const placements = carton ? coneLayout(root, carton, coneState.bin) : [];
  if (carton) {
    const problems = coneCheck(coneState.bin, [...placements].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x)));
    if (problems.length) note = `${note ? note + " " : ""}Achtung: ${problems.slice(0, 2).join(" ")}`;
  }
  coneState.view = { kind, carton, placements, eyebrow, note, ruleText: coneRuleText(rows, count), patText };
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
    if (parsed.kind === "layers") {
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
    const problems = coneCheck(coneState.bin, [...parsed.placements].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x)));
    const note = problems.length
      ? `Dieses Muster passt nicht zu den eingestellten Bin-Maßen: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` und ${problems.length - 3} weitere Probleme.` : ""}`
      : "";
    coneState.view = { kind: "loaded", carton: parsed.carton, placements: parsed.placements, eyebrow: "Geladenes Muster", note, ruleText: null, patText: null };
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
    $("#cv-rule").textContent = v && v.ruleText ? v.ruleText : "–";
    $("#cv-pat").textContent = v && v.patText ? v.patText : "–";
    $("#cv-svg").innerHTML = drawConeSVG([]);
    $("#cv-legend").innerHTML = ""; $("#cv-list").innerHTML = ""; $("#cv-stepper").hidden = true;
    return;
  }
  const boxes = [...v.placements].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));
  v.boxes = boxes;
  const n = boxes.length;
  $("#cv-eyebrow").textContent = v.eyebrow;
  $("#cv-title").innerHTML = `${n} ${n === 1 ? "Karton" : "Kartons"} <span class="u">à ${dimsText(v.carton)} mm</span>`;
  $("#cv-meta").innerHTML = `<b>${v.patText ? "Lagenmuster" : "Freies Muster"}</b> · ${orientSummary(boxes)} · Ebenen: ${coneLevels(boxes)}`;
  $("#cv-note").hidden = !v.note; $("#cv-note").textContent = v.note;
  $("#cv-rule").textContent = v.ruleText || "Keine Regel: Dieses Muster ist kein Lagenmuster.";
  $("#cv-pat").textContent = v.patText || (n <= 5000 ? coneString(v.carton, boxes) : "Zu viele Kartons für die Textform.");
  const step = coneState.step == null || coneState.step > n ? n : coneState.step;
  const si = /** @type {HTMLInputElement} */ ($("#cv-step"));
  si.max = String(Math.max(1, n)); si.value = String(Math.max(1, step));
  $("#cv-stepper").hidden = n < 2;
  $("#cv-step-out").textContent = `Karton 1 bis ${step} von ${n}${step < n ? ", weitere ausgeblendet" : ""}`;
  drawConeCurrent(step);
  const kinds = [...new Set(boxes.map(orient))];
  $("#cv-legend").innerHTML = ["flat", "side", "up"].filter((k) => kinds.includes(/** @type {"flat"} */ (k)))
    .map((k) => `<span><i class="sw o-${k}"></i>${ORIENT[/** @type {"flat"} */ (k)].one}</span>`).join("");
  $("#cv-list").innerHTML = n <= 80 ? boxes.map((p, i) => `<li class="${i >= step ? "later" : ""}"><span class="num">${i + 1}</span><span>${ORIENT[orient(p)].one}</span>
    <span class="pos">L ${fmt(p.x)}–${fmt(p.x + p.dx)} · B ${fmt(p.y)}–${fmt(p.y + p.dy)} · H ${fmt(p.z)}–${fmt(p.z + p.dz)}</span></li>`).join("") : "";
}
/** @param {(ConePlacement & {num?: number})[]} shown @returns {string} */
function drawConeSVG(shown) {
  const b = coneState.bin;
  return drawSVG([b.topL, b.topW, coneHeight(b)], shown.length <= 1500 ? shown : [], `${shown.length} Kartons im konischen Bin`, { botL: b.botL, botW: b.botW, coneH: b.coneH });
}
/** @param {number} step */
function drawConeCurrent(step) {
  const v = coneState.view;
  if (!v || !v.boxes) return;
  $("#cv-svg").innerHTML = drawConeSVG(v.boxes.slice(0, step).map((p, i) => ({ ...p, num: i + 1 })));
}
$("#cv-step").addEventListener("input", (e) => {
  const v = coneState.view;
  if (!v || !v.boxes) return;
  coneState.step = +(/** @type {HTMLInputElement} */ (e.target)).value;
  const n = v.boxes.length;
  $("#cv-step-out").textContent = `Karton 1 bis ${coneState.step} von ${n}${coneState.step < n ? ", weitere ausgeblendet" : ""}`;
  document.querySelectorAll("#cv-list li").forEach((li, i) => li.classList.toggle("later", i >= /** @type {number} */ (coneState.step)));
  drawConeCurrent(coneState.step);
});

/* ---------- Regeln erzeugen ---------- */
let coneGenWorker = /** @type {Worker | null} */ (null);
let coneGenId = 0;
function stopConeGen() {
  if (coneGenWorker) { coneGenWorker.terminate(); coneGenWorker = null; }
  $("#cg-progress").hidden = true; $("#cg-stop").hidden = true;
  (/** @type {HTMLButtonElement} */ ($("#cg-start"))).disabled = false;
}
$("#cg-stop").addEventListener("click", () => { stopConeGen(); $("#cg-source").textContent = "Berechnung abgebrochen."; if (coneState.rules.length) loadConeRules(); });
$("#cg-start").addEventListener("click", () => {
  const nmax = Math.round(+(/** @type {HTMLInputElement} */ ($("#cg-nmax"))).value);
  if (!(nmax >= 2 && nmax <= 60)) { $("#cg-source").textContent = "Die Höchstanzahl muss zwischen 2 und 60 liegen."; return; }
  const b = readConeBin();
  if (!b) return;
  coneState.bin = b;
  const qk = /** @type {"fast" | "std" | "full"} */ ((/** @type {HTMLSelectElement} */ ($("#cg-quality"))).value);
  stopConeGen();
  coneGenId = ++coneSeq;
  coneGenWorker = makeWorker(onConeGenMsg, () => { stopConeGen(); $("#cg-source").textContent = "Die Hintergrundberechnung konnte nicht starten. Öffne die Seite über einen Webserver statt als Datei."; });
  if (!coneGenWorker) { $("#cg-source").textContent = "Dieser Browser erlaubt keine Hintergrundberechnung. Die Regeln lassen sich hier leider nicht erzeugen."; return; }
  coneGenWorker.postMessage({ type: "conegen", id: coneGenId, bin: coneState.bin, opt: coneGenOptions(qk, nmax), quality: qk });
  $("#cg-progress").hidden = false; $("#cg-stop").hidden = false;
  (/** @type {HTMLButtonElement} */ ($("#cg-start"))).disabled = true;
  $("#cg-status").textContent = "Startet …"; $("#cg-bar").style.width = "0%";
});
/** @param {any} d */
function onConeGenMsg(d) {
  if (d.id !== coneGenId) return;
  if (d.type === "progress") {
    const p = d.p;
    const passes = p.passes || 1;
    let frac = 0, text = "";
    if (p.phase === "grid") { frac = ((p.pass - 1) + p.done / p.total) / passes; text = `Raster ${p.step} mm: Linie ${p.done} von ${p.total}`; }
    else if (p.phase === "random") { frac = ((p.pass - 1) + Math.min(1, p.sinceNew / p.patience)) / passes; text = `Zufällige Linien: ${p.done}, seit der letzten neuen Regel ${p.sinceNew} von ${p.patience}`; }
    else if (p.phase === "prune") { frac = 0.97; text = `Räume ${p.rules} Kandidaten auf …`; }
    else if (p.phase === "sweep") { frac = 0.99; text = `Prüfe ${p.rules} Regeln auf dem 1-mm-Raster …`; }
    if (p.maxMs) frac = Math.max(frac, Math.min(0.96, p.elapsed / p.maxMs));
    $("#cg-bar").style.width = (frac * 100).toFixed(1) + "%";
    $("#cg-status").textContent = `${text} · ${p.rules} Regeln bisher · ${Math.round(p.elapsed / 1000)} s`;
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
  let cur = -1;
  for (const r of coneState.rules) {
    if (coneState.filter !== "all" && String(r.score) !== coneState.filter) continue;
    if (r.score !== cur) {
      cur = r.score;
      const c = per.get(cur) || 0;
      rows.push(`<tr class="grp"><th colspan="4">${cur}${cur === nmax ? " oder mehr" : ""} ${cur === 1 ? "Karton" : "Kartons"}<span>${c} ${c === 1 ? "Regel" : "Regeln"}</span></th></tr>`);
    }
    rows.push(`<tr class="${hit === r ? "hit" : ""}"><td class="rule">${esc(r.text)}</td><td class="ex">${r.example ? dimsText(r.example) : "–"}</td><td class="pat"><span title="${esc(r.pat)}">${esc(r.pat)}</span></td><td><button type="button" class="btn small" data-show-rule="${r.id}">Zeigen</button></td></tr>`);
  }
  $("#cr-list").innerHTML = rows.join("");
}
$("#cr-list").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("[data-show-rule]");
  if (b) showConeRule(+(/** @type {string} */ ((/** @type {HTMLElement} */ (b)).dataset.showRule)));
});
/** @param {boolean} withPat @returns {string} */
function coneExportText(withPat) { return coneRulesToText(coneState.bin, (/** @type {ConeRulesInfo} */ (coneState.rulesInfo)).nmax, coneState.rules, withPat); }
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
tabInit.cone = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONE_STORE) || "null");
    if (saved && !coneBinError(saved)) { coneState.bin = saved; writeConeBin(saved); }
  } catch (e) { /* Speicher nicht verfügbar */ }
  renderConeFacts();
  renderConeViewer();
  loadConeRules();
  startConeCheck();
};
