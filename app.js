"use strict";
/*
 * app.js: Bedienung der Seite. Rechenkern: packcore.js (global geladen),
 * Hintergrundrechnung: worker.js, vorberechnete Regellisten: rules/<L>x<B>x<H>.json
 */
/* ---------- Grundlagen ---------- */
const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
/** @param {number} v @returns {string} */
function fmt(v) {
  const t = Math.round(v * 10) / 10;
  const s = t.toFixed(1).replace(".", ",");
  return s.endsWith(",0") ? s.slice(0, -2) : s;
}
/* ---------- Einheiten ----------
 * Gerechnet wird immer in mm. Jede Maßgruppe (Bin, Karton) hat ihre eigene Eingabeeinheit.
 * Die Anzeige (Ergebnisse, Positionen, Regeln) hat eine Einheit für die ganze Seite. Sie
 * folgt der zuletzt gewählten Eingabeeinheit und lässt sich mit den Knöpfen „Anzeige“ umstellen.
 */
/** Größtes zulässiges Maß in mm (100 m) */
const MAX_MM = 100000;
/** @typedef {"mm" | "cm" | "m"} Unit */
const UNIT_STORE = "kartonregeln:einheiten";
/** @type {Record<string, string>} Schrittweite der Eingabefelder je Einheit (immer 0,1 mm) */
const UNIT_STEP = { mm: "0.1", cm: "0.01", m: "0.0001" };
const units = {
  /** @type {Record<string, Unit>} Eingabeeinheit je Maßgruppe, Schlüssel = id des Auswahlfelds */
  input: {},
  disp: /** @type {Unit} */ ("mm")
};
try {
  const saved = JSON.parse(localStorage.getItem(UNIT_STORE) || "null");
  if (saved && saved.input && UNIT_MM[saved.disp]) { units.input = saved.input; units.disp = saved.disp; }
} catch (e) { /* Speicher nicht verfügbar */ }
function saveUnits() { try { localStorage.setItem(UNIT_STORE, JSON.stringify(units)); } catch (e) { /* Speicher nicht verfügbar */ } }
/** @returns {Unit} Einheit der Anzeige */
const U = () => units.disp;
/**
 * Länge in der Anzeigeeinheit, mit Dezimalkomma, auf 0,1 mm genau.
 * @param {number} mm @returns {string}
 */
function len(mm) { return lenText(Math.round(mm * 10) / 10, units.disp).replace(".", ","); }
/** @param {number[]} c Maße in mm @returns {string} in der Anzeigeeinheit, ohne Einheit dahinter */
const dimsText = (c) => c.map(len).join(" × ");
/** @param {number} ms @returns {string} z. B. "etwa 40 s", "etwa 12 min" */
function durText(ms) {
  const sec = ms / 1000;
  if (sec < 1.5) return "etwa 1 s";
  if (sec < 90) return `etwa ${sec < 10 ? Math.round(sec) : Math.round(sec / 5) * 5} s`;
  if (sec < 5400) return `etwa ${Math.round(sec / 60)} min`;
  return `etwa ${String(Math.round(sec / 360) / 10).replace(".", ",")} h`;
}
/** @type {(() => void)[]} zeichnen alles neu, was Maße zeigt (nach einem Wechsel der Anzeigeeinheit) */
const rerenderHooks = [];
function rerenderAll() {
  document.querySelectorAll(".disp-switch button").forEach((b) => b.setAttribute("aria-pressed", String((/** @type {HTMLElement} */ (b)).dataset.disp === units.disp)));
  document.querySelectorAll(".disp-unit").forEach((el) => { el.textContent = units.disp; });
  for (const f of rerenderHooks) f();
}
/** @param {Unit} u */
function setDisplayUnit(u) { units.disp = u; saveUnits(); rerenderAll(); }
/**
 * Verbindet ein Auswahlfeld mm / cm / m mit seinen Eingabefeldern. Beim Umstellen werden
 * die Zahlen umgerechnet, die Maße selbst bleiben gleich.
 * @param {string} selId id des Auswahlfelds (mit #) @param {string[]} inputIds ids der Eingabefelder (mit #)
 */
function bindUnitSelect(selId, inputIds) {
  const sel = /** @type {HTMLSelectElement} */ ($(selId));
  /** @param {Unit} from @param {Unit} to */
  const convert = (from, to) => {
    for (const id of inputIds) {
      const el = /** @type {HTMLInputElement} */ ($(id));
      const v = parseFloat(String(el.value).replace(",", "."));
      if (isFinite(v) && from !== to) el.value = lenText(Math.round(v * UNIT_MM[from] * 10) / 10, to);
      el.step = UNIT_STEP[to];
    }
  };
  const start = units.input[selId] || "mm";
  sel.value = start;
  convert("mm", start);
  sel.addEventListener("change", () => {
    const from = units.input[selId] || "mm", to = /** @type {Unit} */ (sel.value);
    units.input[selId] = to;
    convert(from, to);
    setDisplayUnit(to);
  });
}
/**
 * Merkt sich eingegebene Maße (in mm) für den nächsten Besuch.
 * @param {string} key @param {number[]} mm
 */
function saveDims(key, mm) { try { localStorage.setItem("kartonregeln:" + key, JSON.stringify(mm)); } catch (e) { /* Speicher nicht verfügbar */ } }
/**
 * Schreibt gemerkte Maße zurück in ihre Eingabefelder.
 * @param {string} key @param {string[]} ids @param {string} selId @returns {number[] | null} die Maße in mm
 */
function restoreDims(key, ids, selId) {
  try {
    const v = JSON.parse(localStorage.getItem("kartonregeln:" + key) || "null");
    if (!Array.isArray(v) || v.length !== ids.length || !v.every((x) => typeof x === "number" && x > 0 && x <= MAX_MM)) return null;
    ids.forEach((id, i) => writeLen(id, v[i], selId));
    return v;
  } catch (e) { return null; }
}
/** @param {string} selId @returns {Unit} gewählte Eingabeeinheit */
const unitOf = (selId) => units.input[selId] || "mm";
/**
 * Schreibt ein Maß in mm in ein Eingabefeld, in dessen Eingabeeinheit.
 * @param {string} id @param {number} mm @param {string} selId
 */
function writeLen(id, mm, selId) { (/** @type {HTMLInputElement} */ ($(id))).value = lenText(mm, unitOf(selId)); }
/** @param {string} s @returns {string} */
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] || ch));
/**
 * Liest Maße aus Eingabefeldern und rechnet sie in mm um (auf 0,1 mm gerundet).
 * @param {string[]} ids @param {string} selId Auswahlfeld mit der Eingabeeinheit
 * @returns {number[] | null} null, wenn ein Maß fehlt, nicht positiv oder größer als 100 m ist
 */
function readNums(ids, selId) {
  const f = UNIT_MM[unitOf(selId)];
  const v = ids.map((id) => Math.round(parseFloat(String(/** @type {HTMLInputElement} */ ($(id)).value).replace(",", ".")) * f * 10) / 10);
  return v.every((x) => isFinite(x) && x > 0 && x <= MAX_MM) ? v : null;
}
const QUALITY = QUALITY_PRESETS;
/** @typedef {{score: number, count: number, cons: Con[], pat: string, src: string, example: number[] | null, id: number}} UiRule */
/** Größte wählbare Höchstanzahl einer Regelliste */
const NMAX_LIMIT = 1000;
/** So viele Regeln zeigt die Tabelle höchstens auf einmal; der Filter „Anzahl“ grenzt ein */
const RULE_ROWS_MAX = 1500;
/**
 * Hinweis unter einer gekürzten Tabelle.
 * @param {number} shown @param {number} total @returns {string} Tabellenzeile oder leer
 */
function moreRowsHtml(shown, total) {
  return total > shown ? `<tr class="grp"><th colspan="4">Gezeigt sind die ersten ${shown} von ${total} Regeln<span>Mit „Anzahl“ eingrenzen oder die Liste als Textdatei speichern.</span></th></tr>` : "";
}
/** Ab so vielen Kartons zeigt die Zeichnung Blöcke statt einzelner Kartons */
const DRAW_MAX = 1500;

const state = {
  bin: /** @type {number[]} */ ([603, 403, 404]),
  carton: /** @type {number[] | null} */ ([360, 236, 128]),
  check: /** @type {any} */ (null),
  view: /** @type {any} */ (null),
  rules: /** @type {UiRule[]} */ ([]),
  rulesInfo: /** @type {any} */ (null),
  filter: "all",
  step: /** @type {number | null} */ (null)
};
const binKey = (/** @type {number[]} */ b) => binKeyOf(b);

