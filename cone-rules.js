"use strict";
/*
 * cone-rules.js
 * Regeln "when … then N" für den konischen Bin.
 * Braucht packcore.js und cone.js (im Browser und im Worker vorher geladen, in Node per require).
 *
 * Lagenmuster
 *   Ein Muster ist ein Blockbaum wie im Quader-Bin, aber mit festem Aufbau:
 *   außen Z(Lage, Lage, …), von unten nach oben. Jede Lage besteht aus Stapeln gleich
 *   gedrehter Kartons, die mit X(…) und Y(…) nebeneinander liegen. Alle Lagen außer der
 *   obersten sind oben eben (alle Stapel gleich hoch); nur die oberste darf Stapel
 *   unterschiedlicher Höhe enthalten.
 *
 * Lage im Bin
 *   Jede Lage liegt mittig im Bin. Eine höhere Lage darf länger und breiter sein als die
 *   Lage darunter und steht dann auf beiden Seiten gleich weit über.
 *
 * Bedingungen (alle linear in l, w, h)
 *   Wand:    Länge der Lage <= Bodenlänge + Steigung * Höhe der Unterkante
 *            und <= Länge der Öffnung (gerader Rand); genauso für die Breite.
 *   Höhe:    Summe der Lagenhöhen <= Gesamthöhe.
 *   Auflage: Jeder Karton einer oberen Lage liegt auf einem bestimmten Karton der Lage
 *            darunter, in beiden Richtungen mindestens CONE_SUPPORT mm. Welcher Karton
 *            das ist, wird an einem Bezugskarton festgelegt; deshalb gehört zu jedem
 *            Muster ein Bezugskarton. Weil die Lagen mittig liegen, kommen in diesen
 *            Bedingungen halbe Lagenlängen vor (Faktor 0.5).
 */

if (typeof module !== "undefined" && typeof coneLen === "undefined") {
  // eslint-disable-next-line no-var
  var { pruneTerms, addTerms, patternLayout, normalSet, parsePattern, patternString, numText, dot, reduceTree,
    polyVertices, simplifyTree, treeCount, termLE, layoutBlocks, upperBoundInt, gridSteps, lenText } = require("./packcore.js");
  // eslint-disable-next-line no-var
  var { coneHeight, coneLen, coneWid, coneCheck, parseCone, coneNum, analyzeCone, coneVolume } = require("./cone.js");
}

/** @type {number[][]} */
const CR_PERMS = typeof PERMS !== "undefined" ? PERMS : require("./packcore.js").PERMS;
/** @type {number} */
const CR_SUPPORT = typeof CONE_SUPPORT !== "undefined" ? CONE_SUPPORT : require("./cone.js").CONE_SUPPORT;
const CR_EDGE = "lwh";
/** @type {Record<string, number>} mm je Einheit */
const UNIT_MM_CR = { mm: 1, cm: 10, m: 1000 };
/** Ab so vielen Bedingungen wird nicht mehr geprüft, welche aus den anderen folgen */
const CR_MAX_LP_ROWS = 140;
/** @returns {number} */
const crNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * @typedef {{a: number[], b: number, p: number[], n: number[], kind: number}} ConeRow
 *   Bedingung a·(l,w,h) <= b. p und n sind die Anteile für die linke und rechte Seite der
 *   Textform (a = p - n). kind: 0 = Wand, 1 = Höhe, 2 = Auflage.
 * @typedef {{p: number[], n2: number, sx: number[][], sy: number[][]}} SymBox
 *   Stapel in einer Lage: Drehung, Kartons übereinander, Anfang entlang x und y als Termmengen
 * @typedef {{boxes: SymBox[], tx: number[][], ty: number[][]}} SymLayer
 * @typedef {{count: number, rows: ConeRow[], ok: boolean, ref: number[] | null}} ConeRule
 */

/* =========================================================================
 * Aufbau der Lagenmuster
 * ========================================================================= */

/** @param {TreeNode} root @returns {TreeNode[]} Lagen von unten nach oben */
function coneLayersOf(root) { return root.k === "S" && root.a === 2 ? root.c : [root]; }

/** @param {TreeNode} layer @returns {Leaf[]} alle Stapelblöcke einer Lage */
function layerLeaves(layer) {
  /** @type {Leaf[]} */ const out = [];
  /** @param {TreeNode} nd */
  const walk = (nd) => { if (nd.k === "G") out.push(nd); else if (nd.k === "S") nd.c.forEach(walk); };
  walk(layer);
  return out;
}

/** @param {Leaf} leaf @returns {number[]} Höhe des Stapels als Term */
function leafHeight(leaf) { const t = [0, 0, 0]; t[leaf.p[2]] = leaf.n[2]; return t; }

/**
 * Prüft, ob ein Blockbaum ein Lagenmuster für den konischen Bin ist.
 * @param {TreeNode} root @returns {string | null} Fehlertext oder null
 */
function coneLayerError(root) {
  const layers = coneLayersOf(root);
  for (let i = 0; i < layers.length; i++) {
    /** @type {string | null} */ let err = null;
    /** @param {TreeNode} nd */
    const walk = (nd) => {
      if (nd.k === "B") err = "Kartonlisten B(…) gibt es in Lagenmustern für den konischen Bin nicht.";
      else if (nd.k === "S") {
        if (nd.a === 2) err = "Z(…) steht nur ganz außen und trennt die Lagen. Innerhalb einer Lage wird mit dem dritten Wert des Blocks gestapelt, zum Beispiel 2x1x3:lwh.";
        else nd.c.forEach(walk);
      }
    };
    walk(layers[i]);
    if (err) return err;
    if (i < layers.length - 1) {
      const hs = layerLeaves(layers[i]).map((lf) => leafHeight(lf).join(","));
      if (new Set(hs).size > 1) return `Lage ${i + 1} ist oben nicht eben. Nur die oberste Lage darf Stapel unterschiedlicher Höhe enthalten.`;
    }
  }
  return null;
}

/** @param {number[]} t @param {number[]} u @returns {number[]} */
const crAdd = (t, u) => [t[0] + u[0], t[1] + u[1], t[2] + u[2]];
/** @param {number} e @param {number} k @returns {number[]} k-mal die Kante e */
const crUnit = (e, k) => { const t = [0, 0, 0]; t[e] = k; return t; };
/** @param {number[][]} S @param {number[]} c @returns {number} */
const crMax = (S, c) => { let m = -Infinity; for (const t of S) { const v = dot(t, c); if (v > m) m = v; } return m; };
/** @param {number[][]} S @param {number[]} c @returns {number[]} der Term, der bei c am größten ist */
const crArg = (S, c) => { let m = -Infinity, best = S[0]; for (const t of S) { const v = dot(t, c); if (v > m) { m = v; best = t; } } return best; };

/**
 * Stapel einer Lage mit ihrem Anfang als Termmengen (größter Term = Anfang).
 * @param {TreeNode} layer @returns {SymLayer}
 */
function layerSym(layer) {
  /** @type {SymBox[]} */ const boxes = [];
  /** @param {TreeNode} nd @param {number[][]} ox @param {number[][]} oy @returns {number[][][]} Ausdehnung [x, y] */
  const place = (nd, ox, oy) => {
    if (nd.k === "G") {
      for (let j = 0; j < nd.n[1]; j++) for (let i = 0; i < nd.n[0]; i++) {
        const dx = crUnit(nd.p[0], i), dy = crUnit(nd.p[1], j);
        boxes.push({ p: nd.p, n2: nd.n[2], sx: ox.map((t) => crAdd(t, dx)), sy: oy.map((t) => crAdd(t, dy)) });
      }
      return [[crUnit(nd.p[0], nd.n[0])], [crUnit(nd.p[1], nd.n[1])]];
    }
    if (nd.k !== "S" || nd.a === 2) throw new Error("Kein Lagenmuster.");
    /** @type {number[][]} */ let pos = nd.a === 0 ? ox : oy;
    /** @type {number[][]} */ let along = [[0, 0, 0]];
    /** @type {number[][]} */ const across = [];
    for (const kid of nd.c) {
      const s = nd.a === 0 ? place(kid, pos, oy) : place(kid, ox, pos);
      pos = addTerms(pos, s[nd.a]);
      along = addTerms(along, s[nd.a]);
      across.push(...s[1 - nd.a]);
    }
    return nd.a === 0 ? [along, pruneTerms(across)] : [pruneTerms(across), along];
  };
  const size = place(layer, [[0, 0, 0]], [[0, 0, 0]]);
  return { boxes, tx: size[0], ty: size[1] };
}

/**
 * Kartons eines Lagenmusters im Bin. Jede Lage liegt mittig.
 * @param {TreeNode} root @param {number[]} c sortierter Karton @param {ConeBin} bin @returns {ConePlacement[]}
 */
function coneLayout(root, c, bin) {
  /** @type {ConePlacement[]} */ const out = [];
  let z = 0;
  for (const layer of coneLayersOf(root)) {
    const P = patternLayout({ kind: "T", root: layer }, c);
    let ex = 0, ey = 0, top = 0;
    for (const q of P) { ex = Math.max(ex, q.x + q.dx); ey = Math.max(ey, q.y + q.dy); top = Math.max(top, q.z + q.dz); }
    const ox = (bin.topL - ex) / 2, oy = (bin.topW - ey) / 2;
    for (const q of P) out.push({ x: q.x + ox, y: q.y + oy, z: q.z + z, dx: q.dx, dy: q.dy, dz: q.dz, p: q.p });
    z += top;
  }
  return out;
}

/* =========================================================================
 * Bedingungen
 * ========================================================================= */

/**
 * Bereich, für den die Regeln gelten: l >= w >= h >= 1 mm.
 * @param {number} [minH] kleinste Kante in den Einheiten der Rechnung (1 mm)
 * @returns {Row[]}
 */
