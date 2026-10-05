"use strict";
/*
 * cone.js
 * Gleiche Kartons in einem konischen Bin (unten schmaler als oben, oben ein gerader Rand).
 * Braucht packcore.js (im Browser und im Worker vorher geladen, in Node per require).
 *
 * Geometrie (alle Maße innen, in mm)
 *   Boden botL x botW, darüber wird der Bin über die Höhe coneH gleichmäßig weiter
 *   bis topL x topW. Darüber liegt ein gerader Rand der Höhe rimH mit topL x topW.
 *   Der Bin ist symmetrisch: die Wände sind auf beiden Seiten gleich geneigt.
 *
 * Koordinaten
 *   x entlang der Länge, y entlang der Breite, gemessen ab der Ecke der oberen Öffnung
 *   (0 … topL, 0 … topW). z ab dem Boden. In der Höhe z ist die Wand um
 *   (topL - L(z)) / 2 bzw. (topW - W(z)) / 2 eingerückt.
 *
 * Regeln für ein gültiges Muster
 *   - Ein Karton steht gerade (nicht gekippt). Seine Grundfläche muss in den Querschnitt
 *     auf Höhe seiner Unterkante passen; weiter oben ist der Bin nur breiter.
 *   - Kartons überschneiden sich nicht.
 *   - Jeder Karton liegt auf dem Boden oder auf mindestens einem anderen Karton auf.
 *
 * Lösungsweg
 *   1. Lagen: Der Bin wird waagerecht in Lagen geteilt. Jede Lage ist ein Quader mit
 *      dem Querschnitt an ihrer Unterkante und wird mit dem Quader-Löser gepackt
 *      (Blockmuster, dazu Suche nach verschränkten Mustern). Eine dynamische
 *      Programmierung über die Höhe wählt die beste Folge von Lagen. Obere Lagen
 *      nutzen so den breiteren Querschnitt.
 *   2. Absenken: Jede Lage wird mittig gesetzt, dann fällt jeder Karton senkrecht bis
 *      zur Auflage. Passt er dort nicht mehr zwischen die Wände, wird er nach innen
 *      geschoben oder entfernt. Das Ergebnis ist immer ein gültiges Muster.
 *   3. Freie Suche: Eine Tiefensuche direkt im Konus versucht, einen Karton mehr
 *      unterzubringen, auch mit Mustern, die sich nicht in Lagen zerlegen lassen.
 */

if (typeof module !== "undefined" && typeof dpTable === "undefined") {
  // eslint-disable-next-line no-var
  var { dpTable, normalSet, portfolioSearch, dagFromPlacements, patternLayout, upperBoundInt } = require("./packcore.js");
}

/**
 * @typedef {{topL: number, topW: number, rimH: number, botL: number, botW: number, coneH: number, unit?: number}} ConeBin
 *   unit: mm je Maßeinheit, wenn die Maße nicht in mm stehen (nur bei der Regelerzeugung im cm-Raster)
 */
/** @typedef {{x: number, y: number, z: number, dx: number, dy: number, dz: number, p: number[]}} ConePlacement */
/**
 * @typedef {{carton: number[], count: number, upper: number, status: "optimal" | "searched" | "open",
 *   placements: ConePlacement[], source: "lagen" | "suche" | "leer", removed: number,
 *   bottomCuboid: number, topCuboid: number, final: boolean, layers?: string | null, hasRule?: boolean,
 *   approx?: boolean, heavy?: boolean, effort?: DpEffort}} ConeAnalysis
 *   Die folgenden Felder setzt cone-rules.js (analyzeConeLayers):
 *   layers: Textform als Lagenmuster, wenn das Ergebnis eines ist; hasRule: dazu gibt es eine Regel.
 *   approx: vereinfacht gerechnet; heavy: die genaue Rechnung (Absenken, freie Suche) ist hier möglich.
 *   Bei mehr als CONE_LIST_MAX Kartons ist placements leer; das Muster steht dann nur in layers.
 */

const CONE_PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const CONE_EDGE = "lwh";
const CONE_EPS = 0.05;
/** So viele mm muss ein Karton in beiden Richtungen auf einem anderen liegen, damit er als aufliegend gilt */
const CONE_SUPPORT = 1;
/** @returns {number} */
const coneNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Größtes zulässiges Bin-Maß in mm (100 m) */
const CONE_MAX_MM = 100000;
/** Voreinstellung nach Zeichnung: Rand 558 x 374 x 65, Boden 515 x 336, konischer Teil 344 hoch */
/** @type {ConeBin} */
const CONE_DEFAULT = { topL: 558, topW: 374, rimH: 65, botL: 515, botW: 336, coneH: 344 };

/* =========================================================================
 * Geometrie
 * ========================================================================= */

/** @param {ConeBin} b @returns {number} gesamte Innenhöhe */
function coneHeight(b) { return b.coneH + b.rimH; }

/** @param {ConeBin} b @param {number} z @returns {number} Anteil der Aufweitung in Höhe z (0 … 1) */
function coneT(b, z) { return b.coneH > 0 ? Math.min(1, Math.max(0, z / b.coneH)) : 1; }

/** @param {ConeBin} b @param {number} z @returns {number} Innenlänge in Höhe z */
function coneLen(b, z) { return b.botL + (b.topL - b.botL) * coneT(b, z); }

/** @param {ConeBin} b @param {number} z @returns {number} Innenbreite in Höhe z */
function coneWid(b, z) { return b.botW + (b.topW - b.botW) * coneT(b, z); }

/** @param {ConeBin} b @param {number} z @returns {number[]} Einrückung der Wand [x, y] in Höhe z */
function coneOffset(b, z) { return [(b.topL - coneLen(b, z)) / 2, (b.topW - coneWid(b, z)) / 2]; }

