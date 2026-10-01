"use strict";
/*
 * Rechnet im Hintergrund, damit die Seite bedienbar bleibt.
 * Nachrichten: {type: "check"} prüft einen Karton, {type: "gen"} erzeugt eine Regelliste.
 */
importScripts("packcore.js");

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "check") {
    /** @param {string} phase @param {Analysis} a */
    const send = (phase, a) => self.postMessage({ type: "check", id: m.id, phase, count: a.count, upper: a.upper, status: a.status,
      pat: a.pattern ? patternString(a.pattern) : null, mixed: a.mixed });
    const a = analyzeCarton(m.carton, m.bin, m.budget, (x) => send("step", x));
    send("final", a);
  } else if (m.type === "gen") {
    const res = generateRules(m.bin, m.opt, (p) => self.postMessage({ type: "progress", id: m.id, p }));
    self.postMessage({ type: "gen", id: m.id, data: packRulesData(res, m.quality) });
  }
};