function coneDomainRows(minH = 1) {
  return [{ a: [-1, 1, 0], b: 0 }, { a: [0, -1, 1], b: 0 }, { a: [0, 0, -1], b: -minH }, { a: [1, 0, 0], b: 1e7 }];
}

/** @param {number[]} p @param {number[]} n @param {number} b @param {number} kind @returns {ConeRow} */
function crRow(p, n, b, kind) { return { a: [p[0] - n[0], p[1] - n[1], p[2] - n[2]], b, p, n, kind }; }

/** @param {ConeRow[]} rows @param {number[]} c @param {number} [eps] @returns {boolean} */
function rowsHold(rows, c, eps = 1e-9) {
  for (const r of rows) if (dot(r.a, c) > r.b + eps) return false;
  return true;
}

/** @param {ConeRow} p @param {ConeRow} q @returns {number} Reihenfolge in der Textform */
const rowOrder = (p, q) => (p.kind - q.kind) || (p.b - q.b) || (q.a[0] - p.a[0]) || (q.a[1] - p.a[1]) || (q.a[2] - p.a[2]);

/**
 * Spannen die Punkte eine Fläche auf (mindestens drei, nicht auf einer Geraden)?
 * @param {number[][]} pts @returns {boolean}
 */
function crSpansFace(pts) {
  if (pts.length < 3) return false;
  const o = pts[0];
  /** @type {number[] | null} */ let u = null;
  for (let i = 1; i < pts.length; i++) {
    const d = [pts[i][0] - o[0], pts[i][1] - o[1], pts[i][2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-5) continue;
    if (!u) { u = d.map((v) => v / len); continue; }
    const cx = u[1] * d[2] - u[2] * d[1], cy = u[2] * d[0] - u[0] * d[2], cz = u[0] * d[1] - u[1] * d[0];
    if (Math.hypot(cx, cy, cz) > 1e-5) return true;
  }
  return false;
}

/**
 * Entfernt doppelte Bedingungen und solche, die aus den anderen folgen (unter l >= w >= h >= 1).
 * Übrig bleiben die Bedingungen, die eine Seitenfläche des Bereichs bilden.
 * @param {ConeRow[]} rows @param {number} [minH] kleinste Kante in den Einheiten der Rechnung (1 mm)
 * @returns {ConeRow[]}
 */
function pruneRows(rows, minH = 1) {
  /** @type {Map<string, ConeRow>} */ const map = new Map();
  for (const r of rows) {
    // gleiche Ebene, egal mit welchem Faktor geschrieben: die strengere Fassung behalten
    const sc = Math.max(Math.abs(r.a[0]), Math.abs(r.a[1]), Math.abs(r.a[2]));
    if (sc < 1e-12) continue;
    // gilt ohnehin für jeden Karton mit l >= w >= h >= 1
    if (r.a[0] <= 1e-12 && r.a[0] + r.a[1] <= 1e-12 && (r.a[0] + r.a[1] + r.a[2]) * minH <= r.b + 1e-12 && r.a[0] + r.a[1] + r.a[2] <= 1e-12) continue;
    const key = r.a.map((v) => Math.round(v / sc * 1e8) / 1e8).join(",");
    const o = map.get(key);
    if (!o) { map.set(key, r); continue; }
    const so = Math.max(Math.abs(o.a[0]), Math.abs(o.a[1]), Math.abs(o.a[2]));
    const d = r.b / sc - o.b / so;
    if (d < -1e-10 || (Math.abs(d) <= 1e-10 && r.kind < o.kind)) map.set(key, r);
  }
  /** @type {ConeRow[]} */ let kept = [];
  for (const r of [...map.values()].sort((p, q) => (p.b - q.b) || (p.kind - q.kind))) {
    if (kept.some((k) => termLE(r.a, k.a) && k.b <= r.b + 1e-12)) continue;
    kept = kept.filter((k) => !(termLE(k.a, r.a) && r.b <= k.b + 1e-12));
    kept.push(r);
  }
  if (kept.length > CR_MAX_LP_ROWS) return kept.sort(rowOrder);
  const dom = coneDomainRows(minH);
  const verts = polyVertices(/** @type {Row[]} */ (kept).concat(dom));
  // leerer oder flacher Bereich: nichts weiter entfernen
  if (!crSpansFace(verts) || !verts.some((v) => kept.concat(/** @type {ConeRow[]} */ (dom)).some((r) => r.b - dot(r.a, v) > 1e-4 * (1 + Math.abs(r.b))))) return kept.sort(rowOrder);
  const flat = (/** @type {Row} */ r) => verts.every((v) => Math.abs(dot(r.a, v) - r.b) <= 1e-6 * (1 + Math.abs(r.b)));
  if (kept.some(flat) || dom.some(flat)) return kept.sort(rowOrder);
  return kept.filter((r) => crSpansFace(verts.filter((v) => Math.abs(dot(r.a, v) - r.b) <= 1e-6 * (1 + Math.abs(r.b))))).sort(rowOrder);
}

/**
 * Regel zu einem Lagenmuster. Die Auflage wird am Bezugskarton ref festgelegt. Ohne ref
 * wird ein passender Karton gesucht (möglichst groß).
 * @param {TreeNode} root @param {ConeBin} bin @param {number[] | null} [ref] sortiert
 * @returns {ConeRule} ok = false: am Bezugskarton liegt nicht jeder Karton auf
 */
function coneRule(root, bin, ref) {
  const layers = coneLayersOf(root);
  const H = coneHeight(bin);
  const slope = bin.coneH > 0;
  // Auflage und kleinste Kante sind in mm festgelegt; bin.unit sagt, wie viele mm eine Einheit hat
  const sup = CR_SUPPORT / (bin.unit || 1), minH = 1 / (bin.unit || 1);
  const kL = slope ? (bin.topL - bin.botL) / bin.coneH : 0, kW = slope ? (bin.topW - bin.botW) / bin.coneH : 0;
  /** @type {ConeRow[]} */ const fit = [];
  /** @type {SymLayer[]} */ const syms = [];
  /** @type {number[][]} */ const Z = [];
  /** @type {number[][]} */ const hs = [];
  let z = [0, 0, 0];
  layers.forEach((layer, k) => {
    const sym = layerSym(layer);
    syms.push(sym);
    Z.push(z);
    /** @param {number[][]} terms @param {number} slopeK @param {number} bot @param {number} top */
    const wall = (terms, slopeK, bot, top) => {
      for (const t of terms) {
        if (slope) fit.push(crRow(t, [slopeK * z[0], slopeK * z[1], slopeK * z[2]], bot, 0));
        if (!slope || k > 0) fit.push(crRow(t, [0, 0, 0], top, 0));
      }
    };
    wall(sym.tx, kL, bin.botL, bin.topL);
    wall(sym.ty, kW, bin.botW, bin.topW);
    const heights = pruneTerms(layerLeaves(layer).map(leafHeight));
    if (k === layers.length - 1) for (const t of heights) fit.push(crRow(crAdd(z, t), [0, 0, 0], H, 1));
    hs.push(heights[0]);
    z = crAdd(z, heights[0]);
  });
  const count = treeCount(root);

  /**
   * Auflage-Bedingungen, festgelegt am Karton c. Alle Positionen sind ab der Mitte des
   * Bins gemessen: Anfang eines Kartons = Anfang in der Lage - halbe Lagenlänge.
   * @param {number[]} c @returns {{rows: ConeRow[], ok: boolean}}
   */
  const support = (c) => {
    /** @type {ConeRow[]} */ const rows = [];
    let ok = true;
    /** @param {number[]} t @returns {number[]} */
    const half = (t) => [t[0] / 2, t[1] / 2, t[2] / 2];
    for (let k = 1; k < layers.length; k++) {
      const L = syms[k - 1], U = syms[k];
      const lex = crMax(L.tx, c) / 2, ley = crMax(L.ty, c) / 2, uex = crMax(U.tx, c) / 2, uey = crMax(U.ty, c) / 2;
      const lo = L.boxes.map((b) => { const x0 = crMax(b.sx, c) - lex, y0 = crMax(b.sy, c) - ley; return [x0, x0 + c[b.p[0]], y0, y0 + c[b.p[1]]]; });
      /** @type {Set<string>} */ const seen = new Set();
      for (const u of U.boxes) {
        const ux0 = crMax(u.sx, c) - uex, ux1 = ux0 + c[u.p[0]], uy0 = crMax(u.sy, c) - uey, uy1 = uy0 + c[u.p[1]];
        let best = -1, bs = -Infinity;
        for (let i = 0; i < lo.length; i++) {
          const q = lo[i];
          const s = Math.min(ux1 - q[0], q[1] - ux0, uy1 - q[2], q[3] - uy0) - sup;
          if (s > bs) { bs = s; best = i; }
        }
        if (best < 0 || bs < -1e-9) ok = false;
        if (best < 0) continue;
        const b = L.boxes[best];
        /**
         * @param {number} ax Richtung (0 = Länge, 1 = Breite)
         * @param {number[][]} us Anfang des oberen Kartons @param {number} ue seine Kante @param {number[][]} UT Länge der oberen Lage
         * @param {number[][]} bs2 Anfang des unteren Kartons @param {number} be seine Kante @param {number[][]} BT Länge der unteren Lage
         */
        const axis = (ax, us, ue, UT, bs2, be, BT) => {
          const key = ax + "|" + us.join(";") + "|" + ue + "|" + bs2.join(";") + "|" + be;
          if (seen.has(key)) return;
          seen.add(key);
          // Ende des oberen Kartons liegt hinter dem Anfang des unteren
          const r1 = crAdd(crAdd(crArg(us, c), crUnit(ue, 1)), half(crArg(BT, c)));
          for (const tu of UT) for (const vb of bs2) rows.push(crSupportRow(crAdd(half(tu), vb), r1, sup));
          // Ende des unteren Kartons liegt hinter dem Anfang des oberen
          const r2 = crAdd(crAdd(crArg(bs2, c), crUnit(be, 1)), half(crArg(UT, c)));
          for (const tb of BT) for (const vu of us) rows.push(crSupportRow(crAdd(half(tb), vu), r2, sup));
        };
        axis(0, u.sx, u.p[0], U.tx, b.sx, b.p[0], L.tx);
        axis(1, u.sy, u.p[1], U.ty, b.sy, b.p[1], L.ty);
      }
    }
    return { rows, ok };
  };

  if (layers.length === 1) return { count, rows: pruneRows(fit, minH), ok: true, ref: ref || null };
  /** @type {number[][]} */ let cands = [];
  if (ref) cands = [ref];
  else {
    const verts = polyVertices(/** @type {Row[]} */ (fit).concat(coneDomainRows(minH)));
    const big = coneExample(verts, fit, null);
    if (big) for (const f of [1, 0.97, 0.93, 0.88, 0.8, 0.7]) cands.push(big.map((v) => Math.max(1, Math.floor(v * f))));
    if (verts.length) cands.push([0, 1, 2].map((e) => verts.reduce((s, v) => s + v[e], 0) / verts.length));
  }
  /** @type {{rows: ConeRow[], ok: boolean} | null} */ let first = null;
  for (const c of cands) {
    if (!ref && !rowsHold(fit, c, 1e-7)) continue;
    const s = support(c);
    if (!first) first = s;
    if (s.ok) return { count, rows: pruneRows(fit.concat(s.rows), minH), ok: true, ref: c };
  }
  return { count, rows: pruneRows(fit.concat(first ? first.rows : []), minH), ok: false, ref: ref || null };
}

/** @param {number[]} left @param {number[]} right @param {number} sup Auflage @returns {ConeRow} left + sup <= right */
function crSupportRow(left, right, sup) {
  const net = [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
  return crRow(net.map((v) => Math.max(v, 0)), net.map((v) => Math.max(-v, 0)), -sup, 2);
}

/**
 * Großer Karton in ganzen mm, der alle Bedingungen erfüllt.
 * @param {number[][]} verts Ecken des Bereichs @param {ConeRow[]} rows @param {number[] | null} fallback
 * @returns {number[] | null}
 */
function coneExample(verts, rows, fallback) {
  /** @type {number[][]} */ const cand = [...verts];
  for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) {
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) cand.push([0, 1, 2].map((e) => verts[i][e] * (1 - f) + verts[j][e] * f));
  }
  if (verts.length) cand.push([0, 1, 2].map((e) => verts.reduce((s, v) => s + v[e], 0) / verts.length));
  if (fallback) cand.push(fallback);
  /** @type {number[] | null} */ let best = null;
  let bv = -1;
  for (const c of cand) {
    for (const up of [0, 1, 2, 3]) {
      // abrunden; hilft das nicht (Bedingungen mit Mindestmaß), einzelne Kanten aufrunden
      const r = c.map((v, e) => (up === e + 1 ? Math.ceil(v - 1e-7) : Math.floor(v + 1e-7)));
      if (!(r[2] >= 1 && r[1] >= r[2] && r[0] >= r[1])) continue;
      const v = r[0] * r[1] * r[2];
      if (v > bv && rowsHold(rows, r, 1e-7)) { bv = v; best = r; }
    }
  }
  return best;
}

