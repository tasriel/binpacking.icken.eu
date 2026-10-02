"use strict";
/*
 * packcore.js
 * Packmuster, Regeln und Regelerzeugung für gleiche Kartons in einem Bin.
 *
 * Konventionen
 *   Bin-Achsen:   0 = X (Länge L), 1 = Y (Breite B), 2 = Z (Höhe H).
 *   Kartonkanten: sortiert, 0 = l (längste), 1 = w (mittlere), 2 = h (kürzeste).
 *   Lage p:       p[a] = Kartonkante, die entlang Bin-Achse a liegt.
 *   Term t:       [a, b, c] steht für a*l + b*w + c*h.
 *   Regel:        alle Bedingungen t·(l,w,h) <= D (D = Bin-Maß der Achse) erfüllt
 *                 -> das Muster passt, also mindestens count Kartons.
 *
 * Ein Muster ist entweder
 *   - ein Blockbaum (kind "T"): Blöcke aus gleich gedrehten Kartons, die entlang
 *     einer Achse hintereinander liegen, beliebig geschachtelt, oder
 *   - eine Kartonliste mit Vorgängern (kind "B"): jeder Karton liegt entlang einer
 *     Achse hinter seinen Vorgängern. Damit lassen sich auch verschränkte Muster
 *     beschreiben, die sich nicht in Blöcke zerlegen lassen.
 * In beiden Fällen ergibt sich die Lage jedes Kartons als längster Weg; deshalb
 * sind die Bedingungen immer Summen von Kartonkanten <= Bin-Maß.
 */

/** @typedef {{k: "G", n: number[], p: number[]}} Leaf */
/** @typedef {{k: "S", a: number, c: TreeNode[]}} Split */
/** @typedef {{p: number[], pred: number[][]}} DagBox */
/** @typedef {{k: "B", boxes: DagBox[]}} DagNode */
/** @typedef {Leaf | Split | DagNode} TreeNode */
/** @typedef {{kind: "T", root: TreeNode} | {kind: "B", boxes: DagBox[]}} Pattern */
/** @typedef {{t: number[], ax: number, D: number}} Con */
/** @typedef {{count: number, cons: Con[]}} Rule */
/** @typedef {{x: number, y: number, z: number, dx: number, dy: number, dz: number, p: number[]}} Placement */
/** @typedef {{a: number[], b: number}} Row  a·c <= b */

const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const EDGE_CH = "lwh";
const AXIS_CH = "XYZ";
/** @returns {number} */
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/* =========================================================================
 * Terme (Max-Plus-Mengen linearer Ausdrücke in l, w, h)
 * ========================================================================= */

/**
 * t·c <= u·c für alle l >= w >= h >= 0.
 * @param {number[]} t @param {number[]} u @returns {boolean}
 */
function termLE(t, u) {
  return t[0] <= u[0] && t[0] + t[1] <= u[0] + u[1] && t[0] + t[1] + t[2] <= u[0] + u[1] + u[2];
}

/** @param {number[][]} terms @returns {number[][]} nur die nicht dominierten Terme */
function pruneTerms(terms) {
  /** @type {number[][]} */ const out = [];
  for (const t of terms) {
    let dominated = false;
    for (const u of out) if (termLE(t, u)) { dominated = true; break; }
    if (dominated) continue;
    for (let i = out.length - 1; i >= 0; i--) if (termLE(out[i], t)) out.splice(i, 1);
    out.push(t);
  }
  return out;
}