/**
 * Volumen des Bins oberhalb der Höhe z0.
 * @param {ConeBin} b @param {number} [z0] @returns {number}
 */
function coneVolume(b, z0 = 0) {
  const H = coneHeight(b);
  let v = 0;
  const a = Math.min(Math.max(z0, 0), b.coneH), e = b.coneH;
  if (e > a) {
    const sL = (b.topL - b.botL) / b.coneH, sW = (b.topW - b.botW) / b.coneH;
    v += b.botL * b.botW * (e - a) + (b.botL * sW + b.botW * sL) * (e * e - a * a) / 2 + sL * sW * (e * e * e - a * a * a) / 3;
  }
  const r0 = Math.max(z0, b.coneH);
  if (H > r0) v += b.topL * b.topW * (H - r0);
  return v;
}

/**
 * Obergrenze für die Anzahl. Weil jeder Karton aufliegt, ist die Höhe jeder
 * Unterkante eine Summe von Kartonkanten. In einer waagerechten Scheibe zwischen zwei
 * solchen Höhen liegen alle Grundflächen im Querschnitt an der unteren Höhe, und
 * nebeneinander lassen sich höchstens Summen von Kartonkanten unterbringen.
 * @param {number[]} c Karton (mm) @param {ConeBin} b @returns {number}
 */
function coneUpper(c, b) {
  const u = 0.1;
  const cu = c.map((v) => Math.max(1, Math.round(v / u)));
  const Hu = Math.floor(coneHeight(b) / u + 1e-9);
  const dims = [...new Set(cu)];
  const NZ = normalSet(Hu, dims).vals;
  const minE = Math.min(...cu);
  let zLast = 0;
  for (const z of NZ) if (z + minE <= Hu) zLast = z;
  // bei sehr vielen Höhenstufen in einem großen Bin wäre diese Grenze zu aufwendig
  if (NZ.length * (b.topL + b.topW) / u * dims.length > 3e8) return Infinity;
  /** @type {Map<number, number>} */ const starMemo = new Map();
  /** @param {number} D @returns {number} größte Kantensumme, die in D passt */
  const star = (D) => {
    let v = starMemo.get(D);
    if (v === undefined) { const s = normalSet(Math.max(0, D), dims).vals; v = s[s.length - 1]; starMemo.set(D, v); }
    return v;
  };
  let vol = 0;
  for (let i = 0; i + 1 < NZ.length; i++) {
    const z = Math.min(NZ[i], zLast) * u;
    vol += star(Math.floor(coneLen(b, z) / u + 1e-9)) * star(Math.floor(coneWid(b, z) / u + 1e-9)) * (NZ[i + 1] - NZ[i]);
  }
  return Math.floor(vol / (cu[0] * cu[1] * cu[2]) + 1e-9);
}

/** @param {ConeBin} b @returns {string | null} Fehlertext oder null */
function coneBinError(b) {
  const vals = [b.topL, b.topW, b.rimH, b.botL, b.botW, b.coneH];
  if (vals.some((v) => !isFinite(v) || v < 0 || v > CONE_MAX_MM)) return "Bitte alle Bin-Maße als Zahlen zwischen 0 und 100 m eingeben.";
  if (!(b.topL > 0 && b.topW > 0 && b.botL > 0 && b.botW > 0)) return "Länge und Breite müssen größer als 0 sein.";
  if (b.botL > b.topL + 1e-9 || b.botW > b.topW + 1e-9) return "Der Boden darf nicht größer sein als die Öffnung oben.";
  if (!(coneHeight(b) > 0)) return "Die Höhe (konischer Teil plus Rand) muss größer als 0 sein.";
  return null;
}

/* =========================================================================
 * Prüfen und Absenken
 * ========================================================================= */

/** @param {ConePlacement} a @param {ConePlacement} b @param {number} e @returns {boolean} Grundflächen überlappen */
function footOverlap(a, b, e) {
  return a.x < b.x + b.dx - e && b.x < a.x + a.dx - e && a.y < b.y + b.dy - e && b.y < a.y + a.dy - e;
}

/** @param {ConeBin} b @param {ConePlacement} p @param {number} z @param {number} eps @returns {boolean} passt in Höhe z zwischen die Wände */
function coneInside(b, p, z, eps) {
  const [ox, oy] = coneOffset(b, z);
  return p.x >= ox - eps && p.x + p.dx <= b.topL - ox + eps && p.y >= oy - eps && p.y + p.dy <= b.topW - oy + eps
    && z >= -eps && z + p.dz <= coneHeight(b) + eps;
}

/**
 * Prüft ein fertiges Muster.
 * @param {ConeBin} b @param {ConePlacement[]} P @returns {string[]} Fehler (leer = gültig)
 */
function coneCheck(b, P) {
  /** @type {string[]} */ const errs = [];
  const f = (/** @type {number} */ v) => String(Math.round(v * 10) / 10).replace(".", ",");
  P.forEach((p, i) => {
    if (p.z < -CONE_EPS) errs.push(`Karton ${i + 1} liegt unter dem Boden.`);
    if (p.z + p.dz > coneHeight(b) + CONE_EPS) errs.push(`Karton ${i + 1} ragt oben ${f(p.z + p.dz - coneHeight(b))} mm heraus.`);
    const [ox, oy] = coneOffset(b, Math.max(0, p.z));
    const over = Math.max(ox - p.x, p.x + p.dx - (b.topL - ox), oy - p.y, p.y + p.dy - (b.topW - oy));
    if (over > CONE_EPS) errs.push(`Karton ${i + 1} stößt in Höhe ${f(p.z)} mm um ${f(over)} mm durch die Wand.`);
  });
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], c = P[j];
    if (footOverlap(a, c, CONE_EPS) && a.z < c.z + c.dz - CONE_EPS && c.z < a.z + a.dz - CONE_EPS) errs.push(`Karton ${i + 1} und ${j + 1} überschneiden sich.`);
  }
  P.forEach((p, i) => {
    if (p.z <= CONE_EPS) return;
    if (!(supportShare(p, P.filter((q) => q !== p && Math.abs(q.z + q.dz - p.z) <= CONE_EPS)) > 0)) errs.push(`Karton ${i + 1} liegt nirgends auf.`);
  });
  return errs;
}