/* ---------- Rechenkern im Hintergrund ---------- */
/** Versionskennung aus dem Script-Tag (app.js?v=…). Sie hängt an allen nachgeladenen Dateien, damit der Browser nach einer Änderung nichts Altes aus dem Zwischenspeicher nimmt. */
const APP_VERSION = (() => {
  const s = /** @type {HTMLScriptElement | null} */ (document.currentScript);
  const m = s ? /[?&]v=([^&]+)/.exec(s.src) : null;
  return m ? m[1] : "";
})();
/**
 * @param {(d: any) => void} onMsg @param {() => void} [onFail] Worker konnte nicht starten
 * @returns {Worker | null}
 */
function makeWorker(onMsg, onFail) {
  try {
    const w = new Worker("worker.js" + (APP_VERSION ? "?v=" + APP_VERSION : ""));
    w.onmessage = (e) => onMsg(e.data);
    if (onFail) w.onerror = (e) => { e.preventDefault(); onFail(); };
    return w;
  } catch (e) { return null; }
}
/**
 * Startet eine Rechnung im Hintergrund. Startet der Worker nicht oder meldet er sich
 * nicht (zum Beispiel, wenn die Seite als Datei geöffnet ist), rechnet die Seite selbst.
 * Bleibt das Endergebnis aus, bricht die Rechnung nach der Rechenzeit plus Reserve ab.
 * @param {object} msg Auftrag an den Worker
 * @param {(d: any) => void} onMsg Ergebnis oder Zwischenergebnis
 * @param {() => void} local dieselbe Rechnung ohne Worker
 * @param {(d: any) => boolean} isFinal erkennt das Endergebnis
 * @param {number} budgetMs Rechenzeit des Auftrags
 * @param {() => void} onTimeout Endergebnis blieb aus
 * @returns {{stop: () => void}}
 */
function startJob(msg, onMsg, local, isFinal, budgetMs, onTimeout) {
  let done = false, got = false, first = 0, last = 0;
  /** @type {Worker | null} */ let w = null;
  const stop = () => { done = true; clearTimeout(first); clearTimeout(last); if (w) { w.terminate(); w = null; } };
  const fail = () => { if (done) return; stop(); setTimeout(local, 20); };
  w = makeWorker((d) => { if (done) return; got = true; if (isFinal(d)) stop(); onMsg(d); }, fail);
  if (!w) { done = true; setTimeout(local, 20); return { stop: () => {} }; }
  w.postMessage(msg);
  first = window.setTimeout(() => { if (!got) fail(); }, 5000);
  last = window.setTimeout(() => { if (!done) { stop(); onTimeout(); } }, budgetMs + 6000);
  return { stop };
}
let seq = 0;

/* ---------- Bin ---------- */
function readBin() {
  const b = readNums(["#bin-l", "#bin-b", "#bin-h"], "#bin-unit");
  const err = $("#bin-err");
  if (!b) { err.textContent = "Bitte drei positive Maße bis 100 m eingeben."; err.hidden = false; return null; }
  err.hidden = true;
  return b;
}
let binTimer = 0;
$("#bin-form").addEventListener("input", (e) => {
  // ein Wechsel der Einheit rechnet nur die Zahlen um, die Maße bleiben gleich
  if ((/** @type {HTMLElement} */ (e.target)).id === "bin-unit") return;
  clearTimeout(binTimer);
  binTimer = window.setTimeout(() => {
    const b = readBin();
    if (!b) return;
    state.bin = b;
    saveDims("quader-bin", b);
    state.view = null;
    stopGen();
    setAutoRes("#g-res", Math.max(...b));
    loadRulesForBin();
    startCheck();
    requestGenEstimate();
  }, 400);
});
$("#bin-form").addEventListener("submit", (e) => e.preventDefault());