/* =========================================================================
 * Textform
 * ========================================================================= */

/**
 * Zahl mit höchstens vier Nachkommastellen. Gerundet wird so, dass die Bedingung dadurch
 * höchstens strenger wird.
 * @param {number} v @param {boolean} up aufrunden @returns {string}
 */
function crNum(v, up) {
  const r = (up ? Math.ceil(v * 1e4 - 1e-6) : Math.floor(v * 1e4 + 1e-6)) / 1e4;
  return String(Math.round(r * 1e4) / 1e4);
}

/**
 * @param {ConeRow} row @param {string} [unit] Einheit der Maße ("mm", "cm" oder "m")
 * @returns {string} z. B. 3*w<=515+0.125*h
 */
function rowText(row, unit = "mm") {
  // Die Faktoren vor l, w, h haben keine Einheit; nur die festen Längen werden umgerechnet.
  const f = UNIT_MM_CR[unit] || 1;
  /** @param {number} v @param {boolean} up @returns {string} */
  const len = (v, up) => {
    const sc = f === 1 ? 1e4 : 1e6;
    const r = (up ? Math.ceil(v / f * sc - 1e-6) : Math.floor(v / f * sc + 1e-6)) / sc;
    return String(Math.round(r * sc) / sc);
  };
  /** @type {string[]} */ const left = [];
  /** @type {string[]} */ const right = [];
  for (let e = 0; e < 3; e++) {
    const s = crNum(row.p[e], true);
    if (s !== "0") left.push((s === "1" ? "" : s + "*") + CR_EDGE[e]);
  }
  if (row.b < -1e-9) left.push(len(-row.b, true));
  /** @type {string[]} */ const neg = [];
  for (let e = 0; e < 3; e++) {
    const s = crNum(row.n[e], false);
    if (s !== "0") neg.push((s === "1" ? "" : s + "*") + CR_EDGE[e]);
  }
  if (row.b > 1e-9 || (!neg.length && row.b >= -1e-9)) right.push(len(Math.max(0, row.b), false));
  right.push(...neg);
  if (!left.length) left.push("0");
  return left.join("+") + "<=" + right.join("+");
}

/** @param {ConeRow[]} rows @param {string} [unit] Einheit der Maße @returns {string} */
function rowsText(rows, unit) { return rows.map((r) => rowText(r, unit)).join(" and "); }

/** @param {ConeRow[]} rows @param {number} n @param {string} [unit] Einheit der Maße @returns {string} */
function coneRuleText(rows, n, unit) { return "when " + rowsText(rows, unit) + " then " + n; }

/** @param {ConeRow[]} rows @returns {string} */
function rowsKey(rows) { return rows.map((r) => r.a.map((v) => Math.round(v * 1e6) / 1e6).join(".") + "@" + Math.round(r.b * 1e6) / 1e6).sort().join("|"); }

/**
 * Textform eines Lagenmusters: K(Bezugskarton; Blockbaum), z. B. K(255x176x120; Z(2x1x1:lwh,3x1x2:wlh)).
 * @param {TreeNode} root @param {number[] | null} ref @returns {string}
 */
function coneLayerString(root, ref) {
  return "K(" + (ref ? ref.map(coneNum).join("x") + "; " : "") + patternString({ kind: "T", root }) + ")";
}

/**
 * @typedef {{kind: "layers", root: TreeNode, ref: number[] | null}
 *   | {kind: "placed", carton: number[], placements: ConePlacement[]}} ConeParsed
 */

/**
 * Liest ein Muster für den konischen Bin: ein Lagenmuster K(Karton; Z(…)) oder eine
 * Kartonliste K(Karton; Lage@x,y,z; …). Akzeptiert auch eine ganze Zeile "when … then N | Muster".
 * @param {string} input @returns {ConeParsed}
 */