/**
 * Lässt alle Kartons senkrecht bis zur Auflage fallen. Passt ein Karton in seiner
 * Endhöhe nicht zwischen die Wände, wird er nach innen geschoben; geht auch das
 * nicht, fällt er weg.
 * @param {ConeBin} b @param {ConePlacement[]} P
 * @returns {{placed: ConePlacement[], removed: number}}
 */
function coneSettle(b, P) {
  const order = [...P].sort((p, q) => (p.z - q.z) || (p.y - q.y) || (p.x - q.x));
  /** @type {ConePlacement[]} */ const out = [];
  let removed = 0;
  for (const p0 of order) {
    let p = { ...p0 };
    let ok = false;
    for (let it = 0; it < 6; it++) {
      let support = 0;
      for (const q of out) if (footOverlap(p, q, 1e-6)) support = Math.max(support, q.z + q.dz);
      p.z = support;
      if (coneInside(b, p, p.z, 1e-6)) { ok = true; break; }
      const [ox, oy] = coneOffset(b, p.z);
      const nx = Math.min(Math.max(p.x, ox), b.topL - ox - p.dx), ny = Math.min(Math.max(p.y, oy), b.topW - oy - p.dy);
      if (nx < ox - 1e-9 || ny < oy - 1e-9 || p.z + p.dz > coneHeight(b) + 1e-6) break;
      p = { ...p, x: nx, y: ny };
    }
    if (ok) {
      // nach dem Schieben darf der Karton keinen anderen schneiden und muss aufliegen
      const hit = out.some((q) => footOverlap(p, q, 1e-6) && q.z + q.dz > p.z + 1e-6);
      const rests = p.z <= 1e-6 || supportShare(p, out.filter((q) => Math.abs(q.z + q.dz - p.z) <= 1e-6)) > 0;
      ok = !hit && rests;
    }
    if (ok) out.push(p); else removed++;
  }
  return { placed: out, removed };
}

/* =========================================================================
 * Textform:  K(360x236x128; hlw@0,0,0; wlh@128,0,0)
 * ========================================================================= */

/** @param {number} v @returns {string} */
function coneNum(v) {
  const r = Math.round(v * 10) / 10;
  return Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(1);
}

/**
 * @param {number[]} carton sortiert l >= w >= h @param {ConePlacement[]} P @returns {string}
 */
function coneString(carton, P) {
  const order = [...P].sort((p, q) => (p.z - q.z) || (p.y - q.y) || (p.x - q.x));
  return "K(" + [carton.map(coneNum).join("x")].concat(order.map((p) =>
    p.p.map((e) => CONE_EDGE[e]).join("") + "@" + [p.x, p.y, p.z].map(coneNum).join(","))).join("; ") + ")";
}

/**
 * Liest die Textform. Prüft nur die Schreibweise, nicht die Lage im Bin.
 * @param {string} input @returns {{carton: number[], placements: ConePlacement[]}}
 */
function parseCone(input) {
  const s = String(input || "").replace(/\s+/g, "");
  if (!s) throw new Error("Bitte ein Muster einfügen, zum Beispiel K(360x236x128; hlw@0,0,0; wlh@128,0,0).");
  const m = /^K\((.*)\)$/i.exec(s);
  if (!m) throw new Error("Ein Muster für den konischen Bin beginnt mit K( und endet mit ). Kartonlisten B(…) gehören in den Reiter „Quader-Bin“.");
  const items = m[1].split(";").filter(Boolean);
  const dm = /^(\d+(?:[.,]\d+)?)[x×*](\d+(?:[.,]\d+)?)[x×*](\d+(?:[.,]\d+)?)$/i.exec(items[0] || "");
  if (!dm) throw new Error("Am Anfang müssen die Kartonmaße stehen, zum Beispiel 360x236x128.");
  const carton = [dm[1], dm[2], dm[3]].map((v) => parseFloat(v.replace(",", "."))).sort((a, b) => b - a);
  if (carton.some((v) => !(v > 0))) throw new Error("Die Kartonmaße müssen größer als 0 sein.");
  if (items.length < 2) throw new Error("Nach den Kartonmaßen fehlt mindestens ein Karton, zum Beispiel hlw@0,0,0.");
  if (items.length > 5001) throw new Error("Höchstens 5000 Kartons in einem Muster.");
  /** @type {ConePlacement[]} */ const placements = items.slice(1).map((it, i) => {
    const im = /^([a-z]{3})@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/i.exec(it);
    if (!im) throw new Error(`Karton ${i + 1}: „${it}“ verstehe ich nicht. Erwartet wird Lage@x,y,z, zum Beispiel wlh@128,0,0 (Dezimalpunkt).`);
    const p = [...im[1].toLowerCase()].map((ch) => CONE_EDGE.indexOf(ch));
    if (p.includes(-1) || new Set(p).size !== 3) throw new Error(`Karton ${i + 1}: Die Lage „${im[1]}“ muss l, w und h je einmal enthalten.`);
    return { x: +im[2], y: +im[3], z: +im[4], dx: carton[p[0]], dy: carton[p[1]], dz: carton[p[2]], p };
  });
  return { carton, placements };
}

/* =========================================================================
 * Lagen: dynamische Programmierung über die Höhe
 * ========================================================================= */

/**
 * @typedef {{count: number, placed: ConePlacement[], height: number, floor: ConePlacement[], top: ConePlacement[]}} LayerOption
 * @typedef {{slabs: LayerOption[], count: number, aware: boolean}} LayerPlan
 */