/* ---------- Regeln laden, speichern, nachschlagen ---------- */
/** @param {RulesData} data @returns {UiRule[]} */
function inflateRules(data) {
  return unpackRules(data).map((r, i) => ({ ...r, example: exampleCarton(regionVertices(r.cons), data.res || 1), id: i }));
}
function storageKey() { return "kartonregeln:" + binKey(state.bin); }
/** @type {Map<string, RulesData | null>} */ const preCache = new Map();
/** @type {Promise<string[]> | null} */ let preIndex = null;
/** @returns {Promise<string[]>} Bins mit vorberechneter Liste (rules/index.json) */
function fetchPreIndex() {
  if (!preIndex) {
    preIndex = fetch("rules/index.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).then((a) => (Array.isArray(a) ? a.map(String) : [])).catch(() => []);
  }
  return preIndex;
}
/** @param {string} key @returns {Promise<RulesData | null>} vorberechnete Liste aus rules/ */
async function fetchPre(key) {
  if (preCache.has(key)) return /** @type {RulesData | null} */ (preCache.get(key));
  let data = null;
  if ((await fetchPreIndex()).includes(key)) {
    try {
      const res = await fetch(`rules/${encodeURIComponent(key)}.json`, { cache: "no-cache" });
      if (res.ok) data = await res.json();
    } catch (e) { data = null; }
  }
  preCache.set(key, data);
  return data;
}
async function loadRulesForBin() {
  const key = binKey(state.bin);
  const rank = (/** @type {any} */ d) => (d ? ({ fast: 1, std: 2, full: 3 }[/** @type {"fast"} */ (d.quality)] || 0) : -1);
  let data = null, source = "";
  try { const s = localStorage.getItem(storageKey()); if (s) { data = JSON.parse(s); source = "saved"; } } catch (e) { data = null; }
  const pre = await fetchPre(key);
  if (key !== binKey(state.bin)) return;
  if (pre && (!data || rank(pre) > rank(data))) { data = pre; source = "pre"; }
  if (data && data.rules) setRules(data, source); else setRules(null, "");
}
/** @param {number} res @returns {string} */
const resText = (res) => (res === 10 ? "1 cm" : "1 mm");
/** Zeile unter den Knöpfen: woher die Liste stammt, oder dass es noch keine gibt */
function renderSource() {
  const info = state.rulesInfo;
  if (!info) {
    $("#g-source").textContent = `Für ${dimsText(state.bin)} ${U()} gibt es noch keine Regelliste. Wähle Raster und Genauigkeit und starte die Berechnung. Sie läuft im Hintergrund, du kannst die Seite währenddessen weiter benutzen.`;
    return;
  }
  const q = QUALITY[/** @type {"fast"|"std"|"full"} */ (info.quality)];
  const when = info.source === "pre" ? "Vorberechnet" : info.source === "saved" ? "In diesem Browser gespeichert" : "Gerade berechnet";
  $("#g-source").textContent = `${when}: ${state.rules.length} Regeln für ${dimsText(state.bin)} ${U()}, Höchstanzahl ${info.nmax}, Genauigkeit „${q ? q.label : info.quality}“, Raster ${resText(info.res)}.`
    + (info.meta && info.meta.aborted ? " Die Berechnung hat ihr Zeitlimit erreicht; die Liste kann Lücken haben." : "");
}
/** @param {any} data @param {string} source */
function setRules(data, source) {
  if (!data) {
    state.rules = []; state.rulesInfo = null;
    $("#r-body").hidden = true;
    renderSource();
    renderResult();
    if (!state.view || state.view.kind === "check") showCheckView();
    return;
  }
  state.rules = inflateRules({ ...data, bin: state.bin });
  state.rulesInfo = { nmax: data.nmax, quality: data.quality, source, meta: data.meta, stats: data.stats, res: data.res || 1 };
  (/** @type {HTMLInputElement} */ ($("#g-nmax"))).value = String(data.nmax);
  renderSource();
  $("#r-body").hidden = false;
  state.filter = "all";
  renderRuleStats(); renderFilter(); renderRuleList(); renderResult();
  if (!state.view || state.view.kind === "check") showCheckView();
}
/** @param {any} data @returns {boolean} false, wenn der Browser die Liste nicht speichern konnte (zu groß oder kein Speicher) */
function saveRules(data) {
  try { localStorage.setItem(storageKey(), JSON.stringify(data)); return true; } catch (e) { return false; }
}
/** @param {number[]} c sortiert @returns {{score: number, rule: UiRule | null}} */
function lookup(c) {
  let best = 0, hit = null;
  for (const r of state.rules) if (r.score > best && consHold(r.cons, c, 1e-7)) { best = r.score; hit = r; }
  return { score: best, rule: hit };
}

/* ---------- Karton prüfen ---------- */
let checkJob = /** @type {{stop: () => void} | null} */ (null);
/**
 * Stufen für „Genau rechnen“. dpWork: Aufwand für die Blockmuster (reicht er nicht für die
 * vollständige Rechnung, bleibt das Ergebnis ungefähr). searchMs: Zeit für die Suche nach
 * verschränkten Mustern (nur bis SEARCH_MAX_COUNT Kartons möglich).
 * Die schnelle Rechnung nutzt DP_QUICK_WORK und sucht nicht.
 * @typedef {{key: string, label: string, dpWork: number, searchMs: number}} ExactLevel
 * @type {ExactLevel[]}
 */
const EXACT_LEVELS = [
  { key: "1", label: "Gründlich", dpWork: 1e9, searchMs: 6000 },
  { key: "2", label: "Sehr gründlich", dpWork: 3e10, searchMs: 30000 },
  { key: "3", label: "Maximal", dpWork: 1e12, searchMs: 120000 }
];
/**
 * Welche Stufen bringen gegenüber dem vorliegenden Ergebnis noch etwas, und wie lange dauern sie?
 * @param {{effort?: DpEffort, approx?: boolean, searchable?: boolean, done?: {dpWork: number, searchMs: number}}} ck
 * @param {ExactLevel[]} levels
 * @param {(level: ExactLevel) => number} [planWork] Aufwand, den die Stufe wirklich treiben würde
 *   (ohne Angabe: der kleinere Wert aus Stufe und vollständiger Rechnung)
 * @returns {{level: ExactLevel, ms: number}[]}
 */
function exactOptions(ck, levels, planWork) {
  const e = ck.effort;
  if (!e) return [];
  const done = ck.done || { dpWork: 0, searchMs: 0 };
  // Rechenzeit je Aufwandseinheit, aus der letzten Rechnung in diesem Browser gemessen
  const rate = e.work > 2e6 && e.ms > 3 ? e.ms / e.work : 5e-6;
  /** @type {{level: ExactLevel, ms: number}[]} */ const out = [];
  let lastWork = e.work, lastSearch = done.searchMs;
  for (const level of levels) {
    const w = planWork ? planWork(level) : Math.min(level.dpWork, e.fullWork);
    const moreDp = !!ck.approx && w > lastWork * 1.5;
    const moreSearch = !!ck.searchable && level.searchMs > lastSearch;
    if (!moreDp && !moreSearch) continue;
    out.push({ level, ms: (moreDp ? w * rate : 0) + (moreSearch ? level.searchMs : 0) });
    if (moreDp) lastWork = w;
    if (moreSearch) lastSearch = level.searchMs;
  }
  return out;
}
/**
 * Auswahl der Stufe mit erwarteter Dauer und Startknopf.
 * @param {{level: ExactLevel, ms: number}[]} opts @param {string} chosen gewählte Stufe @param {string} prefix "ck" oder "cc"
 * @returns {string}
 */
function exactControls(opts, chosen, prefix) {
  if (!opts.length) return "";
  const sel = opts.some((o) => o.level.key === chosen) ? chosen : opts[0].level.key;
  return ` <select class="lvl" id="${prefix}-level" aria-label="Genauigkeit der genauen Rechnung">${opts.map((o) => `<option value="${o.level.key}"${o.level.key === sel ? " selected" : ""}>${o.level.label} · ${durText(o.ms)}</option>`).join("")}</select>
    <button type="button" class="btn small" id="${prefix}-exact">Genau rechnen</button>`;
}
/** @param {any} ck Stand der Kartonprüfung @returns {{level: ExactLevel, ms: number}[]} Stufen, die noch etwas bringen */
function boxExactOptions(ck) {
  const c = state.carton;
  return exactOptions(ck, EXACT_LEVELS, c ? (level) => planDpWork(c, state.bin, level.dpWork).work : undefined);
}
let checkLevel = "1";
/** @param {ExactLevel | null} [level] null = schnelle Rechnung, sonst genaue Rechnung in dieser Stufe */
function startCheck(level = null) {
  const dims = readNums(["#ck-a", "#ck-b", "#ck-c"], "#ck-unit");
  if (!dims) { state.carton = null; state.check = null; renderResult(); showCheckView(); return; }
  saveDims("quader-karton", dims);
  state.carton = [...dims].sort((a, b) => b - a);
  const id = ++seq;
  const prev = level ? state.check : null;
  const opt = prev && level ? boxExactOptions(prev).find((o) => o.level === level) : null;
  const estMs = opt ? opt.ms : 0;
  state.check = prev ? { ...prev, id, mode: "exact", final: false, estMs, level } : { id, carton: state.carton, count: null, status: "run", pat: null, final: false, mode: "quick", estMs: 0, level: null };
  if (checkJob) checkJob.stop();
  const msg = { type: "check", id, carton: state.carton, bin: state.bin, budget: level ? level.searchMs : 0, dpWork: level ? level.dpWork : DP_QUICK_WORK };
  const local = () => {
    if (!state.check || state.check.id !== id) return;
    // ohne Hintergrundrechnung blockiert die Seite, deshalb hier nur wenig Aufwand
    const a = analyzeCarton(msg.carton, msg.bin, level ? 1500 : 0, undefined, { dpWork: Math.min(msg.dpWork, 3e8) });
    onCheckMsg({ type: "check", id, phase: "final", count: a.count, upper: a.upper, status: a.status, pat: a.pattern ? patternString(a.pattern) : null, mixed: a.mixed, approx: a.approx, searchable: a.searchable, effort: a.effort });
  };
  const timeout = () => {
    if (!state.check || state.check.id !== id) return;
    state.check.final = true;
    renderResult();
  };
  checkJob = startJob(msg, onCheckMsg, local, (d) => d.phase === "final", level ? estMs * 4 + level.searchMs + 20000 : 15000, timeout);
  renderResult();
}
/** @param {any} d */
function onCheckMsg(d) {
  if (!state.check || d.id !== state.check.id) return;
  const ck = state.check;
  Object.assign(ck, { count: d.count, upper: d.upper, status: d.status, pat: d.pat, mixed: d.mixed, approx: d.approx, searchable: d.searchable, effort: d.effort, final: d.phase === "final" });
  if (ck.final) ck.done = ck.level ? { dpWork: ck.level.dpWork, searchMs: ck.level.searchMs } : { dpWork: 0, searchMs: 0 };
  renderResult();
  if (!state.view || state.view.kind === "check") showCheckView();
}
let ckTimer = 0;
$("#ck-form").addEventListener("input", (e) => {
  if ((/** @type {HTMLElement} */ (e.target)).id === "ck-unit") return;
  clearTimeout(ckTimer); ckTimer = window.setTimeout(() => startCheck(), 350);
});
$("#ck-form").addEventListener("submit", (e) => e.preventDefault());

/** Bestes bekanntes Ergebnis: eigener Löser oder Regelliste */
function bestForCarton() {
  const ck = state.check;
  if (!ck || !state.carton) return null;
  const list = state.rules.length ? lookup(state.carton) : { score: 0, rule: null };
  const nmax = state.rulesInfo ? state.rulesInfo.nmax : Infinity;
  const own = ck.count == null ? -1 : ck.count;
  const ownScore = Math.min(own, nmax);
  if (list.rule && list.score > ownScore) return { source: "list", count: list.rule.count, pat: list.rule.pat, rule: list.rule, list };
  return { source: "own", count: own, pat: ck.pat, rule: null, list };
}
function renderResult() {
  const el = $("#ck-result");
  const ck = state.check;
  if (!state.carton || !ck) { el.innerHTML = `<div class="r-count">–</div><div class="r-main">Bitte drei positive Maße bis 100 m eingeben.</div>`; return; }
  const best = bestForCarton();
  const nmax = state.rulesInfo ? state.rulesInfo.nmax : null;
  const opts = ck.final ? boxExactOptions(ck) : [];
  let chip;
  if (ck.count == null || !best) chip = `<span class="chip run">rechnet</span>`;
  else if (best.count >= ck.upper || (ck.final && ck.status === "optimal" && best.count >= ck.count)) chip = `<span class="chip ok">optimal, mehr passen nicht</span>`;
  else if (!ck.final) chip = ck.mode === "exact" ? `<span class="chip run">rechnet genau, ${durText(ck.estMs)}</span> <button type="button" class="btn small" id="ck-cancel">Abbrechen</button>` : `<span class="chip run">rechnet</span>`;
  else {
    const label = ck.approx ? "ungefähr: vereinfacht gerechnet" : ck.mode === "quick" && ck.searchable ? "ungefähr: schnelle Rechnung, nur Blockmuster" : ck.searchable || ck.mixed ? `offen: ${best.count + 1} nicht ausgeschlossen` : "bestes Blockmuster";
    chip = `<span class="chip open">${label} · höchstens ${ck.upper} möglich</span>${exactControls(opts, checkLevel, "ck")}`;
  }
  const count = best && best.count >= 0 ? best.count : "…";
  const parts = [];
  if (ck.final && ck.count != null && best && best.count < ck.upper && !opts.length && !ck.searchable) {
    parts.push(`<span>${ck.approx ? "Mehr Aufwand ist hier nicht möglich." : "Die Blockmuster sind vollständig gerechnet."} Verschränkte Muster sucht die Seite nur bis ${SEARCH_MAX_COUNT} Kartons; ob mehr als ${best.count} passen, bleibt offen.</span>`);
  }
  if (best && best.list && state.rules.length) {
    const L = best.list;
    if (best.source === "list") parts.push(`<span>Das Muster stammt aus der Regelliste. Der Einzellöser hat ${ck.count} gefunden.</span>`);
    else if (L.rule && ck.count != null && Math.min(ck.count, nmax || Infinity) > L.score) parts.push(`<span>Die Regelliste kennt hier nur ${L.score}. <button type="button" class="link" id="add-rule">Muster als Regel übernehmen</button></span>`);
    else if (L.rule) parts.push(`<span>Laut Regelliste ${L.score}${nmax && L.score >= nmax ? " oder mehr" : ""} · <button type="button" class="link" data-show-rule="${L.rule.id}">Regel ${L.rule.id + 1} anzeigen</button></span>`);
  }
  el.innerHTML = `<div class="r-count">${count}<small>${count === 1 ? "Karton" : "Kartons"}</small></div>
    <div class="r-main"><span>à <b>${dimsText(state.carton)}</b> ${U()} im Bin ${dimsText(state.bin)} ${U()}</span>${chip}</div>
    <div class="r-sub">${parts.join(" ") || "&nbsp;"}</div>`;
  if (state.rules.length) markHit();
}
$("#ck-result").addEventListener("change", (e) => {
  const t = /** @type {HTMLSelectElement} */ (e.target);
  if (t.id === "ck-level") checkLevel = t.value;
});
$("#ck-result").addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.id === "add-rule") addCheckAsRule();
  if (t.id === "ck-exact") {
    const sel = /** @type {HTMLSelectElement | null} */ (document.querySelector("#ck-level"));
    const level = EXACT_LEVELS.find((l) => l.key === (sel ? sel.value : checkLevel));
    if (level) { checkLevel = level.key; startCheck(level); }
  }
  if (t.id === "ck-cancel" && state.check) {
    if (checkJob) checkJob.stop();
    const done = state.check.done;
    state.check = { ...state.check, id: ++seq, final: true, mode: done && done.searchMs > 0 ? "exact" : "quick" };
    renderResult();
  }
  const sr = t.closest("[data-show-rule]");
  if (sr) showRule(+(/** @type {HTMLElement} */ (sr)).dataset.showRule);
});
function addCheckAsRule() {
  const ck = state.check;
  if (!ck || !ck.pat || !state.rulesInfo) return;
  const pat = parsePattern(ck.pat);
  const rule = patternRule(pat, state.bin);
  const nmax = state.rulesInfo.nmax;
  const r = { score: Math.min(rule.count, nmax), count: rule.count, cons: rule.cons, pat: ck.pat, src: "manual", example: exampleCarton(regionVertices(rule.cons)), id: state.rules.length };
  state.rules.push(r);
  state.rules.sort((a, b) => (b.score - a.score) || (vol(b.example) - vol(a.example)));
  state.rules.forEach((x, i) => { x.id = i; });
  saveRules(exportData());
  renderRuleStats(); renderFilter(); renderRuleList(); renderResult();
}