function parseConeAny(input) {
  let s = String(input || "").trim();
  if (s.includes("|")) s = s.slice(s.lastIndexOf("|") + 1).trim();
  if (/^when\b/i.test(s)) throw new Error("Das ist nur eine Regel. Das Muster steht in der Liste hinter dem Zeichen |.");
  const t = s.replace(/\s+/g, "");
  const isTree = (/** @type {string} */ v) => /^(?:[XYZ]\(|\d+[x×*]\d+[x×*]\d+:)/i.test(v);
  /** @type {string | null} */ let tree = null;
  /** @type {number[] | null} */ let ref = null;
  const m = /^K\((.*)\)$/i.exec(t);
  if (m) {
    const parts = m[1].split(";").filter(Boolean);
    if (parts.length && isTree(parts[parts.length - 1])) {
      if (parts.length > 2) throw new Error("Ein Lagenmuster hat die Form K(Karton; Z(…)), zum Beispiel K(255x176x120; Z(2x1x1:lwh,3x1x2:wlh)).");
      tree = parts[parts.length - 1];
      if (parts.length === 2) {
        const dm = /^(\d+(?:[.,]\d+)?)[x×*](\d+(?:[.,]\d+)?)[x×*](\d+(?:[.,]\d+)?)$/i.exec(parts[0]);
        if (!dm) throw new Error("Vor dem Lagenmuster stehen die Maße des Bezugskartons, zum Beispiel 255x176x120.");
        ref = [dm[1], dm[2], dm[3]].map((v) => parseFloat(v.replace(",", "."))).sort((a, b) => b - a);
        if (ref.some((v) => !(v > 0))) throw new Error("Die Kartonmaße müssen größer als 0 sein.");
      }
    }
  } else if (isTree(t)) tree = t;
  if (tree === null) { const p = parseCone(s); return { kind: "placed", carton: p.carton, placements: p.placements }; }
  const pat = parsePattern(tree);
  if (pat.kind !== "T") throw new Error("Kein Lagenmuster.");
  const root = simplifyTree(pat.root);
  const err = coneLayerError(root);
  if (err) throw new Error(err);
  return { kind: "layers", root, ref };
}

/* =========================================================================
 * Bestes Lagenmuster für einen Karton
 * ========================================================================= */

/**
 * @typedef {{count: (X: number, Y: number) => number, tree: (X: number, Y: number) => TreeNode | null}} LayerTable
 */

/**
 * Beste Lage für jedes Rechteck: Stapel gleich gedrehter Kartons, mit Schnitten entlang
 * der Länge und der Breite nebeneinander gelegt.
 * @param {number[]} cu Karton in Einheiten (Index = Kante)
 * @param {{vals: number[], prevIdx: Int32Array}} sx mögliche Längen @param {{vals: number[], prevIdx: Int32Array}} sy mögliche Breiten
 * @param {number[]} mult Kartons übereinander je senkrechter Kante (0 = diese Kante steht nie senkrecht)
 * @returns {LayerTable}
 */
function layerTable(cu, sx, sy, mult) {
  const VX = sx.vals, VY = sy.vals, PX = sx.prevIdx, PY = sy.prevIdx;
  const nx = VX.length, ny = VY.length;
  const Lu = VX[nx - 1], Wu = VY[ny - 1];
  /** @type {{d0: number, d1: number, m: number, p: number[]}[]} */ const ors = [];
  /** @type {Map<string, number>} */ const seen = new Map();
  for (const p of CR_PERMS) {
    const m = mult[p[2]];
    const d0 = cu[p[0]], d1 = cu[p[1]];
    if (m < 1 || d0 > Lu || d1 > Wu) continue;
    const key = d0 + "," + d1;
    const i = seen.get(key);
    if (i === undefined) { seen.set(key, ors.length); ors.push({ d0, d1, m, p }); }
    else if (m > ors[i].m) ors[i] = { d0, d1, m, p };
  }
  if (!ors.length) return { count: () => 0, tree: () => null };
  const f = new Int32Array(nx * ny), ct = new Int8Array(nx * ny), ca = new Int32Array(nx * ny), nb = new Int32Array(nx * ny);
  for (let ix = 0; ix < nx; ix++) {
    const Xv = VX[ix];
    for (let iy = 0; iy < ny; iy++) {
      const Yv = VY[iy];
      const id = ix * ny + iy;
      let best = 0, t = 0, arg = -1, bn = 0;
      for (let o = 0; o < ors.length; o++) {
        const cnt = Math.floor(Xv / ors[o].d0) * Math.floor(Yv / ors[o].d1) * ors[o].m;
        if (cnt > best) { best = cnt; arg = o; bn = 1; }
      }
      for (let j = 1; j < nx && VX[j] * 2 <= Xv; j++) {
        const p = j * ny + iy, q = PX[Xv - VX[j]] * ny + iy;
        const v = f[p] + f[q];
        if (v > best || (v === best && v > 0 && nb[p] + nb[q] < bn)) { best = v; t = 1; arg = j; bn = nb[p] + nb[q]; }
      }
      for (let j = 1; j < ny && VY[j] * 2 <= Yv; j++) {
        const p = ix * ny + j, q = ix * ny + PY[Yv - VY[j]];
        const v = f[p] + f[q];
        if (v > best || (v === best && v > 0 && nb[p] + nb[q] < bn)) { best = v; t = 2; arg = j; bn = nb[p] + nb[q]; }
      }
      f[id] = best; ct[id] = t; ca[id] = arg; nb[id] = bn;
    }
  }
  /** @param {number} ix @param {number} iy @returns {TreeNode | null} */
  const rec = (ix, iy) => {
    const id = ix * ny + iy;
    if (f[id] === 0) return null;
    const t = ct[id], a = ca[id];
    if (t === 0) {
      const o = ors[a];
      return { k: "G", n: [Math.floor(VX[ix] / o.d0), Math.floor(VY[iy] / o.d1), o.m], p: o.p };
    }
    const k1 = t === 1 ? rec(a, iy) : rec(ix, a);
    const k2 = t === 1 ? rec(PX[VX[ix] - VX[a]], iy) : rec(ix, PY[VY[iy] - VY[a]]);
    /** @type {TreeNode[]} */ const kids = /** @type {TreeNode[]} */ ([k1, k2].filter(Boolean));
    return kids.length === 1 ? kids[0] : { k: "S", a: t - 1, c: kids };
  };
  /** @param {number} X @param {number} Y @returns {number[] | null} */
  const idx = (X, Y) => (X < 0 || Y < 0 ? null : [PX[Math.min(X, Lu)], PY[Math.min(Y, Wu)]]);
  return {
    count: (X, Y) => { const i = idx(X, Y); return i ? f[i[0] * ny + i[1]] : 0; },
    tree: (X, Y) => { const i = idx(X, Y); const t = i ? rec(i[0], i[1]) : null; return t ? simplifyTree(t) : null; }
  };
}

/** @param {TreeNode} nd @param {number} r @returns {TreeNode} dieselbe Lage, jeder Stapel r Kartons hoch */
function layerStack(nd, r) {
  if (nd.k === "G") return { k: "G", n: [nd.n[0], nd.n[1], r], p: nd.p };
  if (nd.k === "S") return { k: "S", a: nd.a, c: nd.c.map((k) => layerStack(k, r)) };
  return nd;
}

/**
 * @typedef {{cnt: number, tree: TreeNode | null, feet: number[][] | null}} LayerOpt
 *   feet: Grundflächen [x0, x1, y0, y1] der Stapel, gemessen ab der Mitte der Lage
 */

/**
 * Bestes Lagenmuster für einen Karton: ebene Lagen übereinander, jede so breit, wie der
 * Bin an ihrer Unterkante ist, und oben eine Lage aus Stapeln beliebiger Höhe.
 * Benachbarte Lagen werden nur kombiniert, wenn jeder Karton der oberen aufliegt.
 * @param {number[]} cartonMM @param {ConeBin} bin
 * @param {{enough?: number, workLimit?: number}} [opt] enough: ab dieser Anzahl reicht das erste Muster.
 *   workLimit: Aufwand, den die Rechnung höchstens treibt. Reicht er nicht, wird vereinfacht
 *   gerechnet (weniger Schnittpositionen, weniger Lagenfolgen); das Muster bleibt gültig.
 * @returns {{root: TreeNode, count: number, thinned: boolean, work: number, fullWork: number} | null}
 *   null, wenn nichts passt. thinned: vereinfacht gerechnet; work / fullWork: getriebener und voller Aufwand.
 */
function coneLayerPattern(cartonMM, bin, opt) {
  const c = [...cartonMM].sort((a, b) => b - a);
  const enough = (opt && opt.enough) || Infinity;
  const workLimit = (opt && opt.workLimit) || 6e7;
  const H = coneHeight(bin);
  const sup = CR_SUPPORT / (bin.unit || 1);
  const integral = c.every((v) => Math.abs(v - Math.round(v)) < 1e-9);
  for (const unit of [integral ? 1 : 0.1]) {
    const cu = c.map((v) => Math.max(1, Math.ceil(v / unit - 1e-9)));
    const shrink = Math.min(...c.map((v, i) => v / (cu[i] * unit)));
    const Lu = Math.floor(bin.topL / unit + 1e-9), Wu = Math.floor(bin.topW / unit + 1e-9), Hu = Math.floor(H / unit + 1e-9);
    const dims = [...new Set(cu)];
    const minE = Math.min(...cu);
    if (minE > Hu) return null;
    let sx = normalSet(Lu, dims), sy = normalSet(Wu, dims);
    /** @param {number} a @param {number} b @returns {number} */
    const workOf = (a, b) => a * b * (a + b) / 2;
    // etwa so viele Lagentabellen braucht die volle Rechnung: drei ebene und je Stapelhöhe eine
    const tablesFull = 3 + Math.min(60, cu.reduce((acc, e) => acc + Math.floor(Hu / e), 0));
    const fullWork = workOf(sx.vals.length, sy.vals.length) * tablesFull;
    let thinned = false;
    {
      // eine Tabelle darf höchstens ein Zwölftel des Aufwands kosten, sonst Schnittpositionen ausdünnen
      const cap = [sx.vals.length, sy.vals.length];
      while (workOf(cap[0], cap[1]) > workLimit / 12 && Math.max(cap[0], cap[1]) > 6) {
        const i = cap[0] >= cap[1] ? 0 : 1;
        cap[i] = Math.max(6, Math.floor(cap[i] * 0.88));
      }
      // der Boden-Querschnitt bleibt genau erhalten, dort liegt die unterste Lage
      if (cap[0] < sx.vals.length) { sx = normalSet(Lu, dims, cap[0], [Math.floor(coneLen(bin, 0) / unit + 1e-9)]); thinned = true; }
      if (cap[1] < sy.vals.length) { sy = normalSet(Wu, dims, cap[1], [Math.floor(coneWid(bin, 0) / unit + 1e-9)]); thinned = true; }
    }
    const tableWork = workOf(sx.vals.length, sy.vals.length);
    let work = 0, over = false;
    /** @type {Map<string, LayerTable>} */ const tables = new Map();
    /** @param {number[]} mult @returns {LayerTable | null} */
    const table = (mult) => {
      const key = mult.join(",");
      let t = tables.get(key);
      if (!t) {
        if (work + tableWork > workLimit) { over = true; return null; }
        work += tableWork;
        t = layerTable(cu, sx, sy, mult);
        tables.set(key, t);
      }
      return t;
    };
    /** @param {number} z @returns {number[]} Querschnitt in Einheiten, vorsichtig gerechnet */
    const cross = (z) => {
      const zr = z * unit * shrink;
      return [Math.floor(coneLen(bin, zr) / unit + 1e-9), Math.floor(coneWid(bin, zr) / unit + 1e-9)];
    };
    /**
     * @param {TreeNode | null} tree
     * @returns {number[][] | null} Grundflächen, ab der Mitte der Lage gemessen; null bei sehr
     *   vielen Kartons (dann wird die Auflage nicht geprüft und die Lage nur mit sich selbst gestapelt)
     */
    const feet = (tree) => {
      if (!tree) return [];
      if (layerLeaves(tree).reduce((acc, lf) => acc + lf.n[0] * lf.n[1], 0) > 4000) { over = true; return null; }
      const P = patternLayout({ kind: "T", root: tree }, c);
      let ex = 0, ey = 0;
      for (const q of P) { ex = Math.max(ex, q.x + q.dx); ey = Math.max(ey, q.y + q.dy); }
      return P.filter((q) => q.z < 1e-9).map((q) => [q.x - ex / 2, q.x + q.dx - ex / 2, q.y - ey / 2, q.y + q.dy - ey / 2]);
    };
    /** @param {number} z @param {number[]} X @returns {LayerOpt | null} oberste Lage ab Höhe z im Rechteck X */
    const tower = (z, X) => {
      const t = table(cu.map((e) => Math.floor((Hu - z) / e)));
      if (!t) return null;
      const cnt = t.count(X[0], X[1]);
      if (!cnt) return { cnt: 0, tree: null, feet: [] };
      const tree = t.tree(X[0], X[1]);
      return { cnt, tree, feet: feet(tree) };
    };
    /** @type {Map<number, LayerOpt | null>} */ const flatMemo = new Map();
    /** @param {number} z @param {number} e @returns {LayerOpt | null} ebene Lage ab Höhe z, Kante e senkrecht, ein Karton hoch */
    const flat = (z, e) => {
      const key = z * 3 + e;
      if (flatMemo.has(key)) return /** @type {LayerOpt | null} */ (flatMemo.get(key));
      /** @type {LayerOpt | null} */ let o = null;
      const t = table([0, 1, 2].map((i) => (i === e ? 1 : 0)));
      if (t) {
        const X = cross(z);
        const cnt = t.count(X[0], X[1]);
        const tree = cnt ? t.tree(X[0], X[1]) : null;
        o = { cnt, tree, feet: feet(tree) };
      }
      flatMemo.set(key, o);
      return o;
    };
    let ops = 0;
    /**
     * Liegt jeder Karton der oberen Lage auf einem der unteren auf?
     * @param {number[][] | null} lower @param {number[][] | null} upper @returns {boolean}
     */
    const rests = (lower, upper) => {
      if (!lower || !upper) return false;
      const s = sup + 1e-6;
      for (const u of upper) {
        let ok = false;
        for (const q of lower) {
          ops++;
          if (u[1] - q[0] >= s && q[1] - u[0] >= s && u[3] - q[2] >= s && q[3] - u[2] >= s) { ok = true; break; }
        }
        if (!ok) return false;
      }
      return true;
    };
    /** @typedef {{total: number, r: number, next: {kind: "flat", z: number, e: number} | {kind: "tower", opt: LayerOpt} | null}} Chain */
    /** @type {Map<number, Chain | null>} */ const memo = new Map();
    /** @param {number} z @param {number} e @returns {Chain | null} beste Folge ab einer ebenen Lage in Höhe z */
    const best = (z, e) => {
      const key = z * 3 + e;
      if (memo.has(key)) return /** @type {Chain | null} */ (memo.get(key));
      memo.set(key, null);
      const lo = flat(z, e);
      /** @type {Chain | null} */ let res = null;
      if (lo && lo.cnt > 0) {
        const rmax = Math.floor((Hu - z) / cu[e]);
        for (let r = rmax; r >= 1; r--) {
          const z2 = z + r * cu[e];
          const base = r * lo.cnt;
          if (!res || base > res.total) res = { total: base, r, next: null };
          if (z2 + minE > Hu) continue;
          if (over || ops > 4e6 || memo.size > 4000) { over = true; continue; }
          let tw = tower(z2, cross(z2));
          if (tw && tw.cnt > 0 && !rests(lo.feet, tw.feet)) tw = tower(z2, cross(z));
          if (tw && tw.cnt > 0 && base + tw.cnt > res.total && rests(lo.feet, tw.feet)) res = { total: base + tw.cnt, r, next: { kind: "tower", opt: tw } };
          for (let e2 = 0; e2 < 3; e2++) {
            if (e2 > 0 && cu[e2] === cu[e2 - 1]) continue;
            const g = best(z2, e2);
            if (!g || base + g.total <= res.total) continue;
            const up = flat(z2, e2);
            if (up && rests(lo.feet, up.feet)) res = { total: base + g.total, r, next: { kind: "flat", z: z2, e: e2 } };
          }
        }
      }
      memo.set(key, res);
      return res;
    };

    const t0 = tower(0, cross(0));
    if (!t0) continue;
    /** @type {TreeNode[]} */ let layers = t0.tree ? [t0.tree] : [];
    let count = t0.cnt;
    if (count < enough) {
      for (let e = 0; e < 3; e++) {
        if (e > 0 && cu[e] === cu[e - 1]) continue;
        const g = best(0, e);
        if (!g || g.total <= count) continue;
        /** @type {TreeNode[]} */ const ls = [];
        /** @type {Chain | null} */ let cur = g;
        let z = 0, ee = e;
        while (cur) {
          const o = /** @type {LayerOpt} */ (flat(z, ee));
          ls.push(layerStack(/** @type {TreeNode} */ (o.tree), cur.r));
          z += cur.r * cu[ee];
          const nx = cur.next;
          if (!nx) break;
          if (nx.kind === "tower") { ls.push(/** @type {TreeNode} */ (nx.opt.tree)); break; }
          ee = nx.e;
          cur = best(nx.z, nx.e);
        }
        layers = ls; count = g.total;
      }
    }
    if (!layers.length) return null;
    const root = layers.length === 1 ? layers[0] : simplifyTree({ k: "S", a: 2, c: layers });
    return { root, count: treeCount(root), thinned: thinned || over, work, fullWork };
  }
  return null;
}

/**
 * Entfernt Kartons von oben, bis nur noch target übrig sind, damit die Bedingungen
 * lockerer werden. Untere Lagen bleiben ganz, die Auflage bleibt also erhalten.
 * @param {TreeNode} root @param {number} target @param {number[]} c @param {ConeBin} bin @returns {TreeNode}
 */
function coneReduce(root, target, c, bin) {
  const layers = [...coneLayersOf(root)];
  let total = treeCount(root);
  while (layers.length > 1 && total - treeCount(layers[layers.length - 1]) >= target) total -= treeCount(/** @type {TreeNode} */ (layers.pop()));
  const top = layers[layers.length - 1];
  const below = total - treeCount(top);
  if (total > target) {
    let z = 0;
    for (let i = 0; i < layers.length - 1; i++) { const lf = layerLeaves(layers[i])[0]; z += lf.n[2] * c[lf.p[2]]; }
    layers[layers.length - 1] = reduceTree(top, target - below, c, [coneLen(bin, z), coneWid(bin, z), coneHeight(bin) - z]);
  }
  return layers.length === 1 ? layers[0] : simplifyTree({ k: "S", a: 2, c: layers });
}

/** Aufwand der schnellen Lagenmuster-Rechnung */
const CONE_QUICK_WORK = 3e7;
/** Bis zu so vielen Kartons (Obergrenze nach Volumen) läuft zusätzlich die Lagenrechnung aus cone.js mit Absenken und freier Suche */
const CONE_HEAVY_MAX = 800;
/** Bis zu so vielen Kartons enthält das Ergebnis jeden Karton einzeln; darüber nur das Lagenmuster */
const CONE_LIST_MAX = 1500;
/** Bis zu so vielen Kartons wird zum Lagenmuster die Regel abgeleitet */
const CONE_RULE_MAX = 400;

/**
 * Jeder Block eines Lagenmusters als ein Quader (count = Kartons darin). Für die Zeichnung
 * von Mustern mit sehr vielen Kartons.
 * @param {TreeNode} root @param {number[]} c sortierter Karton @param {ConeBin} bin
 * @returns {(ConePlacement & {count: number, n: number[]})[]}
 */
function coneBlockLayout(root, c, bin) {
  /** @type {(ConePlacement & {count: number, n: number[]})[]} */ const out = [];
  let z = 0;
  for (const layer of coneLayersOf(root)) {
    const B = layoutBlocks({ kind: "T", root: layer }, c);
    let ex = 0, ey = 0, top = 0;
    for (const q of B) { ex = Math.max(ex, q.x + q.dx); ey = Math.max(ey, q.y + q.dy); top = Math.max(top, q.z + q.dz); }
    const ox = (bin.topL - ex) / 2, oy = (bin.topW - ey) / 2;
    for (const q of B) out.push({ x: q.x + ox, y: q.y + oy, z: q.z + z, dx: q.dx, dy: q.dy, dz: q.dz, p: q.p, count: q.count, n: q.n });
    z += top;
  }
  return out;
}

/**
 * Bestes gefundenes Muster für einen Karton im konischen Bin.
 * Schnell (budgetMs = 0): das Lagenmuster aus coneLayerPattern, bei nicht zu vielen Kartons
 * zusätzlich die Lagenrechnung aus cone.js. Genau (budgetMs > 0): dazu verschränkte Lagen
 * und die freie Suche. Das Lagenmuster gewinnt, wenn es mindestens so viele Kartons schafft;
 * dann gehört zum Ergebnis eine Regel (layers enthält seine Textform).
 * @param {number[]} cartonMM @param {ConeBin} bin @param {number} budgetMs
 * @param {(a: ConeAnalysis) => void} [onStep] Zwischenergebnis
 * @param {{symWork?: number}} [opt] symWork: Aufwand, den die Lagenmuster-Rechnung höchstens treibt
 * @returns {ConeAnalysis}
 */
function analyzeConeLayers(cartonMM, bin, budgetMs, onStep, opt) {
  const c = [...cartonMM].sort((a, b) => b - a);
  const upperVol = Math.floor(coneVolume(bin) / (c[0] * c[1] * c[2]) + 1e-9);
  const heavy = upperVol <= CONE_HEAVY_MAX;
  const t0 = crNow();
  const lp = c[2] >= 1 ? coneLayerPattern(c, bin, { workLimit: (opt && opt.symWork) || CONE_QUICK_WORK }) : null;
  /** @type {DpEffort} */ const effort = { thinned: !!lp && lp.thinned, work: lp ? lp.work : 0, fullWork: lp ? lp.fullWork : 0, fullCells: 0, ms: crNow() - t0 };
  /** @type {{count: number, placements: ConePlacement[], layers: string | null, rule: boolean} | null} */ let sym = null;
  if (lp) {
    const listed = lp.count <= CONE_LIST_MAX;
    const placements = listed ? coneLayout(lp.root, c, bin) : [];
    const rule = lp.count <= CONE_RULE_MAX ? coneRule(lp.root, bin, c) : null;
    if ((!rule || (rule.ok && rowsHold(rule.rows, c, 1e-6))) && (!listed || !coneCheck(bin, placements).length)) {
      sym = { count: lp.count, placements, layers: coneLayerString(lp.root, c), rule: !!rule };
    }
  }
  /** @param {ConeAnalysis} a @returns {ConeAnalysis} */
  const merge = (a) => {
    const base = { ...a, approx: effort.thinned && a.status === "open", heavy, effort, layers: null, hasRule: false };
    if (!sym || sym.count < a.count || (!sym.rule && sym.count === a.count && a.count > 0)) return base;
    const status = sym.count >= a.upper ? "optimal" : sym.count > a.count ? "open" : a.status;
    return { ...base, count: sym.count, placements: sym.placements, source: "lagen", removed: 0, status, approx: effort.thinned && status === "open", layers: sym.layers, hasRule: sym.rule };
  };
  if (heavy) return merge(analyzeCone(c, bin, budgetMs, onStep ? (a) => onStep(merge(a)) : undefined));
  // sehr viele Kartons: nur das Lagenmuster, Obergrenze aus Volumen und Quader der Öffnung
  const base = 0.1;
  const cb = c.map((v) => Math.max(1, Math.round(v / base)));
  const upperBox = upperBoundInt(cb, [bin.topL, bin.topW, coneHeight(bin)].map((v) => Math.floor(v / base + 1e-9)));
  const upper = Math.min(upperVol, upperBox);
  return merge({ carton: c, count: 0, upper, status: upper <= 0 ? "optimal" : "open", placements: [], source: "leer", removed: 0, bottomCuboid: 0, topCuboid: 0, final: true });
}

/* =========================================================================
 * Regeln erzeugen
 * ========================================================================= */

/**
 * @typedef {{count: number, score: number, rows: ConeRow[], root: TreeNode, ref: number[], src: string,
 *   verts?: number[][], example?: number[] | null}} ConeGenRule
 */

/**
 * Erzeugt Regeln "when … then N" für alle Kartons l >= w >= h in ganzen mm.
 * Ablauf wie im Quader-Bin: einfache Gitter am Boden als Start, dann Abtasten entlang
 * von Linien und Nachrechnen mit coneLayerPattern, zum Schluss aufräumen.
 * Mit opt.res = 10 wird im cm-Raster gerechnet (Kartons in ganzen cm); die Regeln selbst
 * stehen in mm und gelten für jeden Karton.
 * @param {ConeBin} binMM @param {GenOptions & {workLimit?: number}} opt @param {(p: object) => void} [onProgress]
 */
function generateConeRules(binMM, opt, onProgress) {
  const t0 = crNow();
  const nmax = opt.nmax;
  const res = opt.res || 1;
  /** @type {ConeBin} */ const bin = res === 1 ? binMM
    : { topL: binMM.topL / res, topW: binMM.topW / res, rimH: binMM.rimH / res, botL: binMM.botL / res, botW: binMM.botW / res, coneH: binMM.coneH / res, unit: res };
  const minH = 1 / res;
  const H = coneHeight(bin);
  const [M0, M1, M2] = [bin.topL, bin.topW, H].sort((a, b) => b - a).map((v) => Math.floor(v + 1e-9));
  /** @type {ConeGenRule[]} */ const rules = [];
  /** @type {Set<string>} */ const keys = new Set();
  const stats = { probes: 0, lines: 0, dpMs: 0, dpFinds: 0, seeds: 0, growDp: 0, randomLines: 0 };
  let aborted = false;
  let lastReport = 0;
  /** @type {{R: number, score: Int32Array, start: Int32Array, co: Float64Array} | null} */ let comp = null;

  /** @param {TreeNode} root @param {string} src @param {number[]} ref @param {number[] | null} at @returns {boolean} */
  const addRule = (root, src, ref, at) => {
    const rule = coneRule(root, bin, ref);
    if (!rule.ok || !rowsHold(rule.rows, ref, 1e-6)) return false;
    if (at && !rowsHold(rule.rows, at, 1e-6)) return false;
    const score = Math.min(rule.count, nmax);
    const key = score + "#" + rowsKey(rule.rows);
    if (keys.has(key)) return false;
    keys.add(key);
    rules.push({ count: rule.count, score, rows: rule.rows, root, ref, src });
    comp = null;
    return true;
  };

  /** @param {ConeGenRule[]} list */
  const compileList = (list) => {
    let total = 0;
    for (const r of list) total += r.rows.length;
    const R = list.length;
    const score = new Int32Array(R), start = new Int32Array(R + 1), co = new Float64Array(total * 4);
    let k = 0;
    list.forEach((r, i) => {
      score[i] = r.score; start[i] = k;
      for (const c of r.rows) { co[4 * k] = c.a[0]; co[4 * k + 1] = c.a[1]; co[4 * k + 2] = c.a[2]; co[4 * k + 3] = c.b + 1e-9; k++; }
    });
    start[R] = k;
    return { R, score, start, co };
  };

  /**
   * Anzahl laut Regeln für jeden Punkt einer Linie. Anders als im Quader-Bin gilt eine
   * Regel auf der Linie für einen Abschnitt, der auch unten begrenzt sein kann.
   * @param {number} k @param {number[]} fixed @param {number} v0 @param {number} v1 @returns {Int32Array}
   */
  const lineCounts = (k, fixed, v0, v1) => {
    if (!comp) comp = compileList(rules);
    const { R, score, start, co } = comp;
    const len = v1 - v0 + 1;
    const best = new Int32Array(len);
    /** @type {Int32Array | null} */ let extra = null;
    for (let r = 0; r < R; r++) {
      let lo = -Infinity, hi = Infinity;
      for (let q = start[r]; q < start[r + 1]; q++) {
        const b = 4 * q;
        let rest = co[b + 3], ck = 0;
        for (let e = 0; e < 3; e++) { if (e === k) ck = co[b + e]; else rest -= co[b + e] * fixed[e]; }
        if (ck > 1e-12) { const v = rest / ck; if (v < hi) hi = v; }
        else if (ck < -1e-12) { const v = rest / ck; if (v > lo) lo = v; }
        else if (rest < 0) { hi = -Infinity; }
        if (hi < v0 || hi < lo) break;
      }
      if (hi < v0 || hi < lo) continue;
      const i0 = Math.max(v0, Math.ceil(lo - 1e-9)), i1 = Math.min(Math.floor(hi), v1);
      if (i1 < i0) continue;
      if (i0 === v0) { if (score[r] > best[i1 - v0]) best[i1 - v0] = score[r]; }
      else {
        if (!extra) extra = new Int32Array(len);
        for (let i = i0; i <= i1; i++) if (score[r] > extra[i - v0]) extra[i - v0] = score[r];
      }
    }
    for (let i = len - 2; i >= 0; i--) if (best[i + 1] > best[i]) best[i] = best[i + 1];
    if (extra) for (let i = 0; i < len; i++) if (extra[i] > best[i]) best[i] = extra[i];
    return best;
  };

  // 1. Startregeln: einfache Gitter auf dem Boden (nur die nicht dominierten)
  {
    const B0 = [coneLen(bin, 0), coneWid(bin, 0), H];
    /** @type {{u: number[], score: number, n: number[], p: number[], count: number}[]} */ const seeds = [];
    for (const p of CR_PERMS) {
      for (let a = 1; a <= nmax; a++) for (let b = 1; b <= nmax; b++) for (let c = 1; c <= nmax; c++) {
        const prod = a * b * c;
        const minimal = (a - 1) * b * c < nmax && a * (b - 1) * c < nmax && a * b * (c - 1) < nmax;
        if (prod > nmax && !minimal) continue;
        const n = [a, b, c];
        const u = [Infinity, Infinity, Infinity];
        for (let ax = 0; ax < 3; ax++) u[p[ax]] = B0[ax] / n[ax];
        u[1] = Math.min(u[1], u[0]); u[2] = Math.min(u[2], u[1]);
        if (u[2] < 1) continue;
        seeds.push({ u, score: Math.min(prod, nmax), n, p, count: prod });
      }
    }
    seeds.sort((x, y) => (y.score - x.score) || (x.count - y.count));
    /** @type {typeof seeds} */ const keptSeeds = [];
    for (const s of seeds) {
      if (keptSeeds.some((k) => k.score >= s.score && k.u[0] >= s.u[0] - 1e-9 && k.u[1] >= s.u[1] - 1e-9 && k.u[2] >= s.u[2] - 1e-9)) continue;
      keptSeeds.push(s);
    }
    for (const s of keptSeeds) if (addRule({ k: "G", n: s.n, p: s.p }, "grid", s.u.map((v) => Math.floor(v + 1e-9)), null)) stats.seeds++;
  }

  /** @type {Map<string, number>} */ const memo = new Map();
  /** @type {Map<string, number>} */ const dpMemo = new Map();

  /** @param {number[]} q @returns {{root: TreeNode, count: number} | null} */
  const solve = (q) => {
    const t1 = crNow();
    const r = coneLayerPattern(q, bin, { enough: nmax, workLimit: opt.workLimit });
    stats.dpMs += crNow() - t1;
    return r;
  };

  /** @param {number[]} q @returns {number} Anzahl laut Lagenmuster (gedeckelt) */
  const dpScore = (q) => {
    const key = q.join(",");
    const m = dpMemo.get(key);
    if (m !== undefined) return m;
    stats.growDp++;
    const r = solve(q);
    const sc = r ? Math.min(r.count, nmax) : 0;
    dpMemo.set(key, sc);
    return sc;
  };

  /**
   * Schiebt den Punkt in h-, w- und l-Richtung so weit hinaus, wie das Lagenmuster
   * noch sc Kartons schafft. Das Muster am Endpunkt deckt einen größeren Bereich ab.
   * @param {number[]} q @param {number} sc @returns {{root: TreeNode, count: number, at: number[]} | null}
   */
  const growPoint = (q, sc) => {
    const at = [...q];
    for (const k of [2, 1, 0]) {
      let lo = at[k];
      let top = k === 0 ? M0 : k === 1 ? Math.min(at[0], M1) : Math.min(at[1], M2);
      while (lo < top) {
        const mid = Math.floor((lo + top + 1) / 2);
        const p = [...at];
        p[k] = mid;
        if (dpScore(p) >= sc) lo = mid; else top = mid - 1;
      }
      at[k] = lo;
    }
    if (at[0] === q[0] && at[1] === q[1] && at[2] === q[2]) return null;
    const r = solve(at);
    if (!r || Math.min(r.count, nmax) < sc) return null;
    return { root: r.root, count: r.count, at };
  };

  /** @param {number[]} q @param {number} cur @returns {{root: TreeNode, count: number, at: number[]}[]} Kandidaten, bester zuerst */
  const solvePoint = (q, cur) => {
    const key = q.join(",");
    if (memo.has(key)) return [];
    stats.probes++;
    const r = solve(q);
    const sc = r ? Math.min(r.count, nmax) : 0;
    dpMemo.set(key, sc);
    memo.set(key, sc);
    if (!r || sc <= cur) return [];
    stats.dpFinds++;
    /** @type {{root: TreeNode, count: number, at: number[]}[]} */ const out = [];
    if (opt.grow) { const g = growPoint(q, sc); if (g) out.push(g); }
    out.push({ root: r.root, count: r.count, at: q });
    return out;
  };

  /** @param {number} k @param {number[]} fixed @param {number} v0 @param {number} v1 */
  const probeLine = (k, fixed, v0, v1) => {
    if (v1 < v0) return;
    stats.lines++;
    let cnt = lineCounts(k, fixed, v0, v1);
    let v = v0;
    for (let guard = 0; v <= v1 && guard < 600; guard++) {
      const c = cnt[v - v0];
      if (c < nmax) {
        const q = [...fixed];
        q[k] = v;
        let added = false;
        for (const cand of solvePoint(q, c)) {
          const root = cand.count > nmax ? coneReduce(cand.root, nmax, cand.at, bin) : cand.root;
          if (addRule(root, "dp", cand.at, q) || (root !== cand.root && addRule(cand.root, "dp", cand.at, q))) { added = true; break; }
        }
        if (added) {
          cnt = lineCounts(k, fixed, v0, v1);
          if (cnt[v - v0] > c) continue;
        }
      }
      let u = v + 1;
      while (u <= v1 && cnt[u - v0] === c) u++;
      v = u;
    }
  };

  /** @param {number} step @param {number} max @returns {number[]} */
  const gridVals = (step, max) => {
    /** @type {number[]} */ const out = [];
    for (let v = step; v <= max; v += step) out.push(v);
    if (!out.length || out[out.length - 1] !== max) out.push(max);
    return out;
  };

  // 2. Abtasten entlang von Linien in l-, w- und h-Richtung
  let seed = opt.seed || 20261002;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  /** @param {number} lo @param {number} hi @returns {number} */
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  /** @returns {{k: number, fixed: number[], v0: number, v1: number}} */
  const randomLine = () => {
    for (;;) {
      const k = randInt(0, 2);
      if (k === 0) { const h = randInt(1, M2), w = randInt(1, M1); if (w < h) continue; return { k, fixed: [0, w, h], v0: w, v1: M0 }; }
      if (k === 1) { const h = randInt(1, M2), l = randInt(1, M0); if (l < h) continue; const v1 = Math.min(l, M1); if (v1 < h) continue; return { k, fixed: [l, 0, h], v0: h, v1 }; }
      const w = randInt(1, M1), l = randInt(1, M0); if (l < w) continue; return { k, fixed: [l, w, 0], v0: 1, v1: Math.min(w, M2) };
    }
  };
  const passes = opt.passes;
  outer:
  for (let pi = 0; pi < passes.length; pi++) {
    const pass = passes[pi];
    if (pass.random) {
      let li = 0, sinceNew = 0;
      while (sinceNew < (pass.patience || 1500) && li < (pass.maxLines || Infinity)) {
        const L = randomLine();
        const before = rules.length;
        probeLine(L.k, L.fixed, L.v0, L.v1);
        li++;
        sinceNew = rules.length > before ? 0 : sinceNew + 1;
        const now = crNow();
        if (now - t0 > opt.maxMs) { aborted = true; break outer; }
        if (onProgress && now - lastReport > 250) {
          lastReport = now;
          onProgress({ phase: "random", pass: pi + 1, passes: passes.length, done: li, sinceNew, patience: pass.patience || 1500, rules: rules.length, probes: stats.probes, elapsed: now - t0, maxMs: opt.maxMs });
        }
      }
      stats.randomLines = li;
      continue;
    }
    const [s0, s1, s2] = gridSteps(/** @type {number} */ (pass.step), [M0, M1, M2]);
    const s = s0 * res;
    /** @type {{k: number, fixed: number[], v0: number, v1: number}[]} */ const lines = [];
    for (const h of gridVals(s2, M2)) for (const w of gridVals(s1, M1)) if (w >= h) lines.push({ k: 0, fixed: [0, w, h], v0: w, v1: M0 });
    for (const h of gridVals(s2, M2)) for (const l of gridVals(s0, M0)) if (l >= h) lines.push({ k: 1, fixed: [l, 0, h], v0: h, v1: Math.min(l, M1) });
    for (const w of gridVals(s1, M1)) for (const l of gridVals(s0, M0)) if (l >= w) lines.push({ k: 2, fixed: [l, w, 0], v0: 1, v1: Math.min(w, M2) });
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      probeLine(L.k, L.fixed, L.v0, L.v1);
      const now = crNow();
      if (now - t0 > opt.maxMs) { aborted = true; break outer; }
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress({ phase: "grid", pass: pi + 1, passes: passes.length, step: s, done: li + 1, total: lines.length, rules: rules.length, probes: stats.probes, elapsed: now - t0, maxMs: opt.maxMs });
      }
    }
  }

  // 3. Aufräumen: enthaltene Regeln entfernen
  if (onProgress) onProgress({ phase: "prune", rules: rules.length, elapsed: crNow() - t0 });
  const ordered = [...rules].sort((a, b) => (b.score - a.score) || (a.rows.length - b.rows.length) || (a.count - b.count));
  /** @type {ConeGenRule[]} */ const kept = [];
  for (const r of ordered) {
    r.verts = polyVertices(/** @type {Row[]} */ (r.rows).concat(coneDomainRows(minH)));
    if (!r.verts.length) continue;
    const V = r.verts;
    if (kept.some((k) => k.score >= r.score && V.every((v) => rowsHold(k.rows, v, 1e-7)))) continue;
    kept.push(r);
  }

  // 4. Nur Regeln behalten, die für mindestens einen Karton in ganzen mm entscheiden
  if (onProgress) onProgress({ phase: "sweep", rules: kept.length, elapsed: crNow() - t0 });
  const K = kept.length;
  const mark = new Uint8Array(K);
  {
    const { score, start, co } = compileList(kept);
    const nf = new Int32Array(M0 + 3), glo = new Int32Array(K), ghi = new Int32Array(K);
    /** @param {number} i @returns {number} nächste noch nicht entschiedene Länge */
    const find = (i) => { let j = i; while (nf[j] !== j) j = nf[j]; while (nf[i] !== j) { const n = nf[i]; nf[i] = j; i = n; } return j; };
    for (let h = 1; h <= M2; h++) {
      for (let w = h; w <= M1; w++) {
        const len = M0 - w + 1;
        if (len <= 0) continue;
        for (let i = 0; i <= len; i++) nf[i] = i;
        let remaining = len;
        /** @param {number} i @returns {boolean} */
        const paint = (i) => {
          let j = find(glo[i]), any = false;
          while (j <= ghi[i]) { nf[j] = j + 1; remaining--; any = true; j = find(j + 1); }
          return any;
        };
        let r = 0;
        while (r < K && remaining > 0) {
          const s = score[r], g0 = r;
          for (; r < K && score[r] === s; r++) {
            let lo = -Infinity, hi = Infinity;
            for (let q = start[r]; q < start[r + 1]; q++) {
              const b = 4 * q;
              const rest = co[b + 3] - co[b + 1] * w - co[b + 2] * h;
              if (co[b] > 1e-12) { const v = rest / co[b]; if (v < hi) hi = v; }
              else if (co[b] < -1e-12) { const v = rest / co[b]; if (v > lo) lo = v; }
              else if (rest < 0) hi = -Infinity;
              if (hi < w || hi < lo) break;
            }
            if (hi < w || hi < lo) { glo[r] = 1; ghi[r] = 0; continue; }
            glo[r] = Math.max(w, Math.ceil(lo - 1e-9)) - w;
            ghi[r] = Math.min(Math.floor(hi), M0) - w;
          }
          // erst Regeln, die schon gebraucht werden, dann von den übrigen jeweils die mit dem längsten Abschnitt
          for (let i = g0; i < r; i++) if (mark[i] && glo[i] <= ghi[i]) paint(i);
          while (remaining > 0) {
            let bi = -1, bl = 0;
            for (let i = g0; i < r; i++) {
              if (mark[i] || glo[i] > ghi[i]) continue;
              if (find(glo[i]) > ghi[i]) { glo[i] = 1; ghi[i] = 0; continue; }
              if (ghi[i] - glo[i] + 1 > bl) { bl = ghi[i] - glo[i] + 1; bi = i; }
            }
            if (bi < 0) break;
            paint(bi);
            mark[bi] = 1;
          }
        }
      }
    }
  }
  const final = kept.filter((_, i) => mark[i]);
  for (const r of final) {
    // zurück in mm: Konstanten der Bedingungen, Bezugs- und Beispielkarton
    const ex = coneExample(/** @type {number[][]} */ (r.verts), r.rows, r.ref);
    r.example = ex ? ex.map((v) => v * res) : null;
    if (res !== 1) {
      r.rows = r.rows.map((row) => crRow(row.p, row.n, row.b * res, row.kind));
      r.ref = r.ref.map((v) => v * res);
      r.verts = (r.verts || []).map((v) => v.map((x) => x * res));
    }
  }
  /** @param {number[] | null | undefined} c @returns {number} */
  const vol = (c) => (c ? c[0] * c[1] * c[2] : 0);
  final.sort((a, b) => (b.score - a.score) || (vol(b.example) - vol(a.example)));
  return {
    bin: binMM, nmax, res, rules: final, stats,
    meta: { passes: opt.passes, aborted, elapsedMs: crNow() - t0, candidates: rules.length }
  };
}

