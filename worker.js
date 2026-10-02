"use strict";
/*
 * Rechnet im Hintergrund, damit die Seite bedienbar bleibt.
 * Nachrichten: {type: "check"} prüft einen Karton im Quader-Bin, {type: "gen"} erzeugt
 * eine Regelliste, {type: "cone"} prüft einen Karton im konischen Bin.
 */
// dieselbe Versionskennung wie die Seite (worker.js?v=…), damit nichts Altes aus dem Zwischenspeicher kommt
const V = self.location.search;
importScripts("packcore.js" + V, "cone.js" + V);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "check") {
    /** @param {string} phase @param {Analysis} a */
    const send = (phase, a) => self.postMessage({ type: "check", id: m.id, phase, count: a.count, upper: a.upper, status: a.status,
      pat: a.pattern ? patternString(a.pattern) : null, mixed: a.mixed });
    const a = analyzeCarton(m.carton, m.bin, m.budget, (x) => send("step", x));
    send("final", a);
  } else if (m.type === "cone") {
    /** @param {ConeAnalysis} a */
    const send = (a) => self.postMessage({ type: "cone", id: m.id, result: a });
    send(analyzeCone(m.carton, m.bin, m.budget, send));
  } else if (m.type === "gen") {
    const res = generateRules(m.bin, m.opt, (p) => self.postMessage({ type: "progress", id: m.id, p }));
    self.postMessage({ type: "gen", id: m.id, data: packRulesData(res, m.quality) });
  }
};
