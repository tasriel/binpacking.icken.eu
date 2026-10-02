"use strict";
/*
 * cone-app.js: Bedienung des Reiters „Konischer Bin“.
 * Nutzt die Helfer aus app.js ($, fmt, dimsText, readNums, startJob, copyText,
 * drawSVG, ORIENT, orient, orientSummary) und den Rechenkern cone.js.
 */

/**
 * @typedef {{kind: "check" | "loaded", carton: number[], placements: ConePlacement[], eyebrow: string,
 *   note: string, boxes?: ConePlacement[]}} ConeView
 */

const coneState = {
  bin: /** @type {ConeBin} */ ({ ...CONE_DEFAULT }),
  carton: /** @type {number[] | null} */ (null),
  check: /** @type {{id: number, result: ConeAnalysis | null, mode: "quick" | "exact"} | null} */ (null),
  view: /** @type {ConeView | null} */ (null),
  step: /** @type {number | null} */ (null)
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
function renderConeFacts() {
  const b = coneState.bin;
  const pct = (/** @type {number} */ d) => (b.coneH > 0 ? fmt(Math.atan(d / b.coneH) * 180 / Math.PI) : "0");
  const dl = (b.topL - b.botL) / 2, dw = (b.topW - b.botW) / 2;
  $("#cb-facts").innerHTML = `<span>Gesamthöhe <b>${fmt(coneHeight(b))} mm</b></span>
    <span>Wand je Seite um <b>${fmt(dl)} mm</b> (Länge, ${pct(dl)}°) und <b>${fmt(dw)} mm</b> (Breite, ${pct(dw)}°) geneigt</span>
    <span>Volumen <b>${fmt(coneVolume(b) / 1e6)} l</b></span>`;
}
let coneBinTimer = 0;
$("#cb-form").addEventListener("input", () => {
  clearTimeout(coneBinTimer);
  coneBinTimer = window.setTimeout(() => {
    const b = readConeBin();
    if (!b) return;
    coneState.bin = b;
    try { localStorage.setItem(CONE_STORE, JSON.stringify(b)); } catch (e) { /* Speicher nicht verfügbar */ }
    coneState.view = null;
    renderConeFacts();
    startConeCheck();
  }, 400);
});
$("#cb-form").addEventListener("submit", (e) => e.preventDefault());
$("#cb-reset").addEventListener("click", () => {
  coneState.bin = { ...CONE_DEFAULT };
  writeConeBin(coneState.bin);
  try { localStorage.removeItem(CONE_STORE); } catch (e) { /* Speicher nicht verfügbar */ }
  $("#cb-err").hidden = true;
  coneState.view = null;
  renderConeFacts();
  startConeCheck();
});

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
    onConeMsg({ type: "cone", id, result: analyzeCone(msg.carton, msg.bin, exact ? 1500 : 0) });
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
  if (t.id === "cc-cancel" && coneState.check && coneState.check.result) {
    if (coneJob) coneJob.stop();
    coneState.check = { id: ++coneSeq, result: { ...coneState.check.result, final: true }, mode: "quick" };
    renderConeResult();
  }
});
$("#cc-form").addEventListener("submit", (e) => e.preventDefault());

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
  if (!r) { el.innerHTML = `<div class="r-count">…<small>Kartons</small></div><div class="r-main"><span>${where}</span><span class="chip run">rechnet</span></div><div class="r-sub">&nbsp;</div>`; return; }
  let chip;
  if (r.status === "optimal") chip = `<span class="chip ok">optimal, mehr passen nicht</span>`;
  else if (r.status === "searched") chip = `<span class="chip ok">vollständig durchsucht, mehr passen nicht</span>`;
  else if (!r.final) chip = ck.mode === "exact" ? `<span class="chip run">rechnet genau</span> <button type="button" class="btn small" id="cc-cancel">Abbrechen</button>` : `<span class="chip run">rechnet</span>`;
  else if (ck.mode === "quick") chip = `<span class="chip open">schnelle Rechnung, mehr ist möglich</span> <button type="button" class="btn small" id="cc-exact">Genau rechnen</button>`;
  else chip = `<span class="chip open">offen: ${r.count + 1} nicht ausgeschlossen</span>`;
  const parts = [];
  if (r.count > 0) {
    parts.push(`<span>Ebenen: ${coneLevels(r.placements)}</span>`);
    const sup = coneMinSupport(r.placements);
    if (sup < 0.995) parts.push(`<span>kleinste Auflage ${Math.round(sup * 100)} %</span>`);
    if (r.topCuboid > 0) parts.push(`<span>Zum Vergleich, gerader Bin: mit Bodenmaß ${r.bottomCuboid}, mit Öffnungsmaß ${r.topCuboid}</span>`);
  } else parts.push(`<span>Der Karton passt in keiner Lage in den Bin.</span>`);
  el.innerHTML = `<div class="r-count">${r.count}<small>${r.count === 1 ? "Karton" : "Kartons"}</small></div>
    <div class="r-main"><span>${where} (${fmt(b.botL)} × ${fmt(b.botW)} unten, ${fmt(b.topL)} × ${fmt(b.topW)} oben, ${fmt(coneHeight(b))} hoch)</span>${chip}</div>
    <div class="r-sub">${parts.join("")}</div>`;
}