/* =========================================================================
 * Voreinstellungen, Datenformat und Textausgabe
 * ========================================================================= */

/** @type {Record<"fast" | "std" | "full", {label: string, passes: GenPass[], maxMs: number, workLimit: number}>} */
const CONE_QUALITY = {
  fast: { label: "Schnell", passes: [{ step: 40 }, { step: 20 }], maxMs: 180000, workLimit: 2e7 },
  std: { label: "Standard", passes: [{ step: 40 }, { step: 20 }, { random: true, patience: 1000 }], maxMs: 600000, workLimit: 4e7 },
  full: { label: "Gründlich", passes: [{ step: 40 }, { step: 20 }, { step: 10 }, { random: true, patience: 15000 }], maxMs: 2400000, workLimit: 6e7 }
};

/**
 * @param {"fast" | "std" | "full"} quality @param {number} nmax @param {number} [res] Raster in mm (1 oder 10)
 * @param {number} [maxMs] Zeitlimit, wenn es von der Voreinstellung abweichen soll
 * @returns {GenOptions & {workLimit: number}}
 */
function coneGenOptions(quality, nmax, res, maxMs) {
  const q = CONE_QUALITY[quality];
  return { nmax, passes: q.passes, searchMs: 0, searchMaxCount: nmax, maxMs: maxMs || q.maxMs, grow: true, workLimit: q.workLimit, res: res || 1 };
}