/* ---------- Packmuster-Ansicht ---------- */
function showCheckView() {
  const best = bestForCarton();
  if (!best || !best.pat || !state.carton) {
    state.view = { kind: "check", empty: true };
    renderViewer(); return;
  }
  const pattern = parsePattern(best.pat);
  state.view = {
    kind: "check", pattern, patStr: best.pat, carton: state.carton, count: patternCount(pattern),
    eyebrow: best.source === "list" ? `Dein Karton · Muster aus Regel ${best.rule ? best.rule.id + 1 : ""}` : "Dein Karton", note: ""
  };
  state.step = null;
  renderViewer();
}
/** @param {Pattern} pattern @param {string} patStr @param {string} eyebrow @param {string} kind */
function showPattern(pattern, patStr, eyebrow, kind) {
  const rule = patternRule(pattern, state.bin);
  let carton = state.carton, note = "";
  if (!carton || !consHold(rule.cons, carton, 1e-7)) {
    const ex = exampleCarton(regionVertices(rule.cons));
    if (!ex) { note = "Mit diesem Bin passt das Muster für keinen Karton."; carton = null; }
    else {
      if (carton) {
        const bad = rule.cons.filter((k) => dot(k.t, carton) > k.D + 1e-7).map((k) => `${termText(k.t)} ≤ ${len(k.D)}`);
        note = `Dein Karton ${dimsText(carton)} ${U()} passt nicht in dieses Muster (verletzt: ${bad.join(", ")}). Gezeigt mit dem größten passenden Karton ${dimsText(ex)} ${U()}.`;
      }
      carton = ex;
    }
  }
  state.view = { kind, pattern, patStr, carton, count: patternCount(pattern), eyebrow, note, rule };
  state.step = null;
  renderViewer();
  $("#viewer").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
/** @param {number} id */
function showRule(id) {
  const r = state.rules[id];
  if (!r) return;
  showPattern(parsePattern(r.pat), r.pat, `Regel ${id + 1} von ${state.rules.length}`, "rule");
}
$("#load-btn").addEventListener("click", () => {
  const err = $("#load-err");
  try {
    const txt = (/** @type {HTMLTextAreaElement} */ ($("#load-in"))).value;
    const pattern = parsePattern(txt);
    err.hidden = true;
    showPattern(pattern, patternString(pattern), "Geladenes Muster", "loaded");
  } catch (e) {
    err.textContent = (/** @type {Error} */ (e)).message; err.hidden = false;
  }
});
$("#v-back").addEventListener("click", () => { showCheckView(); });

const ORIENT = {
  flat: { one: "liegt flach", many: "liegen flach" },
  side: { one: "liegt hochkant", many: "liegen hochkant" },
  up: { one: "steht aufrecht", many: "stehen aufrecht" }
};
/** @param {{p: number[]}} q @returns {"flat" | "side" | "up"} */
const orient = (q) => (q.p[2] === 2 ? "flat" : q.p[2] === 1 ? "side" : "up");
/** @param {{p: number[], count?: number}[]} P Kartons oder Blöcke (count = Kartons im Block) @returns {string} */
function orientSummary(P) {
  /** @type {Record<string, number>} */ const cnt = { flat: 0, side: 0, up: 0 };
  P.forEach((p) => { cnt[orient(p)] += p.count || 1; });
  return ["flat", "side", "up"].filter((k) => cnt[k]).map((k) => `${cnt[k]} ${cnt[k] === 1 ? ORIENT[/** @type {"flat"} */ (k)].one : ORIENT[/** @type {"flat"} */ (k)].many}`).join(", ");
}
/** @param {Pattern} pat @returns {string} */
function patternKind(pat) {
  if (!patternHasDag(pat)) return "Blockmuster";
  if (pat.kind === "T" && pat.root.k === "S" && pat.root.c.every((k) => k.k === "B")) return "Lagenmuster";
  return "Freies Muster";
}
function renderViewer() {
  const v = state.view;
  const back = $("#v-back");
  back.hidden = !v || v.kind === "check" || !state.carton;
  if (!v || v.empty || !v.carton) {
    $("#v-eyebrow").textContent = "Packmuster";
    $("#v-title").innerHTML = v && v.note ? "Kein Karton passt" : "Noch kein Muster";
    $("#v-meta").textContent = v && v.note ? "" : "Sobald Maße eingegeben sind, erscheint hier das Muster.";
    $("#v-note").hidden = !(v && v.note); if (v && v.note) $("#v-note").textContent = v.note;
    $("#v-rule").textContent = "–"; $("#v-pat").textContent = "–";
    $("#v-svg").innerHTML = ""; $("#v-legend").innerHTML = ""; $("#v-list").innerHTML = ""; $("#v-stepper").hidden = true;
    return;
  }
  const rule = v.rule || patternRule(v.pattern, state.bin);
  // bei sehr vielen Kartons zeigt die Zeichnung Blöcke gleich gedrehter Kartons statt jeden einzeln
  const total = patternCount(v.pattern);
  const blocks = total > DRAW_MAX;
  /** @type {any[]} */ const boxes = (blocks ? layoutBlocks(v.pattern, v.carton) : patternLayout(v.pattern, v.carton)).sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));
  v.boxes = boxes; v.blocks = blocks;
  $("#v-eyebrow").textContent = v.eyebrow;
  $("#v-title").innerHTML = `${total} ${total === 1 ? "Karton" : "Kartons"} <span class="u">à ${dimsText(v.carton)} ${U()}</span>`;
  $("#v-meta").innerHTML = `<b>${patternKind(v.pattern)}</b> · ${orientSummary(boxes)}${blocks ? ` · Zeichnung zeigt ${boxes.length === 1 ? "einen Block" : boxes.length + " Blöcke"} statt einzelner Kartons` : ""}`;
  $("#v-note").hidden = !v.note; $("#v-note").textContent = v.note || "";
  $("#v-rule").textContent = ruleText(rule.cons, rule.count, U());
  $("#v-pat").textContent = v.patStr;
  const n = boxes.length;
  const step = state.step == null || state.step > n ? n : state.step;
  const si = /** @type {HTMLInputElement} */ ($("#step"));
  si.max = String(Math.max(1, n)); si.value = String(Math.max(1, step));
  $("#v-stepper").hidden = n < 2;
  $("#step-out").textContent = stepText(step, n, blocks);
  drawCurrent(step);
  const kinds = [...new Set(boxes.map(orient))];
  $("#v-legend").innerHTML = ["flat", "side", "up"].filter((k) => kinds.includes(/** @type {"flat"} */ (k)))
    .map((k) => `<span><i class="sw o-${k}"></i>${ORIENT[/** @type {"flat"} */ (k)].one}</span>`).join("");
  $("#v-list").innerHTML = boxListHtml(boxes, step, blocks);
}
/** @param {number} step @param {number} n @param {boolean} blocks @returns {string} */
function stepText(step, n, blocks) {
  return `${blocks ? "Block" : "Karton"} 1 bis ${step} von ${n}${step < n ? ", weitere ausgeblendet" : ""}`;
}
/**
 * Liste der Kartons oder Blöcke mit Positionen in der Anzeigeeinheit.
 * @param {any[]} boxes @param {number} step @param {boolean} blocks @returns {string}
 */