/* ---------- Packmuster-Ansicht ---------- */
function showConeCheck() {
  const ck = coneState.check;
  if (!ck || !ck.result || !coneState.carton || !ck.result.count) {
    coneState.view = null;
    renderConeViewer();
    return;
  }
  const r = ck.result;
  coneState.view = { kind: "check", carton: r.carton, placements: r.placements, eyebrow: "Dein Karton", note: "" };
  coneState.step = null;
  renderConeViewer();
}
$("#cc-load-btn").addEventListener("click", () => {
  const err = $("#cc-load-err");
  try {
    const parsed = parseCone((/** @type {HTMLTextAreaElement} */ ($("#cc-load-in"))).value);
    err.hidden = true;
    const problems = coneCheck(coneState.bin, [...parsed.placements].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x)));
    const note = problems.length
      ? `Dieses Muster passt nicht zu den eingestellten Bin-Maßen: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` und ${problems.length - 3} weitere Probleme.` : ""}`
      : "";
    coneState.view = { kind: "loaded", carton: parsed.carton, placements: parsed.placements, eyebrow: "Geladenes Muster", note };
    coneState.step = null;
    renderConeViewer();
    $("#cc-viewer").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } catch (e) {
    err.textContent = (/** @type {Error} */ (e)).message; err.hidden = false;
  }
});
$("#cv-back").addEventListener("click", () => showConeCheck());

function renderConeViewer() {
  const v = coneState.view;
  $("#cv-back").hidden = !v || v.kind === "check";
  if (!v) {
    $("#cv-eyebrow").textContent = "Packmuster";
    $("#cv-title").textContent = "Noch kein Muster";
    $("#cv-meta").textContent = "Sobald Maße eingegeben sind und mindestens ein Karton passt, erscheint hier das Muster.";
    $("#cv-note").hidden = true;
    $("#cv-pat").textContent = "–";
    $("#cv-svg").innerHTML = drawConeSVG([]);
    $("#cv-legend").innerHTML = ""; $("#cv-list").innerHTML = ""; $("#cv-stepper").hidden = true;
    return;
  }
  const boxes = [...v.placements].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));
  v.boxes = boxes;
  const n = boxes.length;
  $("#cv-eyebrow").textContent = v.eyebrow;
  $("#cv-title").innerHTML = `${n} ${n === 1 ? "Karton" : "Kartons"} <span class="u">à ${dimsText(v.carton)} mm</span>`;
  $("#cv-meta").innerHTML = `${orientSummary(boxes)} · Ebenen: ${coneLevels(boxes)}`;
  $("#cv-note").hidden = !v.note; $("#cv-note").textContent = v.note;
  $("#cv-pat").textContent = n <= 5000 ? coneString(v.carton, boxes) : "Zu viele Kartons für die Textform.";
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

/* ---------- Start: beim ersten Öffnen des Reiters ---------- */
tabInit.cone = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONE_STORE) || "null");
    if (saved && !coneBinError(saved)) { coneState.bin = saved; writeConeBin(saved); }
  } catch (e) { /* Speicher nicht verfügbar */ }
  renderConeFacts();
  renderConeViewer();
  startConeCheck();
};