/**
 * Übliche Zahl der Löser-Aufrufe je Genauigkeit bei Höchstanzahl 30 (gemessen am Bin aus
 * der Zeichnung). Grundlage der Zeitschätzung.
 * @type {Record<"fast" | "std" | "full", number>}
 */
const CONE_GEN_CALLS = { fast: 52000, std: 140000, full: 165000 };

/**
 * Schätzt die Dauer der Regelerzeugung: misst den Lagenmuster-Löser an Stichproben und
 * rechnet mit der üblichen Zahl der Aufrufe hoch. Die Schätzung ist grob (Faktor 2).
 * @param {ConeBin} binMM @param {"fast" | "std" | "full"} quality @param {number} nmax @param {number} [res]
 * @returns {{ms: number, solveMs: number}}
 */
function estimateConeRulesMs(binMM, quality, nmax, res) {
  const r = res || 1;
  /** @type {ConeBin} */ const bin = { topL: binMM.topL / r, topW: binMM.topW / r, rimH: binMM.rimH / r, botL: binMM.botL / r, botW: binMM.botW / r, coneH: binMM.coneH / r, unit: r };
  const H = coneHeight(bin);
  const [M0, M1, M2] = [bin.topL, bin.topW, H].sort((a, b) => b - a).map((v) => Math.floor(v + 1e-9));
  const B0 = [coneLen(bin, 0), coneWid(bin, 0), H];
  let seed = 4711;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const t0 = crNow();
  let n = -4, sum = 0;
  // die ersten Messungen dienen nur dem Anlauf und zählen nicht
  for (let i = 0; i < 6000 && n < 60 && crNow() - t0 < 2500; i++) {
    const q = [1 + Math.floor(rand() * M0), 1 + Math.floor(rand() * M1), 1 + Math.floor(rand() * M2)].sort((a, b) => b - a);
    let g = 0;
    for (const p of CR_PERMS) g = Math.max(g, Math.floor(B0[0] / q[p[0]]) * Math.floor(B0[1] / q[p[1]]) * Math.floor(B0[2] / q[p[2]]));
    // geprüft wird vor allem dort, wo schon viele Kartons passen
    if (g < nmax / 4 || g >= nmax) continue;
    const t1 = crNow();
    coneLayerPattern(q, bin, { enough: nmax, workLimit: CONE_QUALITY[quality].workLimit });
    if (n >= 0) sum += crNow() - t1;
    n++;
  }
  const solveMs = n > 0 ? sum / n : 1;
  // mehr Regeln bei höherer Höchstanzahl, weniger Aufrufe auf einem groben Raster
  const f = Math.pow(nmax / 30, 1.4) * Math.min(1, Math.pow(M0 / 600, 0.8));
  // Schlussprüfung: jede Linie (w, h) gegen die Regeln
  const sweepMs = (M1 * M2 / 2) * 4500 * f * 2e-5;
  // die Stichprobe trifft schwerere Fälle als der Lauf im Mittel, deshalb der Faktor
  return { ms: f * CONE_GEN_CALLS[quality] * solveMs * 0.42 + sweepMs, solveMs };
}

