"use strict";
/*
 * Rechnet im Hintergrund, damit die Seite bedienbar bleibt.
 * Nachrichten:
 *   {type: "check"}    prüft einen Karton im Quader-Bin (dpWork = Aufwand für Blockmuster,
 *                      budget = Zeit für die Suche nach verschränkten Mustern)
 *   {type: "cone"}     prüft einen Karton im konischen Bin (symWork = Aufwand für Lagenmuster,
 *                      budget = Zeit für verschränkte Lagen und freie Suche)
 *   {type: "gen"}      erzeugt die Regelliste eines Quader-Bins
 *   {type: "conegen"}  erzeugt die Regelliste eines konischen Bins
 *   {type: "genest"}   schätzt die Dauer einer Regelerzeugung (cone: true für den konischen Bin)
 */
// dieselbe Versionskennung wie die Seite (worker.js?v=…), damit nichts Altes aus dem Zwischenspeicher kommt
const V = self.location.search;
importScripts("packcore.js" + V, "cone.js" + V, "cone-rules.js" + V);

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "check") {
    /** @param {string} phase @param {Analysis} a */
    const send = (phase, a) => self.postMessage({ type: "check", id: m.id, phase, count: a.count, upper: a.upper, status: a.status,
      pat: a.pattern ? patternString(a.pattern) : null, mixed: a.mixed, approx: a.approx, searchable: a.searchable, effort: a.effort });
    const a = analyzeCarton(m.carton, m.bin, m.budget, (x) => send("step", x), { dpWork: m.dpWork });
    send("final", a);
  } else if (m.type === "cone") {
    /** @param {ConeAnalysis} a */
    const send = (a) => self.postMessage({ type: "cone", id: m.id, result: a });
    send(analyzeConeLayers(m.carton, m.bin, m.budget, send, { symWork: m.symWork }));
  } else if (m.type === "conegen") {
    const res = generateConeRules(m.bin, m.opt, (p) => self.postMessage({ type: "progress", id: m.id, p }));
    self.postMessage({ type: "conegen", id: m.id, data: packConeRules(res, m.quality) });
  } else if (m.type === "gen") {
    const res = generateRules(m.bin, m.opt, (p) => self.postMessage({ type: "progress", id: m.id, p }));
    self.postMessage({ type: "gen", id: m.id, data: packRulesData(res, m.quality) });
  } else if (m.type === "genest") {
    const est = m.cone ? estimateConeRulesMs(m.bin, m.quality, m.nmax, m.res) : estimateRulesMs(m.bin, m.quality, m.nmax, m.res);
    self.postMessage({ type: "genest", ms: est.ms });
  }
};