/** @param {number[][]} A @param {number[][]} B @returns {number[][]} */
function addTerms(A, B) {
  /** @type {number[][]} */ const out = [];
  for (const a of A) for (const b of B) out.push([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  return pruneTerms(out);
}

/** @param {number[]} t @param {number[]} c @returns {number} */
function dot(t, c) { return t[0] * c[0] + t[1] * c[1] + t[2] * c[2]; }

/* =========================================================================
 * Muster: Anzahl, Terme, Anordnung
 * ========================================================================= */

/** @param {TreeNode} n @returns {number} */
function treeCount(n) {
  if (n.k === "G") return n.n[0] * n.n[1] * n.n[2];
  if (n.k === "B") return n.boxes.length;
  return n.c.reduce((s, k) => s + treeCount(k), 0);
}

/** @param {TreeNode} n @returns {number[][][]} Terme je Achse */
function treeTerms(n) {
  if (n.k === "B") return dagTerms(n.boxes);
  if (n.k === "G") {
    return [0, 1, 2].map((a) => { const t = [0, 0, 0]; t[n.p[a]] = n.n[a]; return [t]; });
  }
  const kids = n.c.map(treeTerms);
  return [0, 1, 2].map((a) => {
    if (a === n.a) {
      /** @type {number[][]} */ let acc = kids[0][a];
      for (let i = 1; i < kids.length; i++) acc = addTerms(acc, kids[i][a]);
      return acc;
    }
    return pruneTerms(kids.flatMap((k) => k[a]));
  });
}

/**
 * Topologische Reihenfolge der Kartons entlang einer Achse.
 * @param {DagBox[]} boxes @param {number} a @returns {number[]}
 */
function dagOrder(boxes, a) {
  const n = boxes.length;
  const state = new Uint8Array(n);
  /** @type {number[]} */ const out = [];
  /** @param {number} i */
  const visit = (i) => {
    if (state[i] === 2) return;
    if (state[i] === 1) throw new Error(`Die Vorgänger entlang ${"xyz"[a]} bilden einen Kreis.`);
    state[i] = 1;
    for (const q of boxes[i].pred[a]) visit(q);
    state[i] = 2;
    out.push(i);
  };
  for (let i = 0; i < n; i++) visit(i);
  return out;
}

/** @param {DagBox[]} boxes @returns {number[][][]} */
function dagTerms(boxes) {
  return [0, 1, 2].map((a) => {
    /** @type {number[][][]} */ const E = new Array(boxes.length);
    /** @type {number[][]} */ const all = [];
    for (const i of dagOrder(boxes, a)) {
      const e = [0, 0, 0];
      e[boxes[i].p[a]] = 1;
      const preds = boxes[i].pred[a];
      const base = preds.length ? pruneTerms(preds.flatMap((q) => E[q])) : [[0, 0, 0]];
      E[i] = base.map((t) => [t[0] + e[0], t[1] + e[1], t[2] + e[2]]);
      all.push(...E[i]);
    }
    return pruneTerms(all);
  });
}

/** @param {Pattern} pat @returns {boolean} */
function patternHasDag(pat) {
  if (pat.kind === "B") return true;
  /** @param {TreeNode} n @returns {boolean} */
  const has = (n) => n.k === "B" || (n.k === "S" && n.c.some(has));
  return has(pat.root);
}

/** @param {Pattern} pat @returns {number} */
function patternCount(pat) { return pat.kind === "T" ? treeCount(pat.root) : pat.boxes.length; }

/** @param {Pattern} pat @returns {number[][][]} */
function patternTerms(pat) { return pat.kind === "T" ? treeTerms(pat.root) : dagTerms(pat.boxes); }

/** @param {TreeNode} root @param {number[]} c @returns {Placement[]} */
function layoutTree(root, c) {
  /** @type {Placement[]} */ const out = [];
  /** @param {TreeNode} nd @param {number[]} o @returns {number[]} */
  const place = (nd, o) => {
    if (nd.k === "B") {
      const size = [0, 0, 0];
      for (const q of layoutDag(nd.boxes, c)) {
        out.push({ ...q, x: q.x + o[0], y: q.y + o[1], z: q.z + o[2] });
        size[0] = Math.max(size[0], q.x + q.dx); size[1] = Math.max(size[1], q.y + q.dy); size[2] = Math.max(size[2], q.z + q.dz);
      }
      return size;
    }
    if (nd.k === "G") {
      const d = [c[nd.p[0]], c[nd.p[1]], c[nd.p[2]]];
      for (let k = 0; k < nd.n[2]; k++) for (let j = 0; j < nd.n[1]; j++) for (let i = 0; i < nd.n[0]; i++) {
        out.push({ x: o[0] + i * d[0], y: o[1] + j * d[1], z: o[2] + k * d[2], dx: d[0], dy: d[1], dz: d[2], p: nd.p });
      }
      return [nd.n[0] * d[0], nd.n[1] * d[1], nd.n[2] * d[2]];
    }
    const size = [0, 0, 0];
    const pos = [...o];
    for (const kid of nd.c) {
      const s = place(kid, pos);
      pos[nd.a] += s[nd.a];
      size[nd.a] += s[nd.a];
      for (let a = 0; a < 3; a++) if (a !== nd.a) size[a] = Math.max(size[a], s[a]);
    }
    return size;
  };
  place(root, [0, 0, 0]);
  return out;
}

/** @param {DagBox[]} boxes @param {number[]} c @returns {Placement[]} */
function layoutDag(boxes, c) {
  const d = boxes.map((b) => [c[b.p[0]], c[b.p[1]], c[b.p[2]]]);
  const pos = boxes.map(() => [0, 0, 0]);
  for (let a = 0; a < 3; a++) {
    for (const i of dagOrder(boxes, a)) {
      let m = 0;
      for (const q of boxes[i].pred[a]) m = Math.max(m, pos[q][a] + d[q][a]);
      pos[i][a] = m;
    }
  }
  return boxes.map((b, i) => ({ x: pos[i][0], y: pos[i][1], z: pos[i][2], dx: d[i][0], dy: d[i][1], dz: d[i][2], p: b.p }));
}

/** @param {Pattern} pat @param {number[]} c sortierter Karton @returns {Placement[]} */
function patternLayout(pat, c) { return pat.kind === "T" ? layoutTree(pat.root, c) : layoutDag(pat.boxes, c); }

/* =========================================================================
 * Regeln: Bedingungen ableiten und vereinfachen
 * ========================================================================= */

const BIG = 1e7;

/** @returns {Row[]} l >= w >= h >= 0 und eine große Schranke für l */
function domainRows() {
  return [{ a: [-1, 1, 0], b: 0 }, { a: [0, -1, 1], b: 0 }, { a: [0, 0, -1], b: 0 }, { a: [1, 0, 0], b: BIG }];
}

/** @param {Row} r1 @param {Row} r2 @param {Row} r3 @returns {number[] | null} */
function solve3(r1, r2, r3) {
  const [a, b, c] = r1.a, [d, e, f] = r2.a, [g, h, i] = r3.a;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const y1 = r1.b, y2 = r2.b, y3 = r3.b;
  const x = (y1 * (e * i - f * h) - b * (y2 * i - f * y3) + c * (y2 * h - e * y3)) / det;
  const y = (a * (y2 * i - f * y3) - y1 * (d * i - f * g) + c * (d * y3 - y2 * g)) / det;
  const z = (a * (e * y3 - y2 * h) - b * (d * y3 - y2 * g) + y1 * (d * h - e * g)) / det;
  return [x, y, z];
}

/** @param {Row[]} rows @returns {number[][]} Ecken des Polyeders */
function polyVertices(rows) {
  /** @type {number[][]} */ const V = [];
  const n = rows.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const p = solve3(rows[i], rows[j], rows[k]);
    if (!p) continue;
    let ok = true;
    for (const r of rows) if (dot(r.a, p) > r.b + 1e-7 * (1 + Math.abs(r.b))) { ok = false; break; }
    if (!ok) continue;
    if (V.some((v) => Math.abs(v[0] - p[0]) < 1e-7 && Math.abs(v[1] - p[1]) < 1e-7 && Math.abs(v[2] - p[2]) < 1e-7)) continue;
    V.push(p);
  }
  return V;
}

/** @param {number[]} obj @param {Row[]} rows @returns {number} */
function lpMax(obj, rows) {
  let m = -Infinity;
  for (const v of polyVertices(rows)) m = Math.max(m, dot(obj, v));
  return m;
}

/** @param {Con} k @returns {number} */
const conWeight = (k) => k.t[0] * 3 + k.t[1] * 2 + k.t[2];

/** @param {Con} p @param {Con} q @returns {number} */
const conOrder = (p, q) => (p.D - q.D) || (p.ax - q.ax) || (q.t[0] - p.t[0]) || (q.t[1] - p.t[1]) || (q.t[2] - p.t[2]);

/**
 * Entfernt Bedingungen, die aus anderen folgen (unter l >= w >= h >= 0).
 * @param {Con[]} cons @returns {Con[]}
 */
function pruneCons(cons) {
  /** @type {Con[]} */ let kept = [];
  const sorted = [...cons].sort((p, q) => (p.D - q.D) || (conWeight(q) - conWeight(p)));
  for (const c of sorted) {
    if (kept.some((k) => termLE(c.t, k.t) && k.D <= c.D + 1e-12)) continue;
    kept = kept.filter((k) => !(termLE(k.t, c.t) && c.D <= k.D + 1e-12));
    kept.push(c);
  }
  kept.sort((p, q) => conWeight(q) - conWeight(p));
  for (let i = 0; i < kept.length && kept.length > 1;) {
    const rows = kept.filter((_, j) => j !== i).map((k) => ({ a: k.t, b: k.D })).concat(domainRows());
    if (lpMax(kept[i].t, rows) <= kept[i].D + 1e-9) kept.splice(i, 1); else i++;
  }
  return kept.sort(conOrder);
}

/** @param {number[][][]} S @param {number[]} bin @returns {Con[]} */
function termsToCons(S, bin) {
  /** @type {Con[]} */ const cons = [];
  S.forEach((terms, a) => terms.forEach((t) => cons.push({ t, ax: a, D: bin[a] })));
  return cons;
}

/** @param {Pattern} pat @param {number[]} bin @returns {Rule} */
function patternRule(pat, bin) {
  return { count: patternCount(pat), cons: pruneCons(termsToCons(patternTerms(pat), bin)) };
}

/** @param {Con[]} cons @param {number[]} c sortiert @param {number} [eps] @returns {boolean} */
function consHold(cons, c, eps = 1e-9) {
  for (const k of cons) if (dot(k.t, c) > k.D + eps) return false;
  return true;
}

/**
 * Wie weit sich der Karton gleichmäßig vergrößern ließe (1 = genau an der Grenze).
 * @param {number[][][]} S @param {number[]} bin @param {number[]} c @returns {number}
 */
function scaleSlack(S, bin, c) {
  let s = Infinity;
  S.forEach((terms, a) => terms.forEach((t) => { const v = dot(t, c); if (v > 0) s = Math.min(s, bin[a] / v); }));
  return s;
}

/** @param {number[]} t @returns {string} */
function termText(t) {
  /** @type {string[]} */ const parts = [];
  for (let e = 0; e < 3; e++) if (t[e]) parts.push((t[e] === 1 ? "" : t[e] + "*") + EDGE_CH[e]);
  return parts.join("+");
}

/** @param {number} v @returns {string} */
function numText(v) {
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}

/** @param {Con[]} cons @returns {string} */
function consText(cons) { return cons.map((k) => termText(k.t) + "<=" + numText(k.D)).join(" and "); }

/** @param {Con[]} cons @param {number} n @returns {string} */
function ruleText(cons, n) { return "when " + consText(cons) + " then " + n; }

/** @param {Con[]} cons @returns {string} */
function consKey(cons) { return cons.map((k) => k.t.join(".") + "@" + k.ax).sort().join("|"); }

/** @param {Con[]} cons @returns {number[][]} Ecken des Regelbereichs */
function regionVertices(cons) {
  return polyVertices(cons.map((k) => ({ a: k.t, b: k.D })).concat(domainRows()));
}

/** @param {number[][]} verts @param {Con[]} cons @returns {boolean} Bereich liegt ganz in cons */
function verticesInside(verts, cons) {
  for (const v of verts) for (const k of cons) if (dot(k.t, v) > k.D + 1e-7) return false;
  return true;
}

/**
 * Größter Karton (Volumen) im Regelbereich, auf ganze mm abgerundet.
 * @param {number[][]} verts @param {number} [step] @returns {number[] | null}
 */
function exampleCarton(verts, step = 1) {
  /** @type {number[][]} */ const cand = [...verts];
  for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) {
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) cand.push([0, 1, 2].map((e) => verts[i][e] * (1 - f) + verts[j][e] * f));
  }
  let best = null, bv = -1;
  for (const c of cand) {
    const v = c[0] * c[1] * c[2];
    if (v > bv) { bv = v; best = c; }
  }
  if (!best) return null;
  const r = best.map((v) => Math.floor(v / step + 1e-7) * step);
  if (r[2] <= 0) return null;
  return r;
}

/* =========================================================================
 * Textform der Muster
 * ========================================================================= */

/** @param {number[]} p @returns {string} */
const permText = (p) => p.map((e) => EDGE_CH[e]).join("");

/** @param {TreeNode} n @returns {string} */
function treeString(n) {
  if (n.k === "B") return dagString(n.boxes);
  if (n.k === "G") return n.n.join("x") + ":" + permText(n.p);
  return AXIS_CH[n.a] + "(" + n.c.map(treeString).join(",") + ")";
}

/**
 * Erreichbarkeit entlang jeder Achse.
 * @param {DagBox[]} boxes @returns {Uint8Array[][]} R[a][i][j] = 1, wenn i vor j liegt
 */
function dagReach(boxes) {
  const n = boxes.length;
  return [0, 1, 2].map((a) => {
    const R = Array.from({ length: n }, () => new Uint8Array(n));
    for (const i of dagOrder(boxes, a)) {
      for (const q of boxes[i].pred[a]) {
        R[q][i] = 1;
        for (let u = 0; u < n; u++) if (R[u][q]) R[u][i] = 1;
      }
    }
    return R;
  });
}