/** @param {ConeBin} b @returns {string} z. B. "konisch-558x374x65-515x336x344" */
function coneBinKey(b) { return "konisch-" + [b.topL, b.topW, b.rimH].map(numText).join("x") + "-" + [b.botL, b.botW, b.coneH].map(numText).join("x"); }

/**
 * Gespeichertes Format einer Regelliste für den konischen Bin.
 * rules: [Anzahl gedeckelt, Kartons im Muster, Bedingungen flach [p0,p1,p2,n0,n1,n2,b,Art, …], Muster, Quelle]
 * @typedef {{cone: ConeBin, nmax: number, quality: string, res?: number, rules: [number, number, number[], string, string][],
 *   stats?: object, meta?: {aborted?: boolean}}} ConeRulesData
 * @typedef {{score: number, count: number, rows: ConeRow[], pat: string, src: string}} ConeStoredRule
 */

/** @param {ConeRow[]} rows @returns {number[]} */
function packRows(rows) { return rows.flatMap((r) => [...r.p, ...r.n, r.b, r.kind]); }

/** @param {number[]} flat @returns {ConeRow[]} */
function unpackRows(flat) {
  /** @type {ConeRow[]} */ const rows = [];
  for (let k = 0; k + 7 < flat.length; k += 8) {
    const row = crRow([flat[k], flat[k + 1], flat[k + 2]], [flat[k + 3], flat[k + 4], flat[k + 5]], flat[k + 6], flat[k + 7]);
    rows.push(row);
  }
  return rows;
}