function boxListHtml(boxes, step, blocks) {
  if (boxes.length > 80) return "";
  return boxes.map((p, i) => `<li class="${i >= step ? "later" : ""}"><span class="num">${i + 1}</span><span>${blocks ? `${p.n.join(" × ")} = ${p.count}, ${ORIENT[orient(p)].many}, je ${len(p.dx / p.n[0])} × ${len(p.dy / p.n[1])} × ${len(p.dz / p.n[2])}` : ORIENT[orient(p)].one}</span>
    <span class="pos">L ${len(p.x)}–${len(p.x + p.dx)} · B ${len(p.y)}–${len(p.y + p.dy)} · H ${len(p.z)}–${len(p.z + p.dz)} ${U()}</span></li>`).join("");
}
/** @param {number} step */
function drawCurrent(step) {
  const v = state.view;
  const shown = v.boxes.length > DRAW_MAX ? [] : v.boxes.slice(0, step).map((/** @type {any} */ b, /** @type {number} */ i) => ({ ...b, num: v.blocks ? b.count : i + 1 }));
  $("#v-svg").innerHTML = drawSVG(state.bin, shown, `${patternCount(v.pattern)} Kartons im Bin`);
}
$("#step").addEventListener("input", (e) => {
  const v = state.view;
  if (!v || !v.boxes) return;
  state.step = +(/** @type {HTMLInputElement} */ (e.target)).value;
  const n = v.boxes.length;
  $("#step-out").textContent = stepText(state.step, n, !!v.blocks);
  document.querySelectorAll("#v-list li").forEach((li, i) => li.classList.toggle("later", i >= /** @type {number} */ (state.step)));
  drawCurrent(state.step);
});
document.addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("[data-copy]");
  if (!b) return;
  const src = document.getElementById(/** @type {string} */ ((/** @type {HTMLElement} */ (b)).dataset.copy));
  if (src) copyText(src.textContent || "", /** @type {HTMLElement} */ (b));
});
/** @param {string} text @param {HTMLElement} btn */
function copyText(text, btn) {
  const done = () => { const old = btn.textContent; btn.textContent = "Kopiert"; setTimeout(() => { btn.textContent = old; }, 1400); };
  const fallback = () => {
    const ta = /** @type {HTMLTextAreaElement} */ ($("#copy-area") || document.createElement("textarea"));
    ta.value = text; ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { btn.textContent = "Bitte manuell kopieren"; }
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
}

/* ---------- Zeichnung ---------- */
/** @param {any} a @param {any} b @returns {boolean} */
function projOverlap(a, b) {
  const e = 1e-6;
  const r = (/** @type {any} */ p) => [p.x - p.y - p.dy, p.x + p.dx - p.y, p.y - p.z - p.dz, p.y + p.dy - p.z, p.x - p.z - p.dz, p.x + p.dx - p.z];
  const A = r(a), B = r(b);
  for (let i = 0; i < 6; i += 2) if (A[i + 1] <= B[i] + e || B[i + 1] <= A[i] + e) return false;
  return true;
}
/** @param {any[]} items @returns {any[]} */
function depthOrder(items) {
  const n = items.length, e = 1e-6;
  const next = Array.from({ length: n }, () => /** @type {number[]} */ ([])), indeg = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = items[i], b = items[j];
    if (!projOverlap(a, b)) continue;
    let rel = 0;
    if (a.x + a.dx <= b.x + e) rel = -1; else if (b.x + b.dx <= a.x + e) rel = 1;
    else if (a.y + a.dy <= b.y + e) rel = -1; else if (b.y + b.dy <= a.y + e) rel = 1;
    else if (a.z + a.dz <= b.z + e) rel = -1; else if (b.z + b.dz <= a.z + e) rel = 1;
    if (rel === -1) { next[i].push(j); indeg[j]++; } else if (rel === 1) { next[j].push(i); indeg[i]++; }
  }
  const key = (/** @type {any} */ p) => p.x + p.y + p.z;
  const ready = [], out = [], used = new Array(n).fill(false);
  for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
  while (out.length < n) {
    if (!ready.length) { let best = -1; for (let i = 0; i < n; i++) if (!used[i] && (best < 0 || key(items[i]) < key(items[best]))) best = i; ready.push(best); }
    ready.sort((p, q) => key(items[q]) - key(items[p]));
    const i = /** @type {number} */ (ready.pop());
    if (used[i]) continue;
    used[i] = true; out.push(items[i]);
    for (const j of next[i]) if (--indeg[j] === 0 && !used[j]) ready.push(j);
  }
  return out;
}
/** In einer Richtung mit mehr Kartons zeichnet ein Block keine Trennlinien mehr (sie lägen zu dicht) */
const GRID_MAX = 400;
/**
 * Trennlinien zwischen den Kartons eines Blocks auf seinen drei sichtbaren Flächen. So sind
 * auch in der Blockansicht alle Kartons zu sehen, die außen liegen.
 * @param {number[]} n Kartons je Achse @param {number[]} b Block [x0, x1, y0, y1, z0, z1]
 * @param {(X: number, Y: number, Z: number) => number[]} P Projektion @returns {string}
 */