/** @param {DagBox[]} boxes @returns {string} */
function dagString(boxes) {
  const R = dagReach(boxes);
  return "B(" + boxes.map((b, i) => {
    const parts = [permText(b.p)];
    for (let a = 0; a < 3; a++) {
      const preds = b.pred[a].filter((q) => !b.pred[a].some((r) => r !== q && R[a][q][r]));
      const uniq = [...new Set(preds)].sort((x, y) => x - y);
      if (uniq.length) parts.push("xyz"[a] + uniq.map((q) => q + 1).join(","));
    }
    return parts.join(" ");
  }).join("; ") + ")";
}

/** @param {Pattern} pat @returns {string} */
function patternString(pat) { return pat.kind === "T" ? treeString(pat.root) : dagString(pat.boxes); }

/** @param {DagBox[]} boxes */
function dagCheck(boxes) {
  const R = dagReach(boxes);
  const n = boxes.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (![0, 1, 2].some((a) => R[a][i][j] || R[a][j][i])) {
      throw new Error(`Karton ${i + 1} und ${j + 1} sind in keiner Richtung voneinander getrennt und können sich überschneiden.`);
    }
  }
}

/**
 * Liest die Kartonliste eines B(...)-Musters (ohne Leerzeichen).
 * @param {string} inner Inhalt zwischen den Klammern @returns {DagBox[]}
 */
function parseDagItems(inner) {
  const items = inner.split(";").filter(Boolean);
  if (!items.length) throw new Error("Die Kartonliste in B(…) ist leer.");
  if (items.length > 400) throw new Error("Höchstens 400 Kartons in einer Kartonliste.");
  /** @type {DagBox[]} */ const boxes = items.map((it, i) => {
    const m = /^([a-z]{3})((?:[xyz]\d+(?:,\d+)*)*)$/i.exec(it);
    if (!m) throw new Error(`Karton ${i + 1} in B(…): „${it}“ verstehe ich nicht. Erwartet wird z. B. wlh x1,2 z3.`);
    const p = parsePerm(m[1], `Karton ${i + 1}`);
    /** @type {number[][]} */ const pred = [[], [], []];
    const re = /([xyz])(\d+(?:,\d+)*)/gi;
    let g;
    while ((g = re.exec(m[2]))) {
      const a = "xyz".indexOf(g[1].toLowerCase());
      for (const num of g[2].split(",")) {
        const q = parseInt(num, 10) - 1;
        if (q < 0 || q >= items.length || q === i) throw new Error(`Karton ${i + 1} in B(…): Vorgänger ${num} gibt es nicht.`);
        if (!pred[a].includes(q)) pred[a].push(q);
      }
    }
    return { p, pred };
  });
  for (let a = 0; a < 3; a++) dagOrder(boxes, a);
  dagCheck(boxes);
  return boxes;
}

/**
 * Liest ein Muster. Akzeptiert auch eine ganze Zeile "when … then N | Muster".
 * @param {string} input @returns {Pattern}
 */
function parsePattern(input) {
  let s = String(input || "").trim();
  if (s.includes("|")) s = s.slice(s.lastIndexOf("|") + 1).trim();
  if (!s) throw new Error("Bitte ein Muster einfügen, zum Beispiel X(1x1x1:hlw,2x1x2:wlh).");
  if (/^when\b/i.test(s)) throw new Error("Das ist nur eine Regel. Das Muster steht in der Liste hinter dem Zeichen |.");
  const t = s.replace(/\s+/g, "");
  let i = 0;
  /** @param {string} msg @returns {never} */
  const fail = (msg) => { throw new Error(`${msg} (Zeichen ${i + 1}).`); };
  /** @returns {TreeNode} */
  const node = () => {
    const ch = t[i];
    if (ch && /[Bb]/.test(ch) && t[i + 1] === "(") {
      const close = t.indexOf(")", i + 2);
      if (close < 0) fail("Zur Kartonliste B( fehlt die schließende Klammer");
      const boxes = parseDagItems(t.slice(i + 2, close));
      i = close + 1;
      return { k: "B", boxes };
    }
    if (ch && /[XYZxyz]/.test(ch) && t[i + 1] === "(") {
      const a = "xyz".indexOf(ch.toLowerCase());
      i += 2;
      const kids = [node()];
      while (t[i] === ",") { i++; kids.push(node()); }
      if (t[i] !== ")") fail("Hier fehlt „)“");
      i++;
      return kids.length === 1 ? kids[0] : { k: "S", a, c: kids };
    }
    const m = /^(\d+)[x×*](\d+)[x×*](\d+):([a-z]{3})/i.exec(t.slice(i));
    if (!m) fail("Hier wird ein Block wie 2x1x2:wlh, eine Gruppe wie X(…) oder eine Kartonliste B(…) erwartet");
    const n = [+m[1], +m[2], +m[3]];
    if (n.some((v) => v < 1)) fail("Anzahlen im Block müssen mindestens 1 sein");
    const p = parsePerm(m[4], "Block " + m[0]);
    i += m[0].length;
    return { k: "G", n, p };
  };
  const root = node();
  if (i !== t.length) fail(`Unerwartetes Zeichen „${t[i]}“`);
  if (treeCount(root) > 5000) throw new Error("Das Muster hat mehr als 5000 Kartons.");
  return { kind: "T", root };
}

/** @param {string} s @param {string} where @returns {number[]} */
function parsePerm(s, where) {
  const p = [...String(s).toLowerCase()].map((ch) => EDGE_CH.indexOf(ch));
  if (p.length !== 3 || p.includes(-1) || new Set(p).size !== 3) {
    throw new Error(`${where}: Die Lage „${s}“ muss die Buchstaben l, w und h je einmal enthalten.`);
  }
  return p;
}

/* =========================================================================
 * Blockmuster: dynamische Programmierung über Normalmengen
 * ========================================================================= */

const DP_WORK_LIMIT = 4e7;

/** @param {number} D @param {number[]} dims @returns {{vals: number[], prevIdx: Int32Array}} */
function normalSet(D, dims) {
  const reach = new Uint8Array(D + 1);
  reach[0] = 1;
  for (let v = 0; v <= D; v++) {
    if (!reach[v]) continue;
    for (const d of dims) if (v + d <= D) reach[v + d] = 1;
  }
  /** @type {number[]} */ const vals = [];
  const prevIdx = new Int32Array(D + 1);
  for (let v = 0; v <= D; v++) { if (reach[v]) vals.push(v); prevIdx[v] = vals.length - 1; }
  return { vals, prevIdx };
}

/**
 * Bewiesene Obergrenze (ganzzahlige Einheiten).
 * @param {number[]} c @param {number[]} B @returns {number}
 */
function upperBoundInt(c, B) {
  if (Math.min(...c) <= 0) return Infinity;
  const dims = [...new Set(c)];
  const star = B.map((D) => { const s = normalSet(Math.max(0, D), dims); return s.vals[s.vals.length - 1]; });
  return Math.floor((star[0] * star[1] * star[2]) / (c[0] * c[1] * c[2]) + 1e-9);
}

/** @param {TreeNode} nd @returns {TreeNode} */
function simplifyTree(nd) {
  if (nd.k !== "S") return nd;
  /** @type {TreeNode[]} */ const kids = [];
  for (const k of nd.c.map(simplifyTree)) {
    if (k.k === "S" && k.a === nd.a) kids.push(...k.c); else kids.push(k);
  }
  /** @type {TreeNode[]} */ const merged = [];
  for (const k of kids) {
    const prev = merged[merged.length - 1];
    if (prev && prev.k === "G" && k.k === "G" && prev.p.join() === k.p.join()
      && [0, 1, 2].every((a) => a === nd.a || prev.n[a] === k.n[a])) {
      const n = [...prev.n];
      n[nd.a] += k.n[nd.a];
      merged[merged.length - 1] = { k: "G", n, p: prev.p };
    } else merged.push(k);
  }
  return merged.length === 1 ? merged[0] : { k: "S", a: nd.a, c: merged };
}

/**
 * @typedef {{count: number, tree: TreeNode | null, heights: number[],
 *   at: (iz: number) => {count: number, tree: TreeNode | null},
 *   cellCount: (X: number, Y: number, Z: number) => number,
 *   cellTree: (X: number, Y: number, Z: number) => TreeNode | null}} DpTable
 */

/**
 * Bestes Blockmuster (Schnitte durch den ganzen Block, rekursiv).
 * @param {number[]} c Karton, ganzzahlig, Reihenfolge = Kantenindex
 * @param {number[]} B Bin, ganzzahlig
 * @param {boolean} force auch bei großem Aufwand rechnen
 * @returns {{count: number, tree: TreeNode | null} | null}
 */
function dpSolve(c, B, force) {
  const t = dpTable(c, B, force);
  return t ? { count: t.count, tree: t.tree } : null;
}

/**
 * Wie dpSolve, liefert zusätzlich das beste Blockmuster für jede Teilhöhe
 * heights[iz] bei voller Länge und Breite. Das braucht der konische Bin.
 * @param {number[]} c @param {number[]} B @param {boolean} force
 * @param {number} [vertical] nur Kartons zulassen, deren senkrechte Kante so lang ist
 * @returns {DpTable | null}
 */
