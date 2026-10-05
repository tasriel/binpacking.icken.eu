# Kartonregeln

Wie viele gleiche Kartons passen in einen Bin, und nach welchem Packmuster?

Die Webseite in diesem Repository

- prüft einen einzelnen Karton und zeigt das beste gefundene Packmuster als 3D-Skizze mit Packreihenfolge und Positionen in mm,
- lädt gespeicherte Packmuster aus ihrer Textform,
- erzeugt für einen beliebigen Bin eine Regelliste im Format `when … then N`, jede Regel mit einem Packmuster als Beleg. Das geht für Quader-Bins und für konische Bins.

Kartons dürfen beliebig gedreht werden, auch jeder Karton anders. Alle Maße sind Innenmaße in mm.

„Karton prüfen“ zeigt in beiden Reitern sofort eine schnelle Rechnung (nur Blockmuster). Der Knopf „Genau rechnen“ startet die Suche nach verschränkten Mustern, im Quader-Bin bis zu 6 Sekunden (`EXACT_MS` in `app.js`), im konischen Bin bis zu 8 Sekunden (`CONE_EXACT_MS` in `cone-app.js`).

Die Seite hat zwei Reiter:

- **Quader-Bin:** gerade Wände. Karton prüfen, Muster laden, Regelliste.
- **Konischer Bin:** unten schmaler als oben, mit geradem Rand an der Öffnung. Karton prüfen, Muster laden, Regelliste. Siehe [Konischer Bin](#konischer-bin) und [Regeln für den konischen Bin](#regeln-für-den-konischen-bin).

Für die Quader-Bins **603 × 403 × 404** und **603 × 403 × 312** und für den konischen Bin mit den Maßen aus der Zeichnung (Öffnung 558 × 374, Rand 65, Boden 515 × 336, konischer Teil 344) liegen fertige Regellisten in [`rules/`](rules/).

## Schnellstart

Die Seite ist rein statisch: HTML, CSS und JavaScript, ohne Build-Schritt und ohne Abhängigkeiten. Gerechnet wird im Browser. Zum lokalen Testen genügt ein einfacher Webserver:

```sh
python3 -m http.server 8000
```

Dann <http://localhost:8000> öffnen. Direkt als Datei (`file://`) funktionieren die Hintergrundrechnung und das Laden der Regellisten nicht.

Nach Änderungen an CSS oder JavaScript die Kennung `v=…` in `index.html` erhöhen (Stylesheet und die fünf Script-Tags). Sie hängt auch am Worker und seinen Dateien. Ohne neue Kennung zeigen Browser oft noch die alten Dateien aus dem Zwischenspeicher; dann hilft neu laden mit Strg+Umschalt+R.

Die beiden Werkzeuge in `tools/` brauchen nur Node.js 18 oder neuer, kein `npm install`.

## Regeln lesen

```
when l+w<=403 and 4*h<=404 and 2*l+h<=603 and 4*w<=603 then 25 | Y(X(1x1x1:hwl,2x1x4:lwh),4x1x4:wlh)
```

- **l ≥ w ≥ h** sind die längste, mittlere und kürzeste Kante des Kartons. Kartonmaße müssen vor dem Auswerten so sortiert werden.
- Die Zahlen rechts sind die Bin-Maße: Länge, Breite und Höhe in der Reihenfolge, in der der Bin angegeben ist.
- Erfüllt ein Karton mehrere Regeln, gilt die **höchste** Anzahl.
- Die höchste Anzahl der Liste (Standard 30) bedeutet „so viele oder mehr“.
- Hinter `|` steht das Packmuster, das die Regel belegt.

Jede Regel ist durch ihr Muster belegt, sie zeigt also nie zu viele Kartons. Die Liste kann an einzelnen Stellen einen Karton zu wenig zeigen, wenn es ein Muster gibt, das der Rechner nicht gefunden hat (siehe [Verlässlichkeit](#verlässlichkeit)).

## Textform der Packmuster

Das Muster beschreibt nur die Anordnung, nicht die Maße. Wird es geladen, rechnet die Seite die Bedingungen für den eingestellten Bin neu aus.

| Schreibweise | Bedeutung |
|---|---|
| `2x1x3:wlh` | Block aus gleich gedrehten Kartons: 2 entlang der Bin-Länge, 1 entlang der Breite, 3 übereinander. Die drei Buchstaben sagen, welche Kartonkante entlang Länge, Breite und Höhe liegt. `wlh` heißt: w entlang der Länge, l entlang der Breite, h nach oben (der Karton liegt flach). |
| `X(…,…)` | Teile entlang der Bin-Länge hintereinander |
| `Y(…,…)` | Teile entlang der Bin-Breite nebeneinander |
| `Z(…,…)` | Teile übereinander |
| `B(hlw; wlh x1; lhw x1 z2)` | Kartonliste für verschränkte Muster. Jeder Eintrag nennt die Lage und optional Vorgänger: `x1` = entlang der Länge hinter Karton 1, `y…` = entlang der Breite, `z2` = auf Karton 2. Die Position ergibt sich jeweils aus dem weitesten Vorgänger. |

Gruppen und Kartonlisten lassen sich schachteln, zum Beispiel `X(1x1x1:hlw,2x1x3:wlh)` oder eine wiederholte Lage `X(B(…),B(…))`.

Zum Laden kann man das Muster allein oder die ganze Zeile `when … then N | Muster` einfügen.

## Wie die Regeln entstehen

Alle Kartons in 1-mm-Schritten wären rund 16 Millionen Kombinationen. Statt jeden Karton einzeln zu rechnen, sucht das Programm **Packmuster**. Aus einem Muster folgen Bedingungen der Form „Summe von Kartonkanten ≤ Bin-Maß“, und die gelten für einen ganzen Bereich von Kartongrößen. Einige hundert bis gut tausend solcher Bereiche decken alle Kartons ab.

1. **Gitter.** Alle Muster „a × b × c gleich gedrehte Kartons“ werden direkt als Regeln aufgenommen.
2. **Linien abtasten.** Zwei Kanten bleiben fest, die dritte läuft. Überall, wo die Anzahl laut Liste sinkt, prüft der Löser, ob dort doch mehr passen. Findet er ein besseres Muster, wird der Karton so weit vergrößert, wie das Muster noch passt, und das Muster wird als Regel aufgenommen. Das läuft erst auf festen Rastern (40, 20, 10 mm), dann auf zufälligen Linien, bis lange keine neue Regel mehr kommt.
3. **Aufräumen.** Regeln, deren Bereich ganz in einer anderen Regel mit mindestens gleicher Anzahl liegt, fallen weg. Übrig bleiben nur Regeln, die für mindestens einen Karton in ganzen Millimetern den Ausschlag geben.

Der Löser kennt drei Arten von Mustern:

- **Blockmuster:** Der Bin wird rekursiv in Blöcke aus gleich gedrehten Kartons geteilt (dynamische Programmierung über die möglichen Summen der Kartonkanten).
- **Lagenmuster:** Eine zweidimensional verschränkte Lage, zum Beispiel eine Windmühle, wird entlang einer Achse wiederholt.
- **Freie Muster:** Beliebig verschränkte Anordnungen, gefunden mit einer Tiefensuche mit Zeitlimit.

Aus einem Blockbaum ergeben sich die Bedingungen direkt: Entlang einer Teilungsachse addieren sich die Maße der Teile, quer dazu zählt das größte. Bei Kartonlisten liegt jeder Karton am weitesten Vorgänger an, die Bedingungen sind die längsten Ketten je Achse. Überflüssige Bedingungen werden mit einem kleinen linearen Programm unter l ≥ w ≥ h ≥ 0 entfernt.

## Verlässlichkeit

Stichproben mit `tools/validate-rules.js` für die mitgelieferten Listen (Genauigkeit „Gründlich“):

| Bin | Regeln | Liste unter Blockmuster-Löser | Liste unter Löser mit Suche (100 ms) | Mehr dank verschränkter Muster |
|---|---|---|---|---|
| 603 × 403 × 404 | 1.558 | 1 von 10.000 | 2 von 1.500 | etwa 13 % der Kartons |
| 603 × 403 × 312 | 2.060 | 3 von 10.000 | 7 von 1.500 | etwa 5 % der Kartons |

Alle Regeln wurden an der Ecke und an Zufallspunkten ihres Bereichs nachgebaut, ohne Überschneidung oder Überstand. Findet „Karton prüfen“ für einen Karton mehr als die Liste, lässt sich das Muster auf der Seite per Klick als Regel übernehmen. Solche Ergänzungen speichert die Seite im Browser.

## Konischer Bin

Der zweite Reiter rechnet für einen Bin, der sich nach unten verjüngt. Sechs Maße beschreiben ihn, alle sind Eingabefelder und werden im Browser gespeichert:

| Maß | Voreinstellung |
|---|---|
| Öffnung oben, Länge × Breite | 558 × 374 mm |
| Höhe des geraden Rands unter der Öffnung | 65 mm |
| Boden, Länge × Breite | 515 × 336 mm |
| Höhe des konischen Teils | 344 mm |

Die Voreinstellung steht in `cone.js` als `CONE_DEFAULT`. Der Bin ist symmetrisch: gegenüberliegende Wände sind gleich geneigt.

**Gültiges Muster**

- Kartons stehen gerade, nicht gekippt.
- Die Grundfläche eines Kartons muss in den Querschnitt auf Höhe seiner Unterkante passen. Weiter oben ist der Bin nur breiter.
- Kartons überschneiden sich nicht.
- Jeder Karton liegt auf dem Boden oder auf einem anderen Karton auf, mindestens 1 mm in beiden Richtungen (`CONE_SUPPORT`). Die kleinste Auflage im Muster zeigt die Seite an.

**Lösungsweg**

1. **Lagen.** Der Bin wird waagerecht in Lagen geteilt. Jede Lage ist ein Quader mit dem Querschnitt an ihrer Unterkante und wird mit dem Quader-Löser gepackt, auch gemischt und verschränkt. Eine dynamische Programmierung über alle möglichen Höhen (Summen von Kartonkanten) wählt die beste Folge. Zwei Lagen werden nur kombiniert, wenn jeder Karton der oberen auf der unteren aufliegt. Bei gleicher Anzahl gewinnt die Folge mit der besseren Auflage.
2. **Absenken und prüfen.** Die Lagen werden mittig gesetzt, jeder Karton fällt senkrecht bis zur Auflage. Das Ergebnis wird vollständig geprüft (Wände, Überschneidung, Auflage).
3. **Freie Suche.** Eine Tiefensuche direkt im Konus versucht, einen Karton mehr unterzubringen, auch mit Mustern, die sich nicht in Lagen zerlegen lassen. Sie probiert Positionen, an denen Kartons bündig an einer Wand oder an anderen Kartons liegen.

**Wie sicher das Ergebnis ist**

- *Optimal:* Eine rechnerische Obergrenze ist erreicht. Die Obergrenze nutzt, dass jede Unterkante auf einer Summe von Kartonkanten liegt und in jeder waagerechten Scheibe nur Summen von Kartonkanten nebeneinander passen.
- *Vollständig durchsucht:* Die freie Suche hat alle bündigen Anordnungen mit einem Karton mehr durchprobiert und nichts gefunden.
- *Offen:* Ein Karton mehr ist nicht ausgeschlossen.

Im Vergleich mit einem exakten Löser (CP-SAT) an 24 Kartons mit 4 bis 12 Stück stimmte das Ergebnis in 18 von 19 entschiedenen Fällen überein, einmal lag es um einen Karton darunter. Der Fall war ein Muster, das sich nicht in Lagen zerlegen lässt.

**Textform**

```
K(360x236x128; whl@43,59,0; whl@279,59,0; whl@43,187,0; whl@279,187,0)
```

Das ist ein freies Muster: zuerst die Kartonmaße, dann jeder Karton mit Lage und Ecke. Die drei Buchstaben sagen, welche Kartonkante entlang Länge, Breite und Höhe liegt. Hinter `@` stehen x, y, z in mm: x und y ab der Ecke der oberen Öffnung, z ab dem Boden. Beim Laden prüft die Seite das Muster gegen die eingestellten Bin-Maße. Lagenmuster haben eine eigene, kürzere Textform, siehe nächster Abschnitt.

## Regeln für den konischen Bin

```
when l<=336 and 4*h<=336+0.1104*h and 4*w<=515+0.125*h and l+h<=409 and 1<=0.5*w and h+1<=0.5*l then 19 | K(295x131x86; Z(3x1x1:wlh,4x4x1:whl))
```

Gelesen werden die Regeln wie beim Quader-Bin: l ≥ w ≥ h, es gilt die höchste Anzahl aller erfüllten Regeln, die höchste Anzahl der Liste heißt „so viele oder mehr“. Die Regeln gelten für Kartons ab 1 mm Kantenlänge und **nur für die Bin-Maße, mit denen sie berechnet wurden**. Die Seite rechnet immer mit den Maßen, die im Reiter eingestellt sind, und speichert die Liste unter genau diesen Maßen.

**Lagenmuster**

Jede Regel gehört zu einem Muster aus Lagen:

- Außen steht `Z(Lage, Lage, …)`, von unten nach oben. Bei einer einzigen Lage entfällt `Z(…)`.
- Eine Lage besteht aus Blöcken wie `3x1x2:wlh` (3 entlang der Länge, 1 entlang der Breite, 2 hoch, Drehung wie beim Quader-Bin), mit `X(…)` und `Y(…)` nebeneinander gelegt.
- Alle Lagen außer der obersten sind oben eben (alle Blöcke gleich hoch). Nur die oberste darf Blöcke unterschiedlicher Höhe enthalten.
- Jede Lage liegt mittig im Bin.

Die Textform ist `K(Karton; Blockbaum)`. Der Karton vorn ist ein Bezugskarton, für den das Muster passt. An ihm wird festgelegt, welcher Karton auf welchem aufliegt. Ohne Bezugskarton (`K(Z(…))`) sucht die Seite beim Laden selbst einen passenden.

**Bedingungen**

| Art | Beispiel | Bedeutung |
|---|---|---|
| Wand | `4*w<=515+0.125*h` | Eine Lage mit Unterkante in der Höhe z darf höchstens so lang sein wie der Bin dort: Bodenlänge + Steigung · z. Hier steht die Lage auf einer Lage der Höhe h, also z = h. Die Steigung ist (Länge oben − Länge unten) / Höhe des konischen Teils, hier 43 / 344 = 0,125; für die Breite 38 / 344 ≈ 0,1105. |
| Wand im geraden Rand | `3*w<=558` | Reicht eine Lage in den geraden Rand, darf sie höchstens so lang sein wie die Öffnung. Beide Wand-Bedingungen zusammen beschreiben den Knick ohne Fallunterscheidung. |
| Höhe | `l+h<=409` | Die Summe der Lagenhöhen bleibt unter der Gesamthöhe. |
| Auflage | `h+1<=0.5*l` | Jeder Karton einer oberen Lage liegt mindestens 1 mm (`CONE_SUPPORT`) auf einem bestimmten Karton darunter. Der Faktor 0.5 kommt daher, dass die Lagen mittig liegen. |

In der Textform stehen höchstens vier Nachkommastellen. Gerundet wird so, dass eine Bedingung höchstens strenger wird.

**Entstehung**

Wie beim Quader-Bin: Start mit einfachen Gittern am Boden, dann Abtasten entlang von Linien, zum Schluss Aufräumen. An jedem Prüfpunkt sucht eine dynamische Programmierung das beste Lagenmuster: für jede mögliche Höhe (Summe von Kartonkanten) die beste ebene Lage im Querschnitt dort und die beste oberste Lage aus unterschiedlich hohen Stapeln. Zwei Lagen werden nur kombiniert, wenn jeder Karton der oberen aufliegt. Überflüssige Bedingungen fallen weg; übrig bleiben die, die eine Seitenfläche des Regelbereichs bilden.

Weil die Auflage dazukommt, sind die Bereiche kleiner als beim Quader-Bin. Für den Bin aus der Zeichnung entstehen deshalb 4.661 Regeln, etwa dreimal so viele wie für einen Quader-Bin.

**Verlässlichkeit**

Stichproben mit `tools/validate-rules.js` für die mitgelieferte Liste (Genauigkeit „Gründlich“):

| Prüfung | Ergebnis |
|---|---|
| Muster nachgebaut (Wände, Überschneidung, Auflage) | 87.003 Nachbauten, 0 Fehler |
| Liste unter dem Lagenmuster-Löser | 9 von 10.000 Kartons, jeweils um 1 bis 2 |
| Liste unter der schnellen Rechnung von „Karton prüfen“ | 118 von 10.000 Kartons; bei 68 von 10.000 liegt die Liste darüber |

Die Liste kennt nur Lagenmuster. „Karton prüfen“ packt Lagen auch gemischt hoch und verschränkt und sucht mit „Genau rechnen“ frei im Konus; damit findet es gelegentlich einen Karton mehr. Zeigt „Karton prüfen“ mehr als die Liste und ist das Muster ein Lagenmuster, lässt es sich per Klick als Regel übernehmen.

## Regeln erzeugen und prüfen

Auf der Seite: Bin-Maße eintragen, Genauigkeit wählen, „Regeln berechnen“. Das läuft im Hintergrund und wird nur im Browser gespeichert, getrennt für jede Kombination von Bin-Maßen. „Als Textdatei speichern“ lädt jede Liste als Text herunter. Das gilt für beide Reiter.

Damit eine Liste für alle Besucher sofort da ist, wird sie ins Repository gelegt:

```sh
# Regelliste erzeugen -> rules/603x403x404.json, Eintrag in rules/index.json
node tools/generate-rules.js 603 403 404 --quality full --nmax 30

# optional zusätzlich als Text
node tools/generate-rules.js 603 403 404 --quality full --txt regeln_603x403x404.txt

# Regelliste prüfen: Muster nachbauen und Stichprobe gegen den Löser
node tools/validate-rules.js rules/603x403x404.json --samples 5000 --search-ms 100

# Konischer Bin: Öffnung Länge, Breite, Randhöhe, dann Boden Länge, Breite, Höhe des konischen Teils
node tools/generate-rules.js --cone 558 374 65 515 336 344 --quality full
node tools/validate-rules.js rules/konisch-558x374x65-515x336x344.json --samples 5000
```

| Genauigkeit | Ablauf | Dauer (Node, ein Kern) |
|---|---|---|
| `fast` | Raster 40 mm mit Suche, Raster 20 mm | etwa 1 Minute |
| `std` | wie `fast`, dann Zufallslinien bis 4.000 Linien ohne neue Regel | etwa 3 Minuten |
| `full` | Raster 40 und 20 mm mit Suche, Raster 10 mm, dann Zufallslinien bis 15.000 Linien ohne neue Regel | etwa 6 bis 8 Minuten |

Für den konischen Bin (ohne Suche nach verschränkten Lagen):

| Genauigkeit | Ablauf | Dauer (Node, ein Kern) | Regeln, Bin aus der Zeichnung |
|---|---|---|---|
| `fast` | Raster 40 und 20 mm | etwa 45 Sekunden | 2.319 |
| `std` | wie `fast`, dann Zufallslinien bis 1.000 Linien ohne neue Regel | etwa 3 Minuten | 4.423 |
| `full` | Raster 40, 20 und 10 mm, dann Zufallslinien bis 15.000 Linien ohne neue Regel | etwa 4 Minuten | 4.661 |

Die Seite lädt eine Liste aus `rules/` automatisch, sobald die passenden Bin-Maße eingestellt sind. Danach committen und pushen, fertig.

## Aufbau

```
index.html            Seite
style.css             Gestaltung, helles und dunkles Farbschema
favicon.svg           Icon der Seite; favicon.ico und apple-touch-icon.png sind daraus erzeugt
app.js                Bedienung: Reiter, Quader-Bin, Zeichnung
cone-app.js           Bedienung: Reiter „Konischer Bin“
worker.js             Hintergrundrechnung (lädt packcore.js, cone.js und cone-rules.js)
packcore.js           Rechenkern Quader: Löser, Muster, Regeln, Textform, Regelerzeugung (Browser und Node)
cone.js               Rechenkern konischer Bin: Geometrie, Lagen, Absenken, freie Suche, Textform (Browser und Node)
cone-rules.js         Regeln konischer Bin: Lagenmuster, Bedingungen, Textform, Regelerzeugung (Browser und Node)
rules/                vorberechnete Regellisten, index.json listet die vorhandenen Bins
tools/
  generate-rules.js   Regelliste erzeugen (Node)
  validate-rules.js   Regelliste prüfen (Node)
```

Format der Dateien in `rules/`:

```json
{
  "bin": [603, 403, 404],
  "nmax": 30,
  "quality": "full",
  "rules": [[25, 25, [1, 1, 0, 1,  0, 0, 4, 2,  2, 0, 1, 0,  0, 4, 0, 0], "Y(X(1x1x1:hwl,2x1x4:lwh),4x1x4:wlh)", "dp"]]
}
```

Jede Regel ist `[Anzahl (gedeckelt auf nmax), Kartons im Muster, Bedingungen, Muster, Quelle]`. Die Bedingungen stehen flach in Vierergruppen `[a, b, c, Achse]` für `a*l + b*w + c*h <= Bin-Maß der Achse` (Achse 0 = Länge, 1 = Breite, 2 = Höhe). Die Quelle ist `grid`, `dp`, `search` oder `manual`.

Listen für den konischen Bin heißen `konisch-<obenL>x<obenB>x<Rand>-<untenL>x<untenB>x<konischH>.json`. Statt `bin` steht dort `cone` mit den sechs Maßen (`topL`, `topW`, `rimH`, `botL`, `botW`, `coneH`). Die Bedingungen stehen flach in Achtergruppen `[p0, p1, p2, n0, n1, n2, b, Art]` für `(p0-n0)*l + (p1-n1)*w + (p2-n2)*h <= b`. `p` ist der Anteil, der in der Textform links steht, `n` der rechts; Art 0 = Wand, 1 = Höhe, 2 = Auflage.

## Veröffentlichen

Alles, was die Seite braucht, liegt im Wurzelverzeichnis. Jeder Webspace oder Hoster für statische Seiten kann das Repository direkt ausliefern. Auf dem Server wird weder Node.js noch npm gebraucht.

Bei Webhosting mit Plesk (zum Beispiel netcup): unter „Git“ ein Repository für die Domain anlegen, Bereitstellung auf „automatisch“ stellen und als Zielordner `httpdocs` wählen, oder einen Unterordner bzw. eine Subdomain, wenn dort schon eine andere Seite liegt. Zusätzliche Bereitstellungsaktionen sind nicht nötig.

Remote hinzufügen und hochladen:

```sh
git remote add origin <URL-des-Website-Repositorys>
git push -u origin main
```

Liegt die Seite dort in einem Unterordner, funktionieren alle Pfade weiter, weil sie relativ sind.