/**
 * Schwerkraft im Quader: jeder Karton fällt bis zur Auflage (ohne Wände).
 * @param {ConePlacement[]} P @returns {ConePlacement[]}
 */
function boxSettle(P) {
  const order = [...P].sort((p, q) => (p.z - q.z) || (p.y - q.y) || (p.x - q.x));
  /** @type {ConePlacement[]} */ const out = [];
  for (const p0 of order) {
    let support = 0;
    for (const q of out) if (footOverlap(p0, q, 1e-6)) support = Math.max(support, q.z + q.dz);
    out.push({ ...p0, z: support });
  }
  return out;
}

/**
 * Anteil der Grundfläche von u, der auf den Kartons in tops aufliegt (0, wenn nirgends
 * mindestens CONE_SUPPORT mm in beiden Richtungen).
 * @param {ConePlacement} u @param {ConePlacement[]} tops @returns {number}
 */
function supportShare(u, tops) {
  let area = 0;
  for (const v of tops) {
    const ox = Math.min(u.x + u.dx, v.x + v.dx) - Math.max(u.x, v.x), oy = Math.min(u.y + u.dy, v.y + v.dy) - Math.max(u.y, v.y);
    if (ox >= CONE_SUPPORT - 1e-6 && oy >= CONE_SUPPORT - 1e-6) area += ox * oy;
  }
  return area / (u.dx * u.dy);
}

/**
 * Beste Folge von Lagen. Jede Lage ist ein Quader mit dem Querschnitt an ihrer
 * Unterkante. Benachbarte Lagen werden nur kombiniert, wenn jeder Karton der oberen
 * Lage auf der unteren aufliegt.
 * @param {number[]} c Karton sortiert (mm) @param {ConeBin} bin @param {number} unit mm je Recheneinheit
 * @param {number} searchMs Zeit für die Suche nach verschränkten Lagen (0 = aus)
 * @returns {LayerPlan | null} null, wenn zu aufwendig
 */
function coneLayers(c, bin, unit, searchMs) {
  const cu = c.map((v) => Math.max(1, Math.ceil(v / unit - 1e-9)));
  const shrink = Math.min(...c.map((v, i) => v / (cu[i] * unit)));
  const Lu = Math.floor(bin.topL / unit + 1e-9), Wu = Math.floor(bin.topW / unit + 1e-9), Hu = Math.floor(coneHeight(bin) / unit + 1e-9);
  const table = dpTable(cu, [Lu, Wu, Hu], false);
  if (!table) return null;
  const NZ = table.heights;
  const n = NZ.length;
  const dims = [...new Set(cu)];
  /** @type {Map<number, number>} */ const zIndex = new Map(NZ.map((z, i) => [z, i]));
  /** @param {number} z @returns {number[]} Querschnitt in Einheiten, vorsichtig gerechnet */
  const cross = (z) => {
    const zr = z * unit * shrink;
    return [Math.floor(coneLen(bin, zr) / unit + 1e-9), Math.floor(coneWid(bin, zr) / unit + 1e-9)];
  };
  const X = NZ.map((z) => cross(z));

  // Lagen aus Kartons gleicher Höhe zusätzlich zweidimensional verschränkt suchen
  /** @type {Map<number, {pattern: Pattern, count: number}>} */ const over = new Map();
  if (searchMs > 0) {
    /** @type {{key: number, B: number[], cnt: number}[]} */ const jobs = [];
    for (let a = 0; a < n; a++) for (let t = 1; t < n; t++) {
      const T = NZ[t];
      if (NZ[a] + T > Hu || !dims.includes(T)) continue;
      const B = [X[a][0], X[a][1], T];
      const cnt = table.cellCount(B[0], B[1], T);
      if (cnt < 1 || cnt + 1 > 40 || upperBoundInt(cu, B) <= cnt) continue;
      jobs.push({ key: a * n + t, B, cnt });
    }
    const per = jobs.length ? Math.max(8, Math.min(80, searchMs / jobs.length)) : 0;
    const t0 = coneNow();
    for (const j of jobs) {
      if (coneNow() - t0 > searchMs) break;
      let cnt = j.cnt;
      for (;;) {
        const r = portfolioSearch(cu, j.B, cnt + 1, per);
        if (!r.placements) break;
        cnt++;
        over.set(j.key, { pattern: dagFromPlacements(r.placements, j.B), count: cnt });
        if (upperBoundInt(cu, j.B) <= cnt) break;
      }
    }
  }
  /** @param {number} a @param {number} t @returns {number} */
  const countOf = (a, t) => {
    const o = over.get(a * n + t);
    return o ? o.count : table.cellCount(X[a][0], X[a][1], NZ[t]);
  };
  // je Höhe nur Dicken, die wirklich mehr Kartons bringen
  /** @type {number[][]} */ const thick = NZ.map((z, a) => {
    /** @type {number[]} */ const list = [];
    let last = 0;
    for (let t = 1; t < n && z + NZ[t] <= Hu; t++) { const k = countOf(a, t); if (k > last) { list.push(t); last = k; } }
    return list;
  });
  /** @type {Map<number, LayerOption | null>} */ const cache = new Map();
  /** @param {number} a @param {number} t @returns {LayerOption | null} */
  const option = (a, t) => {
    const key = a * n + t;
    if (cache.has(key)) return /** @type {LayerOption | null} */ (cache.get(key));
    const o = over.get(key);
    /** @type {Pattern | null} */ let pattern = o ? o.pattern : null;
    if (!pattern) { const tree = table.cellTree(X[a][0], X[a][1], NZ[t]); pattern = tree ? { kind: "T", root: tree } : null; }
    /** @type {LayerOption | null} */ let opt = null;
    if (pattern) {
      const P = boxSettle(patternLayout(pattern, c));
      let ex = 0, ey = 0, ez = 0;
      for (const p of P) { ex = Math.max(ex, p.x + p.dx); ey = Math.max(ey, p.y + p.dy); ez = Math.max(ez, p.z + p.dz); }
      const ox = (bin.topL - ex) / 2, oy = (bin.topW - ey) / 2;
      const placed = P.map((p) => ({ ...p, x: p.x + ox, y: p.y + oy }));
      opt = { count: placed.length, placed, height: ez, floor: placed.filter((p) => p.z <= 1e-6), top: placed.filter((p) => Math.abs(p.z + p.dz - ez) <= 1e-6) };
    }
    cache.set(key, opt);
    return opt;
  };

  const aware = n <= 40;
  /** @type {Map<number, {total: number, sup: number, next: number}>} */ const G = new Map();
  for (let a = n - 1; a >= 0; a--) {
    for (const t of thick[a]) {
      const cnt = countOf(a, t);
      const b = zIndex.get(NZ[a] + NZ[t]);
      let total = cnt, sup = 1, next = -1;
      if (b !== undefined) {
        const lower = aware ? option(a, t) : null;
        for (const t2 of thick[b]) {
          const g = G.get(b * n + t2);
          if (!g) continue;
          let s = 1;
          if (aware) {
            const upper = option(b, t2);
            if (!lower || !upper) continue;
            s = Math.min(...upper.floor.map((u) => supportShare(u, lower.top)));
            if (!(s > 0)) continue;
          }
          const tot = cnt + g.total, ms = Math.min(s, g.sup);
          if (tot > total || (tot === total && next >= 0 && ms > sup + 1e-9)) { total = tot; sup = ms; next = b * n + t2; }
        }
      }
      G.set(a * n + t, { total, sup, next });
    }
  }
  let best = -1, bestG = null;
  for (const t of thick[0]) {
    const g = /** @type {{total: number, sup: number, next: number}} */ (G.get(t));
    if (!bestG || g.total > bestG.total || (g.total === bestG.total && g.sup > bestG.sup + 1e-9)) { best = t; bestG = g; }
  }
  /** @type {LayerOption[]} */ const slabs = [];
  for (let key = best; key >= 0;) {
    const opt = option(Math.floor(key / n), key % n);
    if (opt) slabs.push(opt);
    key = /** @type {{next: number}} */ (G.get(key)).next;
  }
  return { slabs, count: bestG ? bestG.total : 0, aware };
}