function dpTable(c, B, force, vertical) {
  /** @type {{d: number[], p: number[]}[]} */ const ors = [];
  /** @type {Set<string>} */ const seen = new Set();
  for (const p of PERMS) {
    const d = [c[p[0]], c[p[1]], c[p[2]]];
    if (d[0] > B[0] || d[1] > B[1] || d[2] > B[2]) continue;
    if (vertical !== undefined && d[2] !== vertical) continue;
    const key = d.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    ors.push({ d, p });
  }
  if (!ors.length) return { count: 0, tree: null, heights: [0], at: () => ({ count: 0, tree: null }), cellCount: () => 0, cellTree: () => null };
  const dims = [...new Set(c)];
  const sx = normalSet(B[0], dims), sy = normalSet(B[1], dims), sz = normalSet(B[2], dims);
  const VX = sx.vals, VY = sy.vals, VZ = sz.vals, PX = sx.prevIdx, PY = sy.prevIdx, PZ = sz.prevIdx;
  const nx = VX.length, ny = VY.length, nz = VZ.length;
  const work = nx * ny * nz * (nx + ny + nz) / 2;
  if (!force && work > DP_WORK_LIMIT) return null;
  const S = nx * ny * nz, syz = ny * nz;
  const f = new Int32Array(S), ct = new Int8Array(S), ca = new Int32Array(S), nb = new Int32Array(S);
  for (let ix = 0; ix < nx; ix++) {
    const Xv = VX[ix];
    for (let iy = 0; iy < ny; iy++) {
      const Yv = VY[iy];
      for (let iz = 0; iz < nz; iz++) {
        const Zv = VZ[iz];
        const id = ix * syz + iy * nz + iz;
        let best = 0, t = 0, arg = -1, bn = 0;
        for (let o = 0; o < ors.length; o++) {
          const d = ors[o].d;
          const cnt = Math.floor(Xv / d[0]) * Math.floor(Yv / d[1]) * Math.floor(Zv / d[2]);
          if (cnt > best) { best = cnt; arg = o; bn = 1; }
        }
        for (let j = 1; j < nx && VX[j] * 2 <= Xv; j++) {
          const p = j * syz + iy * nz + iz, q = PX[Xv - VX[j]] * syz + iy * nz + iz;
          const v = f[p] + f[q];
          if (v > best || (v === best && v > 0 && nb[p] + nb[q] < bn)) { best = v; t = 1; arg = j; bn = nb[p] + nb[q]; }
        }
        for (let j = 1; j < ny && VY[j] * 2 <= Yv; j++) {
          const p = ix * syz + j * nz + iz, q = ix * syz + PY[Yv - VY[j]] * nz + iz;
          const v = f[p] + f[q];
          if (v > best || (v === best && v > 0 && nb[p] + nb[q] < bn)) { best = v; t = 2; arg = j; bn = nb[p] + nb[q]; }
        }
        for (let j = 1; j < nz && VZ[j] * 2 <= Zv; j++) {
          const p = ix * syz + iy * nz + j, q = ix * syz + iy * nz + PZ[Zv - VZ[j]];
          const v = f[p] + f[q];
          if (v > best || (v === best && v > 0 && nb[p] + nb[q] < bn)) { best = v; t = 3; arg = j; bn = nb[p] + nb[q]; }
        }
        f[id] = best; ct[id] = t; ca[id] = arg; nb[id] = bn;
      }
    }
  }
  /** @param {number} ix @param {number} iy @param {number} iz @returns {TreeNode | null} */
  const rec = (ix, iy, iz) => {
    const id = ix * syz + iy * nz + iz;
    if (f[id] === 0) return null;
    const t = ct[id], a = ca[id];
    if (t === 0) {
      const o = ors[a];
      return { k: "G", n: [Math.floor(VX[ix] / o.d[0]), Math.floor(VY[iy] / o.d[1]), Math.floor(VZ[iz] / o.d[2])], p: o.p };
    }
    let k1, k2;
    if (t === 1) { k1 = rec(a, iy, iz); k2 = rec(PX[VX[ix] - VX[a]], iy, iz); }
    else if (t === 2) { k1 = rec(ix, a, iz); k2 = rec(ix, PY[VY[iy] - VY[a]], iz); }
    else { k1 = rec(ix, iy, a); k2 = rec(ix, iy, PZ[VZ[iz] - VZ[a]]); }
    /** @type {TreeNode[]} */ const kids = /** @type {TreeNode[]} */ ([k1, k2].filter(Boolean));
    return kids.length === 1 ? kids[0] : { k: "S", a: t - 1, c: kids };
  };
  /** @param {number} iz @returns {{count: number, tree: TreeNode | null}} */
  const at = (iz) => {
    const tree = rec(nx - 1, ny - 1, iz);
    return { count: f[(nx - 1) * syz + (ny - 1) * nz + iz], tree: tree ? simplifyTree(tree) : null };
  };
  const top = at(nz - 1);
  /** Bestes Blockmuster für einen Teilquader X x Y x Z (wird auf mögliche Kantensummen abgerundet) */
  /** @param {number} X @param {number} Y @param {number} Z @returns {number[] | null} */
  const idx = (X, Y, Z) => (X < 0 || Y < 0 || Z < 0 ? null : [PX[Math.min(X, B[0])], PY[Math.min(Y, B[1])], PZ[Math.min(Z, B[2])]]);
  /** @param {number} X @param {number} Y @param {number} Z @returns {number} */
  const cellCount = (X, Y, Z) => { const i = idx(X, Y, Z); return i ? f[i[0] * syz + i[1] * nz + i[2]] : 0; };
  /** @param {number} X @param {number} Y @param {number} Z @returns {TreeNode | null} */
  const cellTree = (X, Y, Z) => { const i = idx(X, Y, Z); const t = i ? rec(i[0], i[1], i[2]) : null; return t ? simplifyTree(t) : null; };
  return { count: top.count, tree: top.tree, heights: VZ, at, cellCount, cellTree };
}

/**
 * Bestes einfaches Gitter für echte Maße.
 * @param {number[]} c sortiert @param {number[]} bin @returns {{count: number, tree: TreeNode | null}}
 */
function bestGrid(c, bin) {
  let best = null, bc = 0;
  for (const p of PERMS) {
    const n = [0, 1, 2].map((a) => Math.floor(bin[a] / c[p[a]] + 1e-9));
    const cnt = n[0] * n[1] * n[2];
    if (cnt > bc) { bc = cnt; best = { k: "G", n, p }; }
  }
  return { count: bc, tree: /** @type {TreeNode | null} */ (best) };
}

/* =========================================================================
 * Verschränkte Muster: Tiefensuche mit Zeitlimit
 * ========================================================================= */

/**
 * @param {number[]} c Karton, ganzzahlig (Index = Kante)
 * @param {number[]} B Bin, ganzzahlig
 * @param {number} target Anzahl
 * @param {number} timeMs Zeitlimit
 * @returns {{placements: Placement[] | null, exhaustive: boolean}}
 */