/** @param {ReturnType<typeof generateConeRules>} res @param {string} quality @returns {ConeRulesData} */
function packConeRules(res, quality) {
  return {
    cone: res.bin, nmax: res.nmax, quality, res: res.res,
    rules: res.rules.map((r) => [r.score, r.count, packRows(r.rows), coneLayerString(r.root, r.ref), r.src]),
    stats: res.stats, meta: res.meta
  };
}

/** @param {ConeRulesData} data @returns {ConeStoredRule[]} */
function unpackConeRules(data) {
  return data.rules.map((r) => ({ score: Math.min(r[0], data.nmax), count: r[1], rows: unpackRows(r[2]), pat: r[3], src: r[4] || "" }));
}

/**
 * Regelliste als Text, eine Regel pro Zeile.
 * @param {ConeBin} bin @param {number} nmax @param {{score: number, rows: ConeRow[], pat: string}[]} rules @param {boolean} withPattern
 * @param {string} [unit] Einheit der Maße in den Regeln ("mm", "cm" oder "m"); die Muster nennen ihren Karton immer in mm
 * @returns {string}
 */
function coneRulesToText(bin, nmax, rules, withPattern, unit = "mm") {
  const L = (/** @type {number} */ v) => lenText(v, unit);
  const head = [
    `# Regeln für den konischen Bin: Öffnung ${L(bin.topL)} x ${L(bin.topW)} ${unit} mit ${L(bin.rimH)} ${unit} geradem Rand, Boden ${L(bin.botL)} x ${L(bin.botW)} ${unit}, konischer Teil ${L(bin.coneH)} ${unit} hoch`,
    `# Karton: l >= w >= h (längste, mittlere, kürzeste Kante), alle Maße in ${unit}. Es gilt die höchste Anzahl aller erfüllten Regeln.`,
    `# "then ${nmax}" bedeutet ${nmax} oder mehr.${withPattern ? ` Hinter | steht das Packmuster${unit === "mm" ? "" : "; der Karton darin steht in mm"}.` : ""}`
  ];
  return head.concat(rules.map((r) => {
    const t = coneRuleText(r.rows, Math.min(r.score, nmax), unit);
    return withPattern ? `${t} | ${r.pat}` : t;
  })).join("\n") + "\n";
}

/**
 * Anzahl laut Regelliste für einen Karton (sortiert), mit Index der Regel.
 * @param {{score: number, rows: ConeRow[]}[]} rules @param {number[]} c @returns {{score: number, index: number}}
 */
function lookupConeRules(rules, c) {
  let best = 0, idx = -1;
  rules.forEach((r, i) => { if (r.score > best && rowsHold(r.rows, c, 1e-7)) { best = r.score; idx = i; } });
  return { score: best, index: idx };
}

if (typeof module !== "undefined") {
  module.exports = {
    coneLayersOf, coneLayerError, coneDomainRows, layerSym, coneLayout, coneRule, rowsHold, pruneRows, coneExample, rowText, rowsText, coneRuleText,
    coneLayerString, parseConeAny, layerTable, coneLayerPattern, analyzeConeLayers, coneReduce, generateConeRules, CONE_QUALITY, coneGenOptions,
    coneBinKey, packConeRules, unpackConeRules, coneRulesToText, lookupConeRules, packRows, unpackRows,
    coneBlockLayout, estimateConeRulesMs, CONE_QUICK_WORK, CONE_HEAVY_MAX, CONE_LIST_MAX, CONE_RULE_MAX
  };
}