/**
 * Einfache Gitterlagen für sehr kleine Kartons, bei denen die Lagenrechnung zu
 * aufwendig wäre: jede Lage ist ein Gitter gleich gedrehter Kartons.
 * @param {number[]} c @param {ConeBin} bin @returns {ConePlacement[]}
 */
function coneGridLayers(c, bin) {
  const unit = 0.5;
  const cu = c.map((v) => Math.max(1, Math.ceil(v / unit - 1e-9)));
  const Hu = Math.floor(coneHeight(bin) / unit + 1e-9);
  const g = new Int32Array(Hu + 2);
  /** @type {({n: number[], p: number[]} | null)[]} */ const pick = new Array(Hu + 2).fill(null);
  for (let z = Hu; z >= 0; z--) {
    const Lz = coneLen(bin, z * unit), Wz = coneWid(bin, z * unit);
    for (const p of CONE_PERMS) {
      const dz = cu[p[2]];
      if (z + dz > Hu) continue;
      const k = [Math.floor(Lz / c[p[0]] + 1e-9), Math.floor(Wz / c[p[1]] + 1e-9)];
      const v = k[0] * k[1] + g[z + dz];
      if (k[0] * k[1] > 0 && v > g[z]) { g[z] = v; pick[z] = { n: k, p }; }
    }
  }
  /** @type {ConePlacement[]} */ const out = [];
  for (let z = 0; z <= Hu && pick[z];) {
    const k = /** @type {{n: number[], p: number[]}} */ (pick[z]);
    const d = [c[k.p[0]], c[k.p[1]], c[k.p[2]]];
    const ox = (bin.topL - k.n[0] * d[0]) / 2, oy = (bin.topW - k.n[1] * d[1]) / 2;
    for (let j = 0; j < k.n[1]; j++) for (let i = 0; i < k.n[0]; i++) out.push({ x: ox + i * d[0], y: oy + j * d[1], z: z * unit, dx: d[0], dy: d[1], dz: d[2], p: k.p });
    z += cu[k.p[2]];
  }
  return out;
}

/**
 * Setzt die Lagen übereinander und senkt alles ab.
 * @param {ConeBin} bin @param {LayerOption[]} slabs
 * @returns {{placed: ConePlacement[], removed: number}}
 */
function coneBuild(bin, slabs) {
  /** @type {ConePlacement[]} */ const all = [];
  let base = 0;
  for (const s of slabs) {
    for (const p of s.placed) all.push({ ...p, z: p.z + base });
    base += s.height;
  }
  return coneSettle(bin, all);
}

/* =========================================================================
 * Freie Suche direkt im Konus (findet auch Muster, die keine Lagen sind)
 * ========================================================================= */

/**
 * Tiefensuche: Kartons werden in aufsteigender Reihenfolge (Höhe, Breite, Länge)
 * gesetzt, immer aufliegend. Mögliche Positionen sind Wandabstand plus Summen von
 * Kartonkanten, also Kartons, die bündig an einer Wand oder an anderen Kartons liegen.
 * @param {number[]} cu Karton in Einheiten @param {ConeBin} bin @param {number} unit
 * @param {number} target @param {number} timeMs @param {number} rot welche Lage zuerst probiert wird
 * @returns {{placements: ConePlacement[] | null, exhaustive: boolean}} Positionen in mm
 */