function searchPack(c, B, target, timeMs) {
  /** @type {number[][]} */ const ors = [];
  /** @type {number[][]} */ const orp = [];
  /** @type {Set<string>} */ const seen = new Set();
  for (const p of PERMS) {
    const d = [c[p[0]], c[p[1]], c[p[2]]];
    const key = d.join(",");
    if (!seen.has(key) && d[0] <= B[0] && d[1] <= B[1] && d[2] <= B[2]) { seen.add(key); ors.push(d); orp.push(p); }
  }
  if (!ors.length || target <= 0) return { placements: target <= 0 ? [] : null, exhaustive: true };
  const dims = [...new Set(c)];
  /** @param {number} D @returns {Int32Array} */
  const normal = (D) => Int32Array.from(normalSet(D, dims).vals);
  const NX = normal(B[0]), NY = normal(B[1]), NZ = normal(B[2]);
  const Xs = NX[NX.length - 1], Ys = NY[NY.length - 1], Zs = NZ[NZ.length - 1];
  const vol = c[0] * c[1] * c[2];
  const minDim = Math.min(c[0], c[1], c[2]);
  if (target * vol > Xs * Ys * Zs) return { placements: null, exhaustive: true };

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
  const t0 = nowMs();
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
    if ((++nodes & 511) === 0 && nowMs() - t0 > timeMs) timeout = true;
    if (timeout) return false;
    let above = 0, zn = zl + minDim;
    for (let i = 0; i < k; i++) {
      const top = pz[i] + sz[i];
      if (top > zl) { above += sx[i] * sy[i] * (top - (pz[i] > zl ? pz[i] : zl)); if (top < zn) zn = top; }
    }
    let lost = 0;
    if (yl > 0) {
      const ylc = yl < Ys ? yl : Ys;
      let nr = 0, ne = 0, nf = 0;
      exs[ne++] = 0; exs[ne++] = Xs; eys[nf++] = 0; eys[nf++] = ylc;
      for (let i = 0; i < k; i++) {
        if (pz[i] <= zl && pz[i] + sz[i] > zl && py[i] < ylc) {
          const x0 = px[i], x1 = px[i] + sx[i] < Xs ? px[i] + sx[i] : Xs, y0 = py[i], y1 = py[i] + sy[i] < ylc ? py[i] + sy[i] : ylc;
          rect[4 * nr] = x0; rect[4 * nr + 1] = x1; rect[4 * nr + 2] = y0; rect[4 * nr + 3] = y1; nr++;
          exs[ne++] = x0; exs[ne++] = x1; eys[nf++] = y0; eys[nf++] = y1;
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
      lost = (Xs * ylc - covered) * (zn - zl);
    }
    if ((K - k) * vol > Xs * Ys * (Zs - zl) - above - lost) return false;

    const zb = k * (K + 1);
    let nzc = 0;
    zbuf[zb + nzc++] = zl;
    for (let i = 0; i < k; i++) { const top = pz[i] + sz[i]; if (top > zl) zbuf[zb + nzc++] = top; }
    nzc = sortUnique(zbuf, zb, zb + nzc) - zb;

    const ob = k * O;
    for (let zi = 0; zi < nzc; zi++) {
      const z = zbuf[zb + zi];
      let ns = 0;
      if (z > 0) for (let i = 0; i < k; i++) if (pz[i] + sz[i] === z) supZ[k * K + ns++] = i;
      if (z > 0 && ns === 0) continue;
      for (let o = 0; o < O; o++) {
        let m = 0;
        const dz = ODZ[o];
        if (z + dz <= B[2]) for (let i = 0; i < k; i++) if (z < pz[i] + sz[i] && pz[i] < z + dz) ovZ[(ob + o) * K + m++] = i;
        nZ[ob + o] = z + dz <= B[2] ? m : -1;
      }
      for (let yi = 0; yi < NY.length; yi++) {
        const y = NY[yi];
        if (z === zl && y < yl) continue;
        let any = false;
        for (let o = 0; o < O; o++) {
          nY[ob + o] = -1; nS[ob + o] = 0;
          if (nZ[ob + o] < 0) continue;
          const dy = ODY[o];
          if (y + dy > B[1]) continue;
          let m = 0;
          for (let j = 0; j < nZ[ob + o]; j++) { const i = ovZ[(ob + o) * K + j]; if (y < py[i] + sy[i] && py[i] < y + dy) ovY[(ob + o) * K + m++] = i; }
          let s = 0;
          if (z > 0) {
            for (let j = 0; j < ns; j++) { const i = supZ[k * K + j]; if (y < py[i] + sy[i] && py[i] < y + dy) supY[(ob + o) * K + s++] = i; }
            if (s === 0) continue;
          }
          nY[ob + o] = m; nS[ob + o] = s; any = true;
        }
        if (!any) continue;
        for (let xi = 0; xi < NX.length; xi++) {
          const x = NX[xi];
          if (z === zl && y === yl && x <= xl) continue;
          for (let o = 0; o < O; o++) {
            const m = nY[ob + o];
            if (m < 0) continue;
            const dx = ODX[o];
            if (x + dx > B[0]) continue;
            let ok = true;
            for (let j = 0; j < m; j++) { const i = ovY[(ob + o) * K + j]; if (x < px[i] + sx[i] && px[i] < x + dx) { ok = false; break; } }
            if (!ok) continue;
            if (z > 0) {
              let sup = false;
              for (let j = 0; j < nS[ob + o]; j++) { const i = supY[(ob + o) * K + j]; if (x < px[i] + sx[i] && px[i] < x + dx) { sup = true; break; } }
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
  /** @type {Placement[]} */ const out = [];
  for (let i = 0; i < K; i++) out.push({ x: px[i], y: py[i], z: pz[i], dx: sx[i], dy: sy[i], dz: sz[i], p: orp[po[i]] });
  return { placements: out, exhaustive: true };
}

/** @param {number[]} B @returns {number[][]} Achsenreihenfolgen, längste Achse zuerst */
function searchOrders(B) {
  const [l, m, s] = [0, 1, 2].sort((a, b) => B[b] - B[a]);
  return [[m, s, l], [s, m, l], [l, m, s], [m, l, s], [l, s, m], [s, l, m]];
}

/**
 * Suche in mehreren Achsenreihenfolgen mit wachsenden Zeitscheiben.
 * @param {number[]} c @param {number[]} B @param {number} target @param {number} budgetMs
 * @returns {{placements: Placement[] | null, exhaustive: boolean}}
 */
function portfolioSearch(c, B, target, budgetMs) {
  const t0 = nowMs();
  const orders = searchOrders(B);
  let slice = Math.max(4, budgetMs / 8);
  while (nowMs() - t0 < budgetMs) {
    for (const P of orders) {
      const left = budgetMs - (nowMs() - t0);
      if (left <= 1) return { placements: null, exhaustive: false };
      const r = searchPack(c, [B[P[0]], B[P[1]], B[P[2]]], target, Math.min(slice, left));
      if (r.exhaustive && !r.placements) return { placements: null, exhaustive: true };
      if (r.placements) {
        const out = r.placements.map((q) => {
          const pos = [0, 0, 0], d = [0, 0, 0], p = [0, 0, 0];
          const s = [q.x, q.y, q.z], sd = [q.dx, q.dy, q.dz];
          for (let k = 0; k < 3; k++) { pos[P[k]] = s[k]; d[P[k]] = sd[k]; p[P[k]] = q.p[k]; }
          return { x: pos[0], y: pos[1], z: pos[2], dx: d[0], dy: d[1], dz: d[2], p };
        });
        return { placements: out, exhaustive: true };
      }
    }
    slice *= 2;
  }
  return { placements: null, exhaustive: false };
}

/**
 * Macht aus einer gefundenen Anordnung ein Muster mit Vorgängern.
 * Jedes Kartonpaar wird entlang genau einer Achse getrennt; gibt es mehrere
 * Möglichkeiten, nimmt die Funktion die mit dem größten Abstand.
 * @param {Placement[]} P @param {number[]} bin @returns {Pattern}
 */
function dagFromPlacements(P, bin) {
  const Q = [...P].sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));
  const n = Q.length;
  const pos = Q.map((q) => [q.x, q.y, q.z]), dim = Q.map((q) => [q.dx, q.dy, q.dz]);
  const reach = [0, 1, 2].map(() => new Uint8Array(n * n));
  /** @type {number[][][]} */ const pred = Q.map(() => [[], [], []]);
  /** @param {number} a @param {number} i @param {number} j */
  const addEdge = (a, i, j) => {
    pred[j][a].push(i);
    const R = reach[a];
    const us = [i], vs = [j];
    for (let u = 0; u < n; u++) if (R[u * n + i]) us.push(u);
    for (let v = 0; v < n; v++) if (R[j * n + v]) vs.push(v);
    for (const u of us) for (const v of vs) R[u * n + v] = 1;
  };
  /** @type {{a: number, from: number, to: number, gap: number}[][]} */ const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    /** @type {{a: number, from: number, to: number, gap: number}[]} */ const S = [];
    for (let a = 0; a < 3; a++) {
      if (pos[i][a] + dim[i][a] <= pos[j][a] + 1e-6) S.push({ a, from: i, to: j, gap: (pos[j][a] - pos[i][a] - dim[i][a]) / bin[a] });
      else if (pos[j][a] + dim[j][a] <= pos[i][a] + 1e-6) S.push({ a, from: j, to: i, gap: (pos[i][a] - pos[j][a] - dim[j][a]) / bin[a] });
    }
    if (!S.length) throw new Error("Anordnung mit Überschneidung");
    pairs.push(S);
  }
  const done = (/** @type {{a: number, from: number, to: number}[]} */ S) => S.some((s) => reach[s.a][s.from * n + s.to]);
  for (const S of pairs) if (S.length === 1 && !done(S)) addEdge(S[0].a, S[0].from, S[0].to);
  for (const S of pairs) {
    if (S.length === 1 || done(S)) continue;
    const s = S.reduce((b, x) => (x.gap > b.gap ? x : b));
    addEdge(s.a, s.from, s.to);
  }
  return { kind: "B", boxes: Q.map((q, i) => ({ p: q.p, pred: pred[i] })) };
}

/**
 * Sucht Muster aus gleichen Lagen: der Bin wird entlang einer Achse in Scheiben
 * von der Dicke einer Kartonkante geteilt, jede Scheibe wird zweidimensional
 * gepackt (auch verschränkt, z. B. als Windmühle).
 * @param {number[]} c Karton, ganzzahlig @param {number[]} B Bin, ganzzahlig
 * @param {number} target @param {number} budgetMs
 * @returns {TreeNode | null}
 */
function layeredSearch(c, B, target, budgetMs) {
  const t0 = nowMs();
  /** @type {{a: number, e: number, n: number, need: number}[]} */ const combos = [];
  for (let a = 0; a < 3; a++) {
    /** @type {Set<number>} */ const seen = new Set();
    for (let e = 0; e < 3; e++) {
      if (seen.has(c[e])) continue;
      seen.add(c[e]);
      const n = Math.floor(B[a] / c[e]);
      if (n < 1) continue;
      const need = Math.ceil(target / n);
      if (need < 2 || need > 40) continue;
      combos.push({ a, e, n, need });
    }
  }
  combos.sort((p, q) => p.need - q.need);
  for (let i = 0; i < combos.length; i++) {
    const { a, e, n, need } = combos[i];
    const left = budgetMs - (nowMs() - t0);
    if (left <= 1) break;
    const B2 = [...B];
    B2[a] = c[e];
    const r = portfolioSearch(c, B2, need, left / (combos.length - i));
    if (!r.placements) continue;
    const pat = dagFromPlacements(r.placements, B2);
    if (pat.kind !== "B") continue;
    /** @type {TreeNode} */ const layer = { k: "B", boxes: pat.boxes };
    return n === 1 ? layer : { k: "S", a, c: Array.from({ length: n }, () => layer) };
  }
  return null;
}

/* =========================================================================
 * Karton prüfen
 * ========================================================================= */

/**
 * @typedef {{carton: number[], count: number, upper: number, status: "optimal" | "open",
 *   pattern: Pattern | null, rule: Rule | null, mixed: boolean}} Analysis
 */

/**
 * Bestes Muster für einen Karton: erst Blockmuster, dann Suche nach verschränkten.
 * @param {number[]} cartonMM @param {number[]} binMM @param {number} budgetMs
 * @param {(a: Analysis) => void} [onStep] Zwischenergebnis nach den Blockmustern
 * @returns {Analysis}
 */
function analyzeCarton(cartonMM, binMM, budgetMs, onStep) {
  const c = [...cartonMM].sort((a, b) => b - a);
  const integral = [...c, ...binMM].every((v) => Math.abs(v - Math.round(v)) < 1e-9);
  const units = integral ? [1, 2, 5, 10] : [0.1, 0.5, 1, 2, 5, 10];
  const base = units[0];
  /** @param {number} u */
  const toU = (u) => ({ cu: c.map((v) => Math.max(1, Math.ceil(v / u - 1e-9))), Bu: binMM.map((v) => Math.floor(v / u + 1e-9)) });
  let dp = null, used = base;
  for (const u of units) { const { cu, Bu } = toU(u); dp = dpSolve(cu, Bu, false); used = u; if (dp) break; }
  if (!dp) { const { cu, Bu } = toU(units[units.length - 1]); dp = dpSolve(cu, Bu, true); }
  let count = dp ? dp.count : 0;
  /** @type {Pattern | null} */ let pattern = dp && dp.tree ? { kind: "T", root: dp.tree } : null;
  if (used > base) {
    const g = bestGrid(c, binMM);
    if (g.count > count && g.tree) { count = g.count; pattern = { kind: "T", root: g.tree }; }
  }
  const { cu: cb, Bu: Bb } = toU(base);
  let upper = upperBoundInt(cb, Bb);
  let status = /** @type {"optimal" | "open"} */ (count >= upper ? "optimal" : "open");
  let mixed = false;
  /** @returns {Analysis} */
  const result = () => ({ carton: c, count, upper, status, pattern, rule: pattern ? patternRule(pattern, binMM) : null, mixed });
  if (onStep) onStep(result());
  const t0 = nowMs();
  while (status === "open" && count + 1 <= 40 && count + 1 <= upper) {
    const left = budgetMs - (nowMs() - t0);
    if (left <= 20) break;
    const lay = layeredSearch(cb, Bb, count + 1, Math.min(left / 3, 1500));
    if (lay) {
      pattern = { kind: "T", root: lay };
      count = treeCount(lay);
      mixed = true;
      if (count >= upper) status = "optimal";
      continue;
    }
    const r = portfolioSearch(cb, Bb, count + 1, budgetMs - (nowMs() - t0));
    if (r.placements) {
      const P = r.placements.map((q) => ({ ...q, x: q.x * base, y: q.y * base, z: q.z * base, dx: q.dx * base, dy: q.dy * base, dz: q.dz * base }));
      pattern = dagFromPlacements(P, binMM);
      count++;
      mixed = true;
      if (count >= upper) status = "optimal";
    } else if (r.exhaustive) { status = "optimal"; upper = count; }
    else break;
  }
  return result();
}

/* =========================================================================
 * Regeln erzeugen
 * ========================================================================= */

/**
 * @typedef {{count: number, score: number, cons: Con[], pat: Pattern, src: string,
 *   verts?: number[][], example?: number[] | null}} GenRule
 * @typedef {{step?: number, random?: boolean, search?: number | boolean, patience?: number, maxLines?: number}} GenPass
 * @typedef {{nmax: number, passes: GenPass[], searchMs: number, searchMaxCount: number,
 *   maxMs: number, grow?: boolean, seed?: number}} GenOptions
 */

/**
 * Entfernt Kartons aus einem Blockmuster, bis nur noch target übrig sind,
 * so dass die Bedingungen möglichst locker werden.
 * @param {TreeNode} root @param {number} target @param {number[]} c @param {number[]} bin @returns {TreeNode}
 */
function reduceTree(root, target, c, bin) {
  let cur = root;
  for (let guard = 0; guard < 400; guard++) {
    const total = treeCount(cur);
    if (total <= target) break;
    /** @type {TreeNode | null} */ let best = null;
    let bestS = -1, bestTot = Infinity;
    /** @type {{path: number[], leaf: Leaf}[]} */ const leaves = [];
    /** @param {TreeNode} nd @param {number[]} path */
    const collect = (nd, path) => {
      if (nd.k === "G") leaves.push({ path, leaf: nd });
      else if (nd.k === "S") nd.c.forEach((k, i) => collect(k, [...path, i]));
    };
    collect(cur, []);
    for (const { path, leaf } of leaves) {
      const prod = leaf.n[0] * leaf.n[1] * leaf.n[2];
      /** @type {{a: number, rem: number}[]} */ const opts = [{ a: -1, rem: prod }];
      for (let a = 0; a < 3; a++) if (leaf.n[a] > 1) opts.push({ a, rem: prod / leaf.n[a] });
      for (const o of opts) {
        const tot = total - o.rem;
        if (tot < target) continue;
        const cand = replaceLeaf(cur, path, o.a < 0 ? null : { k: "G", n: leaf.n.map((v, a) => (a === o.a ? v - 1 : v)), p: leaf.p });
        if (!cand) continue;
        const s = scaleSlack(treeTerms(cand), bin, c);
        if (s > bestS + 1e-12 || (Math.abs(s - bestS) <= 1e-12 && tot < bestTot)) { best = cand; bestS = s; bestTot = tot; }
      }
    }
    if (!best) break;
    cur = best;
  }
  return simplifyTree(cur);
}

/**
 * @param {TreeNode} nd @param {number[]} path @param {Leaf | null} repl
 * @returns {TreeNode | null}
 */
function replaceLeaf(nd, path, repl) {
  if (!path.length) return repl;
  if (nd.k !== "S") return nd;
  const kids = nd.c.map((k, i) => (i === path[0] ? replaceLeaf(k, path.slice(1), repl) : k)).filter(Boolean);
  if (!kids.length) return null;
  return kids.length === 1 ? /** @type {TreeNode} */ (kids[0]) : { k: "S", a: nd.a, c: /** @type {TreeNode[]} */ (kids) };
}

/**
 * Erzeugt Regeln "when … then N" für alle Kartons l >= w >= h in ganzen mm.
 * @param {number[]} binMM [L, B, H]
 * @param {GenOptions} opt
 * @param {(p: object) => void} [onProgress]
 */
function generateRules(binMM, opt, onProgress) {
  const t0 = nowMs();
  const nmax = opt.nmax;
  const Bint = binMM.map((v) => Math.floor(v + 1e-9));
  const [M0, M1, M2] = [...binMM].sort((a, b) => b - a).map((v) => Math.floor(v + 1e-9));
  /** @type {GenRule[]} */ const rules = [];
  /** @type {Set<string>} */ const keys = new Set();
  const stats = { probes: 0, lines: 0, dpMs: 0, searchMs: 0, searchCalls: 0, searchFinds: 0, dpFinds: 0, seeds: 0, growDp: 0, randomLines: 0, layerFinds: 0 };
  let aborted = false;
  let lastReport = 0;
  /** @type {{R: number, score: Int32Array, start: Int32Array, co: Float64Array} | null} */ let comp = null;

  /** @param {Pattern} pat @param {string} src @param {number[] | null} at @returns {boolean} */
  const addRule = (pat, src, at) => {
    const rule = patternRule(pat, binMM);
    if (at && !consHold(rule.cons, at, 1e-6)) return false;
    const score = Math.min(rule.count, nmax);
    const key = score + "#" + consKey(rule.cons);
    if (keys.has(key)) return false;
    keys.add(key);
    rules.push({ count: rule.count, score, cons: rule.cons, pat, src });
    comp = null;
    return true;
  };

  const compile = () => {
    let total = 0;
    for (const r of rules) total += r.cons.length;
    const R = rules.length;
    const score = new Int32Array(R), start = new Int32Array(R + 1), co = new Float64Array(total * 4);
    let k = 0;
    rules.forEach((r, i) => {
      score[i] = r.score; start[i] = k;
      for (const c of r.cons) { co[4 * k] = c.t[0]; co[4 * k + 1] = c.t[1]; co[4 * k + 2] = c.t[2]; co[4 * k + 3] = c.D + 1e-9; k++; }
    });
    start[R] = k;
    comp = { R, score, start, co };
    return comp;
  };

  /** @param {number} k @param {number[]} fixed @param {number} v0 @param {number} v1 @returns {Int32Array} */
  const lineCounts = (k, fixed, v0, v1) => {
    const { R, score, start, co } = comp || compile();
    const len = v1 - v0 + 1;
    const best = new Int32Array(len);
    for (let r = 0; r < R; r++) {
      let vmax = Infinity;
      for (let q = start[r]; q < start[r + 1]; q++) {
        const b = 4 * q;
        let rest = co[b + 3], ck = 0;
        for (let e = 0; e < 3; e++) { if (e === k) ck = co[b + e]; else rest -= co[b + e] * fixed[e]; }
        if (ck > 0) { const v = rest / ck; if (v < vmax) vmax = v; }
        else if (rest < 0) { vmax = -Infinity; }
        if (vmax < v0) break;
      }
      if (vmax < v0) continue;
      const idx = Math.min(Math.floor(vmax), v1) - v0;
      if (score[r] > best[idx]) best[idx] = score[r];
    }
    for (let i = len - 2; i >= 0; i--) if (best[i + 1] > best[i]) best[i] = best[i + 1];
    return best;
  };

  // 1. Startregeln: alle einfachen Gitter (nur die nicht dominierten)
  {
    /** @type {{u: number[], score: number, n: number[], p: number[], count: number}[]} */ const seeds = [];
    for (const p of PERMS) {
      for (let a = 1; a <= nmax; a++) for (let b = 1; b <= nmax; b++) for (let c = 1; c <= nmax; c++) {
        const prod = a * b * c;
        const minimal = (a - 1) * b * c < nmax && a * (b - 1) * c < nmax && a * b * (c - 1) < nmax;
        if (prod > nmax && !minimal) continue;
        const n = [a, b, c];
        const u = [Infinity, Infinity, Infinity];
        for (let ax = 0; ax < 3; ax++) u[p[ax]] = binMM[ax] / n[ax];
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
    for (const s of keptSeeds) if (addRule({ kind: "T", root: { k: "G", n: s.n, p: s.p } }, "grid", null)) stats.seeds++;
  }

  /** @type {Map<string, {sc: number, searched: boolean}>} */ const memo = new Map();
  /** @type {Map<string, number>} */ const dpMemo = new Map();

  /** @param {number[]} q @returns {number} Blockmuster-Anzahl (gedeckelt) */
  const dpScore = (q) => {
    const key = q.join(",");
    const m = dpMemo.get(key);
    if (m !== undefined) return m;
    stats.growDp++;
    const t1 = nowMs();
    const r = dpSolve(q, Bint, false);
    stats.dpMs += nowMs() - t1;
    const sc = r ? Math.min(r.count, nmax) : 0;
    dpMemo.set(key, sc);
    return sc;
  };

  /**
   * Schiebt den Punkt in h-, w- und l-Richtung so weit hinaus, wie das Blockmuster
   * noch sc Kartons schafft. Das Muster am Endpunkt deckt einen größeren Bereich ab.
   * @param {number[]} q @param {number} sc @returns {{tree: TreeNode, count: number, at: number[]} | null}
   */
  const growPoint = (q, sc) => {
    const at = [...q];
    for (const k of [2, 1, 0]) {
      let lo = at[k];
      const hi = k === 0 ? M0 : k === 1 ? Math.min(at[0], M1) : Math.min(at[1], M2);
      let top = hi;
      while (lo < top) {
        const mid = Math.floor((lo + top + 1) / 2);
        const p = [...at];
        p[k] = mid;
        if (dpScore(p) >= sc) lo = mid; else top = mid - 1;
      }
      at[k] = lo;
    }
    if (at[0] === q[0] && at[1] === q[1] && at[2] === q[2]) return null;
    const r = dpSolve(at, Bint, false);
    if (!r || !r.tree || Math.min(r.count, nmax) < sc) return null;
    return { tree: r.tree, count: r.count, at };
  };

  /** @param {number[]} q @param {number} cur @param {boolean} useSearch @returns {Pattern | null} */
  const solvePoint = (q, cur, useSearch) => {
    const key = q.join(",");
    const m = memo.get(key);
    if (m && m.sc <= cur && (m.searched || !useSearch)) return null;
    let sc = cur;
    if (!m) {
      stats.probes++;
      const t1 = nowMs();
      const dp = dpSolve(q, Bint, false);
      stats.dpMs += nowMs() - t1;
      if (dp && dp.tree) {
        sc = Math.min(dp.count, nmax);
        if (sc > cur) {
          memo.set(key, { sc, searched: false });
          stats.dpFinds++;
          let tree = dp.tree, count = dp.count, at = q;
          if (opt.grow) {
            const g = growPoint(q, sc);
            if (g) { tree = g.tree; count = g.count; at = g.at; }
          }
          const root = count > nmax ? reduceTree(tree, nmax, at, binMM) : tree;
          return { kind: "T", root };
        }
      }
      memo.set(key, { sc: cur, searched: false });
    }
    const entry = /** @type {{sc: number, searched: boolean}} */ (memo.get(key));
    if (useSearch && !entry.searched && cur + 1 <= opt.searchMaxCount && cur < nmax) {
      entry.searched = true;
      if (upperBoundInt(q, Bint) > cur) {
        const t2 = nowMs();
        stats.searchCalls++;
        const lay = layeredSearch(q, Bint, cur + 1, opt.searchMs / 2);
        if (lay) {
          stats.searchMs += nowMs() - t2;
          entry.sc = cur + 1;
          stats.layerFinds++;
          return { kind: "T", root: lay };
        }
        const r = portfolioSearch(q, Bint, cur + 1, opt.searchMs / 2);
        stats.searchMs += nowMs() - t2;
        if (r.placements) {
          entry.sc = cur + 1;
          stats.searchFinds++;
          return dagFromPlacements(r.placements, Bint);
        }
      }
    }
    return null;
  };

  /** @param {number} k @param {number[]} fixed @param {number} v0 @param {number} v1 @param {boolean} useSearch */
  const probeLine = (k, fixed, v0, v1, useSearch) => {
    if (v1 < v0) return;
    stats.lines++;
    let cnt = lineCounts(k, fixed, v0, v1);
    let v = v0;
    for (let guard = 0; v <= v1 && guard < 400; guard++) {
      const c = cnt[v - v0];
      if (c < nmax) {
        const q = [...fixed];
        q[k] = v;
        const pat = solvePoint(q, c, useSearch);
        if (pat && addRule(pat, patternHasDag(pat) ? "search" : "dp", q)) {
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

  // 2. Abtasten entlang von Linien in l-, w- und h-Richtung:
  //    erst auf festen Rastern, danach auf zufälligen Linien, bis die Zeit um ist
  //    oder lange keine neue Regel mehr dazukommt.
  let seed = opt.seed || 20260930;
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
        probeLine(L.k, L.fixed, L.v0, L.v1, opt.searchMs > 0 && rand() < (pass.search || 0));
        li++;
        sinceNew = rules.length > before ? 0 : sinceNew + 1;
        const now = nowMs();
        if (now - t0 > opt.maxMs) { aborted = true; break outer; }
        if (onProgress && now - lastReport > 250) {
          lastReport = now;
          onProgress({ phase: "random", pass: pi + 1, passes: passes.length, done: li, sinceNew, patience: pass.patience || 1500, rules: rules.length, probes: stats.probes, elapsed: now - t0, maxMs: opt.maxMs });
        }
      }
      stats.randomLines = li;
      continue;
    }
    const s = pass.step;
    const useSearch = !!pass.search && opt.searchMs > 0;
    /** @type {{k: number, fixed: number[], v0: number, v1: number}[]} */ const lines = [];
    for (const h of gridVals(s, M2)) for (const w of gridVals(s, M1)) if (w >= h) lines.push({ k: 0, fixed: [0, w, h], v0: w, v1: M0 });
    for (const h of gridVals(s, M2)) for (const l of gridVals(s, M0)) if (l >= h) lines.push({ k: 1, fixed: [l, 0, h], v0: h, v1: Math.min(l, M1) });
    for (const w of gridVals(s, M1)) for (const l of gridVals(s, M0)) if (l >= w) lines.push({ k: 2, fixed: [l, w, 0], v0: 1, v1: Math.min(w, M2) });
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      probeLine(L.k, L.fixed, L.v0, L.v1, useSearch);
      const now = nowMs();
      if (now - t0 > opt.maxMs) { aborted = true; break outer; }
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress({ phase: "grid", pass: pi + 1, passes: passes.length, step: s, done: li + 1, total: lines.length, rules: rules.length, probes: stats.probes, elapsed: now - t0, maxMs: opt.maxMs });
      }
    }
  }

  // 3. Aufräumen: enthaltene Regeln entfernen
  if (onProgress) onProgress({ phase: "prune", rules: rules.length, elapsed: nowMs() - t0 });
  const ordered = [...rules].sort((a, b) => (b.score - a.score) || (a.cons.length - b.cons.length) || (patternCount(a.pat) - patternCount(b.pat)));
  /** @type {GenRule[]} */ const kept = [];
  for (const r of ordered) {
    r.verts = regionVertices(r.cons);
    if (!r.verts.length) continue;
    const V = r.verts;
    if (kept.some((k) => k.score >= r.score && verticesInside(V, k.cons))) continue;
    kept.push(r);
  }

  // 4. Nur Regeln behalten, die für mindestens einen Karton in ganzen mm entscheiden
  if (onProgress) onProgress({ phase: "sweep", rules: kept.length, elapsed: nowMs() - t0 });
  const K = kept.length;
  const mark = new Uint8Array(K);
  {
    let total = 0;
    for (const r of kept) total += r.cons.length;
    const score = new Int32Array(K), start = new Int32Array(K + 1), co = new Float64Array(total * 4);
    let k = 0;
    kept.forEach((r, i) => {
      score[i] = r.score; start[i] = k;
      for (const c of r.cons) { co[4 * k] = c.t[0]; co[4 * k + 1] = c.t[1]; co[4 * k + 2] = c.t[2]; co[4 * k + 3] = c.D + 1e-9; k++; }
    });
    start[K] = k;
    for (let h = 1; h <= M2; h++) {
      for (let w = h; w <= M1; w++) {
        let covered = w - 1;
        let r = 0;
        while (r < K && covered < M0) {
          const s = score[r];
          let bestL = -1, bestR = -1;
          for (; r < K && score[r] === s; r++) {
            let lm = Infinity;
            for (let q = start[r]; q < start[r + 1]; q++) {
              const b = 4 * q;
              const rest = co[b + 3] - co[b + 1] * w - co[b + 2] * h;
              if (co[b] > 0) { const v = rest / co[b]; if (v < lm) lm = v; }
              else if (rest < 0) { lm = -Infinity; break; }
              if (lm <= covered) break;
            }
            if (lm <= covered) continue;
            const L = Math.min(Math.floor(lm), M0);
            if (L > bestL) { bestL = L; bestR = r; }
          }
          if (bestR >= 0 && bestL > covered) { mark[bestR] = 1; covered = bestL; }
        }
      }
    }
  }
  const final = kept.filter((_, i) => mark[i]);
  for (const r of final) r.example = exampleCarton(/** @type {number[][]} */ (r.verts));
  final.sort((a, b) => (b.score - a.score) || (vol(b.example) - vol(a.example)));
  return {
    bin: binMM, nmax, rules: final, stats,
    meta: { passes: opt.passes, searchMs: opt.searchMs, aborted, elapsedMs: nowMs() - t0, candidates: rules.length }
  };
}

/** @param {number[] | null | undefined} c @returns {number} */
function vol(c) { return c ? c[0] * c[1] * c[2] : 0; }

/**
 * Anzahl laut Regelliste für einen Karton (sortiert), mit Index der Regel.
 * @param {{score: number, cons: Con[]}[]} rules @param {number[]} c @returns {{score: number, index: number}}
 */
function lookupRules(rules, c) {
  let best = 0, idx = -1;
  rules.forEach((r, i) => { if (r.score > best && consHold(r.cons, c, 1e-7)) { best = r.score; idx = i; } });
  return { score: best, index: idx };
}

/* =========================================================================
 * Voreinstellungen, Datenformat und Textausgabe (gemeinsam für Seite und Werkzeuge)
 * ========================================================================= */

/**
 * @typedef {"fast" | "std" | "full"} QualityKey
 * @typedef {{label: string, passes: GenPass[], searchMs: number, maxMs: number}} QualityPreset
 */

/** @type {Record<QualityKey, QualityPreset>} */
const QUALITY_PRESETS = {
  fast: { label: "Schnell", passes: [{ step: 40, search: true }, { step: 20 }], searchMs: 15, maxMs: 90000 },
  std: { label: "Standard", passes: [{ step: 40, search: true }, { step: 20 }, { random: true, search: 0.2, patience: 4000 }], searchMs: 20, maxMs: 240000 },
  full: { label: "Gründlich", passes: [{ step: 40, search: true }, { step: 20, search: true }, { step: 10 }, { random: true, search: 0.3, patience: 15000 }], searchMs: 40, maxMs: 2400000 }
};

/**
 * @param {QualityKey} quality @param {number} nmax @returns {GenOptions}
 */
function genOptions(quality, nmax) {
  const q = QUALITY_PRESETS[quality];
  return { nmax, passes: q.passes, searchMs: q.searchMs, searchMaxCount: nmax, maxMs: q.maxMs, grow: true };
}

/** @param {number[]} bin @returns {string} z. B. "603x403x404" */
function binKeyOf(bin) { return bin.map(numText).join("x"); }

/**
 * Gespeichertes Format einer Regelliste (so liegen die Dateien in rules/).
 * rules: [Anzahl gedeckelt, Kartons im Muster, Bedingungen flach [l,w,h,Achse, …], Muster, Quelle]
 * @typedef {{bin: number[], nmax: number, quality: string, rules: [number, number, number[], string, string][],
 *   stats?: object, meta?: object}} RulesData
 * @typedef {{score: number, count: number, cons: Con[], pat: string, src: string}} StoredRule
 */

/**
 * @param {ReturnType<typeof generateRules>} res @param {string} quality @returns {RulesData}
 */
function packRulesData(res, quality) {
  return {
    bin: res.bin, nmax: res.nmax, quality,
    rules: res.rules.map((r) => [r.score, r.count, r.cons.flatMap((k) => [k.t[0], k.t[1], k.t[2], k.ax]), patternString(r.pat), r.src]),
    stats: res.stats, meta: res.meta
  };
}

/** @param {RulesData} data @returns {StoredRule[]} */
function unpackRules(data) {
  return data.rules.map((r) => {
    /** @type {Con[]} */ const cons = [];
    for (let k = 0; k < r[2].length; k += 4) cons.push({ t: [r[2][k], r[2][k + 1], r[2][k + 2]], ax: r[2][k + 3], D: data.bin[r[2][k + 3]] });
    return { score: Math.min(r[0], data.nmax), count: r[1], cons, pat: r[3], src: r[4] || "" };
  });
}

/**
 * Regelliste als Text, eine Regel pro Zeile.
 * @param {number[]} bin @param {number} nmax @param {{score: number, cons: Con[], pat: string}[]} rules
 * @param {boolean} withPattern Muster hinter "|" anhängen
 * @returns {string}
 */
function rulesToText(bin, nmax, rules, withPattern) {
  const head = [
    `# Regeln für Bin ${bin.map(numText).join(" x ")} mm (Länge x Breite x Höhe)`,
    "# Karton: l >= w >= h (längste, mittlere, kürzeste Kante). Es gilt die höchste Anzahl aller erfüllten Regeln.",
    `# "then ${nmax}" bedeutet ${nmax} oder mehr.${withPattern ? " Hinter | steht das Packmuster." : ""}`
  ];
  return head.concat(rules.map((r) => {
    const t = ruleText(r.cons, Math.min(r.score, nmax));
    return withPattern ? `${t} | ${r.pat}` : t;
  })).join("\n") + "\n";
}

if (typeof module !== "undefined") {
  module.exports = {
    PERMS, termLE, pruneTerms, treeTerms, dagTerms, patternTerms, patternCount, patternLayout, patternRule, pruneCons,
    consHold, ruleText, consText, termText, patternString, parsePattern, dpSolve, dpTable, normalSet, upperBoundInt, searchPack,
    portfolioSearch, dagFromPlacements, analyzeCarton, generateRules, layeredSearch, patternHasDag, QUALITY_PRESETS,
    genOptions, binKeyOf, packRulesData, unpackRules, rulesToText, numText, dot, vol, regionVertices, lookupRules,
    exampleCarton, verticesInside, reduceTree, bestGrid, addTerms, polyVertices, lpMax, domainRows, simplifyTree, treeCount
  };
}