function blockGrid(n, b, P) {
  const [x0, x1, y0, y1, z0, z1] = b;
  /** @type {string[]} */ const d = [];
  /** @param {number[]} a @param {number[]} c */
  const seg = (a, c) => { const p = P(a[0], a[1], a[2]), q = P(c[0], c[1], c[2]); d.push(`M${p[0].toFixed(1)},${p[1].toFixed(1)}L${q[0].toFixed(1)},${q[1].toFixed(1)}`); };
  if (n[0] <= GRID_MAX) for (let i = 1; i < n[0]; i++) { const x = x0 + (x1 - x0) * i / n[0]; seg([x, y0, z1], [x, y1, z1]); seg([x, y1, z0], [x, y1, z1]); }
  if (n[1] <= GRID_MAX) for (let j = 1; j < n[1]; j++) { const y = y0 + (y1 - y0) * j / n[1]; seg([x0, y, z1], [x1, y, z1]); seg([x1, y, z0], [x1, y, z1]); }
  if (n[2] <= GRID_MAX) for (let k = 1; k < n[2]; k++) { const z = z0 + (z1 - z0) * k / n[2]; seg([x1, y0, z], [x1, y1, z]); seg([x0, y1, z], [x1, y1, z]); }
  return d.length ? `<path class="grid" d="${d.join("")}"/>` : "";
}

/* ---------- Großansicht mit Zoom ---------- */
const zoom = { x: 0, y: 0, w: 1, h: 1, base: [0, 0, 1, 1], drag: /** @type {{px: number, py: number, x: number, y: number} | null} */ (null) };
/** @returns {SVGSVGElement | null} */
const zoomSvg = () => /** @type {SVGSVGElement | null} */ (document.querySelector("#zoom-box svg"));
function zoomApply() {
  const svg = zoomSvg();
  if (svg) svg.setAttribute("viewBox", `${zoom.x} ${zoom.y} ${zoom.w} ${zoom.h}`);
}
/**
 * Vergrößert oder verkleinert um einen Punkt (Anteile 0 … 1 der Ansicht).
 * @param {number} f Faktor (kleiner als 1 = näher heran) @param {number} [fx] @param {number} [fy]
 */
function zoomBy(f, fx = 0.5, fy = 0.5) {
  const w = Math.min(zoom.base[2] * 1.2, Math.max(zoom.base[2] / 200, zoom.w * f)), k = w / zoom.w;
  zoom.x += (zoom.w - w) * fx; zoom.y += (zoom.h - zoom.h * k) * fy;
  zoom.w = w; zoom.h *= k;
  zoomApply();
}
/** @param {string} srcId Zeichnung, die groß gezeigt wird @param {string} title */
function openZoom(srcId, title) {
  const src = document.querySelector(`#${srcId} svg`);
  if (!src) return;
  $("#zoom-title").textContent = title;
  $("#zoom-box").innerHTML = src.outerHTML;
  const vb = (src.getAttribute("viewBox") || "0 0 1 1").split(/\s+/).map(Number);
  zoom.base = vb; [zoom.x, zoom.y, zoom.w, zoom.h] = vb;
  (/** @type {HTMLDialogElement} */ ($("#zoom-dlg"))).showModal();
}
document.addEventListener("click", (e) => {
  const b = /** @type {HTMLElement | null} */ ((/** @type {HTMLElement} */ (e.target)).closest("[data-zoom]"));
  if (b) openZoom(/** @type {string} */ (b.dataset.zoom), b.dataset.zoomTitle || "Packmuster");
});
$("#zoom-in").addEventListener("click", () => zoomBy(0.7));
$("#zoom-out").addEventListener("click", () => zoomBy(1 / 0.7));
$("#zoom-reset").addEventListener("click", () => { [zoom.x, zoom.y, zoom.w, zoom.h] = zoom.base; zoomApply(); });
$("#zoom-close").addEventListener("click", () => (/** @type {HTMLDialogElement} */ ($("#zoom-dlg"))).close());
$("#zoom-box").addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = $("#zoom-box").getBoundingClientRect();
  zoomBy(e.deltaY < 0 ? 0.85 : 1 / 0.85, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
}, { passive: false });
$("#zoom-box").addEventListener("pointerdown", (e) => { zoom.drag = { px: e.clientX, py: e.clientY, x: zoom.x, y: zoom.y }; $("#zoom-box").setPointerCapture(e.pointerId); });
$("#zoom-box").addEventListener("pointermove", (e) => {
  if (!zoom.drag) return;
  const r = $("#zoom-box").getBoundingClientRect();
  // die Zeichnung füllt den Kasten so weit, wie ihr Seitenverhältnis erlaubt
  const scale = Math.max(zoom.w / r.width, zoom.h / r.height);
  zoom.x = zoom.drag.x - (e.clientX - zoom.drag.px) * scale; zoom.y = zoom.drag.y - (e.clientY - zoom.drag.py) * scale;
  zoomApply();
});
for (const ev of ["pointerup", "pointercancel"]) $("#zoom-box").addEventListener(ev, () => { zoom.drag = null; });

/**
 * Zeichnet den Bin mit Kartons. Mit cone wird der Bin konisch gezeichnet:
 * bin ist dann die Öffnung oben mit Gesamthöhe, cone der Boden und die Höhe des konischen Teils.
 * @param {number[]} bin @param {any[]} boxes @param {string} label
 * @param {{botL: number, botW: number, coneH: number}} [cone]
 * @returns {string}
 */
function drawSVG(bin, boxes, label, cone) {
  const [L, W, H] = bin;
  const ix = cone ? (L - cone.botL) / 2 : 0, iy = cone ? (W - cone.botW) / 2 : 0, hc = cone ? Math.min(cone.coneH, H) : 0;
  const c30 = Math.cos(Math.PI / 6);
  const P = (/** @type {number} */ X, /** @type {number} */ Y, /** @type {number} */ Z) => [(X - Y) * c30, (X + Y) * 0.5 - Z];
  const pts = (/** @type {number[][]} */ arr) => arr.map((p) => P(p[0], p[1], p[2]).map((v) => v.toFixed(1)).join(",")).join(" ");
  const corners = [[0,0,0],[L,0,0],[0,W,0],[L,W,0],[0,0,H],[L,0,H],[0,W,H],[L,W,H]].map((p) => P(p[0], p[1], p[2]));
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const pad = Math.max(L, W, H) * 0.2;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad * 0.75, minY = Math.min(...ys) - pad * 0.1, maxY = Math.max(...ys) + pad * 0.4;
  const fs = Math.max(L, W, H) / 25;
  let s = `<svg viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}">`;
  s += `<polygon class="b-floor" points="${pts([[ix,iy,0],[L-ix,iy,0],[L-ix,W-iy,0],[ix,W-iy,0]])}"/>`;
  s += `<polygon class="b-wall" points="${pts([[ix,iy,0],[ix,W-iy,0],[0,W,hc],[0,W,H],[0,0,H],[0,0,hc]])}"/>`;
  s += `<polygon class="b-wall" points="${pts([[ix,iy,0],[L-ix,iy,0],[L,0,hc],[L,0,H],[0,0,H],[0,0,hc]])}"/>`;
  if (cone && hc < H) s += `<polyline class="b-edge" points="${pts([[0,W,hc],[0,0,hc],[L,0,hc]])}"/>`;
  const showNum = boxes.length <= 60;
  for (const it of depthOrder(boxes)) {
    const g = Math.min(4, 0.06 * Math.min(it.dx, it.dy, it.dz));
    const x0 = it.x + g, x1 = it.x + it.dx - g, y0 = it.y + g, y1 = it.y + it.dy - g, z0 = it.z, z1 = it.z + it.dz - g;
    const top = [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const right = [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]];
    const left = [[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]];
    s += `<g class="box o-${orient(it)}"><polygon class="r" points="${pts(right)}"/><polygon class="l" points="${pts(left)}"/><polygon class="t" points="${pts(top)}"/>`;
    const w = x1 - x0, d = y1 - y0;
    if (w > 30 && d > 30 && !(it.count > 1)) {
      if (w >= d) { const t = Math.min(d * 0.14, 16), ym = (y0 + y1) / 2; s += `<polygon class="tape" points="${pts([[x0,ym - t/2,z1],[x1,ym - t/2,z1],[x1,ym + t/2,z1],[x0,ym + t/2,z1]])}"/>`; }
      else { const t = Math.min(w * 0.14, 16), xm = (x0 + x1) / 2; s += `<polygon class="tape" points="${pts([[xm - t/2,y0,z1],[xm + t/2,y0,z1],[xm + t/2,y1,z1],[xm - t/2,y1,z1]])}"/>`; }
    }
    if (it.count > 1 && it.n) s += blockGrid(it.n, [x0, x1, y0, y1, z0, z1], P);
    if (showNum) { const c = P((x0 + x1) / 2, (y0 + y1) / 2, z1); s += `<text x="${c[0].toFixed(1)}" y="${(c[1] + fs * 0.35).toFixed(1)}" text-anchor="middle" style="font-size:${fs.toFixed(0)}px">${it.num}</text>`; }
    s += `</g>`;
  }
  const edges = [[[L-ix,iy,0],[L-ix,W-iy,0]],[[ix,W-iy,0],[L-ix,W-iy,0]],[[L-ix,W-iy,0],[L,W,hc]],[[L-ix,iy,0],[L,0,hc]],[[ix,W-iy,0],[0,W,hc]],
    [[L,W,hc],[L,W,H]],[[L,0,hc],[L,0,H]],[[0,W,hc],[0,W,H]],[[L,0,H],[L,W,H]],[[0,W,H],[L,W,H]]];
  if (cone && hc < H) edges.push([[L,0,hc],[L,W,hc]], [[0,W,hc],[L,W,hc]]);
  for (const [a, b] of edges) {
    const pa = P(a[0], a[1], a[2]), pb = P(b[0], b[1], b[2]);
    s += `<line class="b-edge" x1="${pa[0].toFixed(1)}" y1="${pa[1].toFixed(1)}" x2="${pb[0].toFixed(1)}" y2="${pb[1].toFixed(1)}"/>`;
  }
  const mL = P(L / 2, W, 0), mW = P(L, W / 2, 0), mH = P(0, W, H / 2);
  const st = `style="font-size:${(fs * 0.95).toFixed(0)}px"`;
  s += `<text class="lbl" ${st} x="${(mL[0] - fs).toFixed(1)}" y="${(mL[1] + fs * 1.8).toFixed(1)}" text-anchor="middle">L ${len(L)}${cone ? " · unten " + len(cone.botL) : ""} ${U()}</text>`;
  s += `<text class="lbl" ${st} x="${(mW[0] + fs).toFixed(1)}" y="${(mW[1] + fs * 1.8).toFixed(1)}" text-anchor="middle">B ${len(W)}${cone ? " · unten " + len(cone.botW) : ""} ${U()}</text>`;
  s += `<text class="lbl" ${st} x="${(mH[0] - fs * 0.7).toFixed(1)}" y="${(mH[1] + fs * 0.35).toFixed(1)}" text-anchor="end">H ${len(H)} ${U()}</text>`;
  return s + "</svg>";
}