function coneSearch(cu, bin, unit, target, timeMs, rot) {
  const Lu = Math.floor(bin.topL / unit + 1e-9), Wu = Math.floor(bin.topW / unit + 1e-9), Hu = Math.floor(coneHeight(bin) / unit + 1e-9);
  const supU = Math.max(1, Math.ceil(CONE_SUPPORT / unit - 1e-9));
  const xo = new Int32Array(Hu + 2), yo = new Int32Array(Hu + 2);
  for (let z = 0; z <= Hu + 1; z++) {
    const [ox, oy] = coneOffset(bin, z * unit);
    xo[z] = Math.ceil(ox / unit - 1e-9); yo[z] = Math.ceil(oy / unit - 1e-9);
  }
  /** @type {number[][]} */ const ors = [];
  /** @type {number[][]} */ const orp = [];
  /** @type {Set<string>} */ const seen = new Set();
  for (const p of CONE_PERMS) {
    const d = [cu[p[0]], cu[p[1]], cu[p[2]]];
    const key = d.join(",");
    if (!seen.has(key) && d[0] <= Lu && d[1] <= Wu && d[2] <= Hu) { seen.add(key); ors.push(d); orp.push(p); }
  }
  if (!ors.length || target <= 0) return { placements: target <= 0 ? [] : null, exhaustive: true };
  const dims = [...new Set(cu)];
  const minDim = Math.min(...cu);
  const NZ = normalSet(Hu, dims).vals;
  /** @param {number} D @param {Int32Array} off @returns {Int32Array} Wandabstand in jeder möglichen Höhe plus Kantensummen */
  const cand = (D, off) => {
    /** @type {Set<number>} */ const set = new Set();
    const sums = normalSet(D, dims).vals;
    for (const z of NZ) for (const m of sums) { const v = off[z] + m; if (v + minDim <= D) set.add(v); }
    return Int32Array.from([...set].sort((a, b) => a - b));
  };
  const CX = cand(Lu, xo), CY = cand(Wu, yo);
  // nutzbares Volumen oberhalb jeder Höhe (Querschnitt je Scheibe an deren Oberkante)
  const volAbove = new Float64Array(Hu + 2);
  for (let z = Hu - 1; z >= 0; z--) volAbove[z] = volAbove[z + 1] + (Lu - 2 * xo[z + 1]) * (Wu - 2 * yo[z + 1]);
  const vol = cu[0] * cu[1] * cu[2];
  if (target * vol > volAbove[0]) return { placements: null, exhaustive: true };

  const K = target, O = ors.length;
  const ODX = Int32Array.from(ors.map((o) => o[0])), ODY = Int32Array.from(ors.map((o) => o[1])), ODZ = Int32Array.from(ors.map((o) => o[2]));
  const px = new Int32Array(K), py = new Int32Array(K), pz = new Int32Array(K);
  const sx = new Int32Array(K), sy = new Int32Array(K), sz = new Int32Array(K), po = new Int32Array(K);
  const zbuf = new Int32Array((K + 1) * (K + 1));
  const ovZ = new Int32Array((K + 1) * O * K), nZ = new Int32Array((K + 1) * O);
  const ovY = new Int32Array((K + 1) * O * K), nY = new Int32Array((K + 1) * O);
  const supZ = new Int32Array((K + 1) * K);
  const supY = new Int32Array((K + 1) * O * K), nS = new Int32Array((K + 1) * O);
  const rect = new Int32Array(4 * K), exs = new Int32Array(2 * K + 2), eys = new Int32Array(2 * K + 2);
  const t0 = coneNow();
  let nodes = 0, timeout = false;

  /** @param {Int32Array} a @param {number} from @param {number} to @returns {number} */
  const sortUnique = (a, from, to) => {
    for (let i = from + 1; i < to; i++) { const v = a[i]; let j = i - 1; while (j >= from && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
    let w = from;
    for (let i = from; i < to; i++) if (i === from || a[i] !== a[w - 1]) a[w++] = a[i];
    return w;
  };

  /** @param {number} k @param {number} zl @param {number} yl @param {number} xl @returns {boolean} */
  const dfs = (k, zl, yl, xl) => {
    if (k === K) return true;
    if ((++nodes & 255) === 0 && coneNow() - t0 > timeMs) timeout = true;
    if (timeout) return false;
    let above = 0, zn = zl + minDim;
    for (let i = 0; i < k; i++) {
      const top = pz[i] + sz[i];
      if (top > zl) { above += sx[i] * sy[i] * (top - (pz[i] > zl ? pz[i] : zl)); if (top < zn) zn = top; }
    }
    // Streifen vor dem letzten Karton auf dieser Höhe ist für spätere Kartons verloren
    let lost = 0;
    const xs0 = xo[zl], xs1 = Lu - xo[zl], ys0 = yo[zl];
    const ylc = Math.min(yl, Wu - yo[zl]);
    if (ylc > ys0) {
      let nr = 0, ne = 0, nf = 0;
      exs[ne++] = xs0; exs[ne++] = xs1; eys[nf++] = ys0; eys[nf++] = ylc;
      for (let i = 0; i < k; i++) {
        if (pz[i] <= zl && pz[i] + sz[i] > zl) {
          const x0 = Math.max(px[i], xs0), x1 = Math.min(px[i] + sx[i], xs1), y0 = Math.max(py[i], ys0), y1 = Math.min(py[i] + sy[i], ylc);
          if (x0 < x1 && y0 < y1) {
            rect[4 * nr] = x0; rect[4 * nr + 1] = x1; rect[4 * nr + 2] = y0; rect[4 * nr + 3] = y1; nr++;
            exs[ne++] = x0; exs[ne++] = x1; eys[nf++] = y0; eys[nf++] = y1;
          }
        }
      }
      ne = sortUnique(exs, 0, ne); nf = sortUnique(eys, 0, nf);
      let covered = 0;
      for (let a = 0; a + 1 < ne; a++) {
        const cx2 = exs[a] + exs[a + 1];
        for (let b = 0; b + 1 < nf; b++) {
          const cy2 = eys[b] + eys[b + 1];
          for (let r = 0; r < nr; r++) {
            if (cx2 > 2 * rect[4 * r] && cx2 < 2 * rect[4 * r + 1] && cy2 > 2 * rect[4 * r + 2] && cy2 < 2 * rect[4 * r + 3]) {
              covered += (exs[a + 1] - exs[a]) * (eys[b + 1] - eys[b]); break;
            }
          }
        }
      }
      lost = ((xs1 - xs0) * (ylc - ys0) - covered) * (Math.min(zn, Hu) - zl);
    }
    if ((K - k) * vol > volAbove[zl] - above - lost) return false;

    const zb = k * (K + 1);
    let nzc = 0;
    zbuf[zb + nzc++] = zl;
    for (let i = 0; i < k; i++) { const top = pz[i] + sz[i]; if (top > zl) zbuf[zb + nzc++] = top; }
    nzc = sortUnique(zbuf, zb, zb + nzc) - zb;

    const ob = k * O;
    for (let zi = 0; zi < nzc; zi++) {
      const z = zbuf[zb + zi];
      if (z + minDim > Hu) continue;
      let ns = 0;
      if (z > 0) for (let i = 0; i < k; i++) if (pz[i] + sz[i] === z) supZ[k * K + ns++] = i;
      if (z > 0 && ns === 0) continue;
      const xlo = xo[z], xhiW = Lu - xo[z], ylo = yo[z], yhiW = Wu - yo[z];
      for (let o = 0; o < O; o++) {
        let m = 0;
        const dz = ODZ[o];
        const fits = z + dz <= Hu && ODX[o] <= xhiW - xlo && ODY[o] <= yhiW - ylo;
        if (fits) for (let i = 0; i < k; i++) if (z < pz[i] + sz[i] && pz[i] < z + dz) ovZ[(ob + o) * K + m++] = i;
        nZ[ob + o] = fits ? m : -1;
      }
      for (let yi = 0; yi < CY.length; yi++) {
        const y = CY[yi];
        if (y < ylo) continue;
        if (z === zl && y < yl) continue;
        let any = false;
        for (let o = 0; o < O; o++) {
          nY[ob + o] = -1; nS[ob + o] = 0;
          if (nZ[ob + o] < 0) continue;
          const dy = ODY[o];
          if (y + dy > yhiW) continue;
          let m = 0;
          for (let j = 0; j < nZ[ob + o]; j++) { const i = ovZ[(ob + o) * K + j]; if (y < py[i] + sy[i] && py[i] < y + dy) ovY[(ob + o) * K + m++] = i; }
          let s = 0;
          if (z > 0) {
            for (let j = 0; j < ns; j++) {
              const i = supZ[k * K + j];
              if (Math.min(y + dy, py[i] + sy[i]) - Math.max(y, py[i]) >= supU) supY[(ob + o) * K + s++] = i;
            }
            if (s === 0) continue;
          }
          nY[ob + o] = m; nS[ob + o] = s; any = true;
        }
        if (!any) continue;
        for (let xi = 0; xi < CX.length; xi++) {
          const x = CX[xi];
          if (x < xlo) continue;
          if (z === zl && y === yl && x <= xl) continue;
          for (let oi = 0; oi < O; oi++) {
            const o = (oi + rot) % O;
            const m = nY[ob + o];
            if (m < 0) continue;
            const dx = ODX[o];
            if (x + dx > xhiW) continue;
            let ok = true;
            for (let j = 0; j < m; j++) { const i = ovY[(ob + o) * K + j]; if (x < px[i] + sx[i] && px[i] < x + dx) { ok = false; break; } }
            if (!ok) continue;
            if (z > 0) {
              let sup = false;
              for (let j = 0; j < nS[ob + o]; j++) {
                const i = supY[(ob + o) * K + j];
                if (Math.min(x + dx, px[i] + sx[i]) - Math.max(x, px[i]) >= supU) { sup = true; break; }
              }
              if (!sup) continue;
            }
            px[k] = x; py[k] = y; pz[k] = z; sx[k] = dx; sy[k] = ODY[o]; sz[k] = ODZ[o]; po[k] = o;
            if (dfs(k + 1, z, y, x)) return true;
            if (timeout) return false;
          }
        }
      }
    }
    return false;
  };

  if (!dfs(0, 0, -1, -1)) return { placements: null, exhaustive: !timeout };
  /** @type {ConePlacement[]} */ const out = [];
  for (let i = 0; i < K; i++) out.push({ x: px[i] * unit, y: py[i] * unit, z: pz[i] * unit, dx: sx[i] * unit, dy: sy[i] * unit, dz: sz[i] * unit, p: orp[po[i]] });
  return { placements: out, exhaustive: true };
}

/**
 * Freie Suche in mehreren Varianten (welche Lage zuerst, Länge und Breite getauscht)
 * mit wachsenden Zeitscheiben.
 * @param {number[]} cu @param {ConeBin} bin @param {number} unit @param {number} target @param {number} budgetMs
 * @returns {{placements: ConePlacement[] | null, exhaustive: boolean}}
 */
function coneFreeSearch(cu, bin, unit, target, budgetMs) {
  const t0 = coneNow();
  /** @type {ConeBin} */ const swapped = { topL: bin.topW, topW: bin.topL, rimH: bin.rimH, botL: bin.botW, botW: bin.botL, coneH: bin.coneH };
  /** @type {{swap: boolean, rot: number}[]} */ const configs = [];
  for (let rot = 0; rot < 6; rot++) for (const swap of [false, true]) configs.push({ swap, rot });
  let slice = Math.max(25, budgetMs / 24);
  for (;;) {
    for (const cf of configs) {
      const left = budgetMs - (coneNow() - t0);
      if (left <= 2) return { placements: null, exhaustive: false };
      const r = coneSearch(cu, cf.swap ? swapped : bin, unit, target, Math.min(slice, left), cf.rot);
      if (r.placements) {
        const P = cf.swap ? r.placements.map((q) => ({ x: q.y, y: q.x, z: q.z, dx: q.dy, dy: q.dx, dz: q.dz, p: [q.p[1], q.p[0], q.p[2]] })) : r.placements;
        return { placements: P, exhaustive: true };
      }
      if (r.exhaustive) return { placements: null, exhaustive: true };
    }
    slice *= 2;
  }
}

/* =========================================================================
 * Karton prüfen
 * ========================================================================= */

/**
 * Kleinster Anteil der Grundfläche, mit dem ein Karton des Musters aufliegt (1 = alle voll).
 * @param {ConePlacement[]} P @returns {number}
 */
function coneMinSupport(P) {
  let m = 1;
  for (const p of P) {
    if (p.z <= CONE_EPS) continue;
    m = Math.min(m, supportShare(p, P.filter((q) => q !== p && Math.abs(q.z + q.dz - p.z) <= CONE_EPS)));
  }
  return m;
}

/**
 * Bestes gefundenes Muster für einen Karton im konischen Bin.
 * @param {number[]} cartonMM @param {ConeBin} bin @param {number} budgetMs
 * @param {(a: ConeAnalysis) => void} [onStep] Zwischenergebnis nach den Lagen
 * @returns {ConeAnalysis}
 */
function analyzeCone(cartonMM, bin, budgetMs, onStep) {
  const t0 = coneNow();
  const c = [...cartonMM].sort((a, b) => b - a);
  const H = coneHeight(bin);
  const upperVol = Math.floor(coneVolume(bin) / (c[0] * c[1] * c[2]) + 1e-9);
  const base = 0.1;
  const cb = c.map((v) => Math.max(1, Math.round(v / base)));
  const upperBox = upperBoundInt(cb, [bin.topL, bin.topW, H].map((v) => Math.floor(v / base + 1e-9)));
  const upper = Math.min(upperVol, upperBox, coneUpper(c, bin));
  /** @type {ConeAnalysis} */
  const res = { carton: c, count: 0, upper, status: upper <= 0 ? "optimal" : "open", placements: [], source: "leer", removed: 0, bottomCuboid: 0, topCuboid: 0, final: false };
  if (upper <= 0) { res.final = true; return res; }
  /** @param {ConePlacement[]} placed @param {"lagen" | "suche"} source @param {number} removed */
  const adopt = (placed, source, removed) => {
    if (placed.length > res.count && !coneCheck(bin, placed).length) {
      res.count = placed.length; res.placements = placed; res.source = source; res.removed = removed;
      if (res.count >= upper) res.status = "optimal";
    }
  };

  // 1. Lagen, erst ohne Suche (schnell), in der feinsten Genauigkeit, die der Aufwand erlaubt
  let unit = base;
  /** @type {LayerPlan | null} */ let plan = null;
  for (const u of [0.1, 0.5, 1, 2, 5, 10]) { unit = u; plan = coneLayers(c, bin, u, 0); if (plan) break; }
  const coarse = !plan;
  if (plan) { const b = coneBuild(bin, plan.slabs); adopt(b.placed, "lagen", b.removed); }
  else { const b = coneSettle(bin, coneGridLayers(c, bin)); adopt(b.placed, "lagen", b.removed); }
  if (!coarse) {
    const cu = c.map((v) => Math.max(1, Math.ceil(v / unit - 1e-9)));
    const t = dpTable(cu, [bin.topL, bin.topW, H].map((v) => Math.floor(v / unit + 1e-9)), false);
    if (t) {
      res.topCuboid = t.count;
      res.bottomCuboid = t.cellCount(Math.floor(bin.botL / unit + 1e-9), Math.floor(bin.botW / unit + 1e-9), Math.floor(H / unit + 1e-9));
    }
  }
  if (onStep) onStep({ ...res });

  // 2. Lagen mit Suche nach verschränkten Mustern
  const left = () => budgetMs - (coneNow() - t0);
  if (res.status === "open" && !coarse && left() > 100) {
    const p2 = coneLayers(c, bin, unit, Math.min(left() * 0.35, 1500));
    if (p2) { const b = coneBuild(bin, p2.slabs); adopt(b.placed, "lagen", b.removed); }
  }

  // 3. Freie Suche im Konus nach einem Karton mehr
  const su = Math.max(unit, base);
  const csu = c.map((v) => Math.max(1, Math.ceil(v / su - 1e-9)));
  while (res.status === "open" && !coarse && res.count + 1 <= Math.min(upper, 36) && left() > 50) {
    const r = coneFreeSearch(csu, bin, su, res.count + 1, left());
    if (!r.placements) { if (r.exhaustive) res.status = "searched"; break; }
    // mit echten Maßen neu aufbauen: gleiche Ecken, echte Kantenlängen
    const real = r.placements.map((p) => ({ ...p, dx: c[p.p[0]], dy: c[p.p[1]], dz: c[p.p[2]] }));
    const settled = coneSettle(bin, real);
    const before = res.count;
    adopt(settled.placed, "suche", 0);
    if (res.count === before) break;
  }
  res.final = true;
  return res;
}

if (typeof module !== "undefined") {
  module.exports = {
    CONE_DEFAULT, coneHeight, coneLen, coneWid, coneOffset, coneVolume, coneUpper, coneBinError, coneCheck, coneSettle,
    coneString, parseCone, coneLayers, coneBuild, coneSearch, coneFreeSearch, coneMinSupport, analyzeCone, coneNum, CONE_SUPPORT, CONE_MAX_MM
  };
}