/* ---------- Regeln erzeugen ---------- */
let genWorker = /** @type {Worker | null} */ (null);
let genId = 0;
/**
 * Stellt das Raster passend zur Bin-Größe vor: 1 mm bis 2 m, darüber 1 cm.
 * @param {string} selId Auswahlfeld @param {number} maxDim größtes Bin-Maß in mm
 */
function setAutoRes(selId, maxDim) { (/** @type {HTMLSelectElement} */ ($(selId))).value = maxDim > 2000 ? "10" : "1"; }
/** @returns {{nmax: number, quality: "fast"|"std"|"full", res: number} | null} Einstellungen der Regelerzeugung */
function genSettings() {
  const nmax = Math.round(+(/** @type {HTMLInputElement} */ ($("#g-nmax"))).value);
  if (!(nmax >= 2 && nmax <= NMAX_LIMIT)) return null;
  return { nmax, quality: /** @type {"fast"|"std"|"full"} */ ((/** @type {HTMLSelectElement} */ ($("#g-quality"))).value), res: +(/** @type {HTMLSelectElement} */ ($("#g-res"))).value || 1 };
}
/**
 * Schätzt im Hintergrund, wie lange eine Regelerzeugung dauert, und zeigt das Ergebnis an.
 * @param {object} msg Auftrag an den Worker (type "genest" oder "conegenest")
 * @param {string} outId Ziel der Anzeige (mit #) @param {{w: Worker | null, t: number, ms: number}} slot merkt Worker, Timer und letzte Schätzung
 */
function estimateGen(msg, outId, slot) {
  clearTimeout(slot.t);
  if (slot.w) { slot.w.terminate(); slot.w = null; }
  slot.ms = 0;
  $(outId).textContent = "Erwartete Dauer wird geschätzt …";
  slot.t = window.setTimeout(() => {
    const w = makeWorker((d) => {
      if (d.type !== "genest") return;
      w && w.terminate(); slot.w = null;
      slot.ms = d.ms;
      $(outId).textContent = `Erwartete Dauer: ${durText(d.ms)} (grobe Schätzung für diesen Rechner, kann um den Faktor 2 abweichen).`;
    }, () => { slot.w = null; $(outId).textContent = ""; });
    slot.w = w;
    if (w) w.postMessage(msg); else $(outId).textContent = "";
  }, 300);
}
const genEst = { w: /** @type {Worker | null} */ (null), t: 0, ms: 0 };
function requestGenEstimate() {
  const g = genSettings();
  if (!g) { $("#g-est").textContent = ""; return; }
  estimateGen({ type: "genest", cone: false, bin: state.bin, quality: g.quality, nmax: g.nmax, res: g.res }, "#g-est", genEst);
}
for (const id of ["#g-nmax", "#g-quality", "#g-res"]) $(id).addEventListener("change", requestGenEstimate);
function stopGen() {
  if (genWorker) { genWorker.terminate(); genWorker = null; }
  $("#g-progress").hidden = true; $("#g-stop").hidden = true;
  (/** @type {HTMLButtonElement} */ ($("#g-start"))).disabled = false;
}
$("#g-stop").addEventListener("click", () => { stopGen(); $("#g-source").textContent = "Berechnung abgebrochen."; if (state.rules.length) loadRulesForBin(); });
$("#g-start").addEventListener("click", () => {
  const g = genSettings();
  if (!g) { $("#g-source").textContent = `Die Höchstanzahl muss zwischen 2 und ${NMAX_LIMIT} liegen.`; return; }
  stopGen();
  genId = ++seq;
  // Zeitlimit: mindestens das der Voreinstellung, bei großen Bins das Vierfache der Schätzung
  const opt = genOptions(g.quality, g.nmax, g.res, Math.max(QUALITY[g.quality].maxMs, 4 * genEst.ms));
  genWorker = makeWorker(onGenMsg, () => { stopGen(); $("#g-source").textContent = "Die Hintergrundberechnung konnte nicht starten. Öffne die Seite über einen Webserver statt als Datei."; });
  if (!genWorker) { $("#g-source").textContent = "Dieser Browser erlaubt keine Hintergrundberechnung. Die Regeln lassen sich hier leider nicht erzeugen."; return; }
  genWorker.postMessage({ type: "gen", id: genId, bin: state.bin, opt, quality: g.quality });
  $("#g-progress").hidden = false; $("#g-stop").hidden = false;
  (/** @type {HTMLButtonElement} */ ($("#g-start"))).disabled = true;
  $("#g-status").textContent = "Startet …"; $("#g-bar").style.width = "0%";
});
/**
 * Fortschritt einer Regelerzeugung als Anteil und Text.
 * @param {any} p Meldung des Rechenkerns @param {number} res Raster in mm @returns {{frac: number, text: string}}
 */
function genProgress(p, res) {
  const passes = p.passes || 1;
  let frac = 0, text = "";
  if (p.phase === "grid") { frac = ((p.pass - 1) + p.done / p.total) / passes; text = `Raster ${len(p.step)} ${U()}: Linie ${p.done} von ${p.total}`; }
  else if (p.phase === "random") { frac = ((p.pass - 1) + Math.min(1, p.sinceNew / p.patience)) / passes; text = `Zufällige Linien: ${p.done}, seit der letzten neuen Regel ${p.sinceNew} von ${p.patience}`; }
  else if (p.phase === "prune") { frac = 0.97; text = `Räume ${p.rules} Kandidaten auf …`; }
  else if (p.phase === "sweep") { frac = 0.99; text = `Prüfe ${p.rules} Regeln auf dem Raster ${resText(res)} …`; }
  if (p.maxMs) frac = Math.max(frac, Math.min(0.96, p.elapsed / p.maxMs));
  return { frac, text: `${text} · ${p.rules} Regeln bisher · ${durText(p.elapsed).replace("etwa ", "")}` };
}
/** @param {any} d */
function onGenMsg(d) {
  if (d.id !== genId) return;
  if (d.type === "progress") {
    const g = genSettings();
    const pr = genProgress(d.p, g ? g.res : 1);
    $("#g-bar").style.width = (pr.frac * 100).toFixed(1) + "%";
    $("#g-status").textContent = pr.text;
  } else if (d.type === "gen") {
    genWorker && genWorker.terminate(); genWorker = null;
    $("#g-progress").hidden = true; $("#g-stop").hidden = true;
    (/** @type {HTMLButtonElement} */ ($("#g-start"))).disabled = false;
    const data = /** @type {RulesData} */ (d.data);
    if (binKey(data.bin) !== binKey(state.bin)) return;
    const saved = saveRules(data);
    setRules(data, "new");
    if (!saved) $("#g-source").textContent += " Die Liste ließ sich in diesem Browser nicht speichern; nach dem Neuladen ist sie weg. Sichere sie mit „Als Textdatei speichern“.";
  }
}
/** @returns {RulesData} */
function exportData() {
  return { bin: state.bin, nmax: state.rulesInfo.nmax, quality: state.rulesInfo.quality, res: state.rulesInfo.res, meta: state.rulesInfo.meta, stats: state.rulesInfo.stats,
    rules: state.rules.map((r) => /** @type {[number, number, number[], string, string]} */ ([r.score, r.count, r.cons.flatMap((k) => [k.t[0], k.t[1], k.t[2], k.ax]), r.pat, r.src])) };
}

/* ---------- Regelliste anzeigen ---------- */
function renderRuleStats() {
  const R = state.rules, info = state.rulesInfo;
  const nmax = info.nmax;
  /** @type {Record<string, number>} */ const kinds = { dp: 0, grid: 0, search: 0, manual: 0 };
  R.forEach((r) => { kinds[r.src] = (kinds[r.src] || 0) + 1; });
  $("#r-stats").innerHTML = `<span><b>${R.length}</b> Regeln</span><span><b>${kinds.grid + kinds.dp}</b> Gitter- und Blockmuster</span><span><b>${kinds.search}</b> verschränkte Muster</span>${kinds.manual ? `<span><b>${kinds.manual}</b> selbst übernommen</span>` : ""}<span>„then ${nmax}“ heißt ${nmax} oder mehr</span>`;
  /** @type {number[]} */ const per = new Array(nmax + 1).fill(0);
  R.forEach((r) => per[r.score]++);
  const mx = Math.max(1, ...per);
  $("#r-hist").innerHTML = per.slice(1).map((c, i) => `<button type="button" data-n="${i + 1}" class="${state.filter === String(i + 1) ? "on" : ""}" title="${i + 1} Kartons: ${c} Regeln" aria-label="${i + 1} Kartons, ${c} Regeln"><i style="height:${(c / mx * 100).toFixed(0)}%"></i></button>`).join("");
  $("#r-hist-axis").innerHTML = `<span>1</span><span>Anzahl Kartons</span><span>${nmax}</span>`;
}
$("#r-hist").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!b) return;
  state.filter = state.filter === b.dataset.n ? "all" : /** @type {string} */ (b.dataset.n);
  (/** @type {HTMLSelectElement} */ ($("#r-filter"))).value = state.filter;
  renderRuleStats(); renderRuleList();
});
function renderFilter() {
  const nmax = state.rulesInfo.nmax;
  const opts = [`<option value="all">Alle</option>`];
  for (let n = nmax; n >= 1; n--) { const c = state.rules.filter((r) => r.score === n).length; if (c) opts.push(`<option value="${n}">${n}${n === nmax ? " oder mehr" : ""} (${c})</option>`); }
  $("#r-filter").innerHTML = opts.join("");
  (/** @type {HTMLSelectElement} */ ($("#r-filter"))).value = state.filter;
}
$("#r-filter").addEventListener("change", (e) => { state.filter = (/** @type {HTMLSelectElement} */ (e.target)).value; renderRuleStats(); renderRuleList(); });
function renderRuleList() {
  const nmax = state.rulesInfo.nmax;
  const hit = state.carton ? lookup(state.carton).rule : null;
  const rows = [];
  let cur = -1, shown = 0, total = 0;
  for (const r of state.rules) {
    if (state.filter !== "all" && String(r.score) !== state.filter) continue;
    total++;
    if (shown >= RULE_ROWS_MAX) continue;
    shown++;
    if (r.score !== cur) {
      cur = r.score;
      const c = state.rules.filter((x) => x.score === cur).length;
      rows.push(`<tr class="grp"><th colspan="4">${cur}${cur === nmax ? " oder mehr" : ""} ${cur === 1 ? "Karton" : "Kartons"}<span>${c} ${c === 1 ? "Regel" : "Regeln"}</span></th></tr>`);
    }
    const kind = r.src === "search" ? `<span class="tag">verschränkt</span> ` : "";
    rows.push(`<tr class="${hit === r ? "hit" : ""}"><td class="rule">${esc(ruleText(r.cons, r.score, U()))}</td><td class="ex">${r.example ? dimsText(r.example) : "–"}</td><td class="pat">${kind}<span title="${esc(r.pat)}">${esc(r.pat)}</span></td><td><button type="button" class="btn small" data-show-rule="${r.id}">Zeigen</button></td></tr>`);
  }
  $("#r-list").innerHTML = rows.join("") + moreRowsHtml(shown, total);
}
$("#r-list").addEventListener("click", (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest("[data-show-rule]");
  if (b) showRule(+(/** @type {HTMLElement} */ (b)).dataset.showRule);
});
/** @param {boolean} withPat @returns {string} */
function exportText(withPat) { return rulesToText(state.bin, state.rulesInfo.nmax, state.rules, withPat, U()); }
$("#r-copy-all").addEventListener("click", (e) => copyText(exportText(true), /** @type {HTMLElement} */ (e.currentTarget)));
$("#r-copy-rules").addEventListener("click", (e) => copyText(exportText(false), /** @type {HTMLElement} */ (e.currentTarget)));
$("#r-download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([exportText(true)], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `regeln_${binKey(state.bin)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* Markierung der Regel, die für den aktuellen Karton gilt */
function markHit() {
  const hit = state.carton ? lookup(state.carton).rule : null;
  document.querySelectorAll("#r-list tr.hit").forEach((tr) => tr.classList.remove("hit"));
  if (!hit) return;
  const btn = document.querySelector(`#r-list [data-show-rule="${hit.id}"]`);
  if (btn) { const tr = btn.closest("tr"); if (tr) tr.classList.add("hit"); }
}

/* ---------- Reiter ---------- */
/** @type {Record<string, () => void>} wird beim ersten Öffnen eines Reiters aufgerufen */
const tabInit = {};
/** @param {string} name "box" oder "cone" */
function showTab(name) {
  for (const t of ["box", "cone"]) {
    $("#tab-" + t).hidden = t !== name;
    $("#tabbtn-" + t).setAttribute("aria-selected", String(t === name));
  }
  if (tabInit[name]) { const f = tabInit[name]; delete tabInit[name]; f(); }
  try { history.replaceState(null, "", name === "cone" ? "#konisch" : "#quader"); } catch (e) { /* ohne Verlauf */ }
  try { localStorage.setItem("kartonregeln:reiter", name); } catch (e) { /* Speicher nicht verfügbar */ }
}
document.querySelectorAll(".tabbar [role=tab]").forEach((b) => b.addEventListener("click", () => showTab(/** @type {HTMLElement} */ (b).dataset.tab || "box")));

document.querySelectorAll(".disp-switch button").forEach((b) => b.addEventListener("click", () => setDisplayUnit(/** @type {Unit} */ ((/** @type {HTMLElement} */ (b)).dataset.disp || "mm"))));
rerenderHooks.push(() => {
  renderSource();
  renderResult();
  if (state.view) renderViewer();
  if (state.rules.length) renderRuleList();
});

(function init() {
  if (location.protocol === "file:") $("#file-note").hidden = false;
  bindUnitSelect("#bin-unit", ["#bin-l", "#bin-b", "#bin-h"]);
  bindUnitSelect("#ck-unit", ["#ck-a", "#ck-b", "#ck-c"]);
  const savedBin = restoreDims("quader-bin", ["#bin-l", "#bin-b", "#bin-h"], "#bin-unit");
  if (savedBin) state.bin = savedBin;
  restoreDims("quader-karton", ["#ck-a", "#ck-b", "#ck-c"], "#ck-unit");
  rerenderAll();
  setAutoRes("#g-res", Math.max(...state.bin));
  loadRulesForBin();
  startCheck();
  requestGenEstimate();
  let tab = "";
  try { tab = location.hash === "#konisch" ? "cone" : location.hash === "#quader" ? "box" : (localStorage.getItem("kartonregeln:reiter") || ""); } catch (e) { tab = ""; }
  window.addEventListener("DOMContentLoaded", () => { if (tab === "cone") showTab("cone"); });
})();
