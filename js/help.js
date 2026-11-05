// Help content: used by the app's help tab and by hilfe.html (the same page as a link for friends).
// Texts German, plain sentences (Gonzo's text rules: no filler words, complete sentences).

export const CHANNEL_URL = 'https://www.youtube.com/@gonzootv9036';   // GonzooTV = channel UCBmfRL6zY0-n11iwbJYSMqA
export const FAN_CONTENT = 'Kartenkiste is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.';

export const DIAGRAM = `
<figure class="flow" aria-label="So funktioniert die App">
  <div class="zone phone">
    <div class="zone-title">Alles passiert in deinem Handy</div>
    <ol class="steps">
      <li><b>Kamera</b><span>Du fotografierst eine Karte.</span></li>
      <li><b>Karte finden</b><span>Die App sucht den Kartenrand und richtet die Karte gerade aus.</span></li>
      <li><b>Name lesen und Bild vergleichen</b><span>Sie liest Titel und Sammlernummer und vergleicht das Bild.</span></li>
      <li><b>Kartenliste</b><span>Alle Karten liegen als Datenpaket im Handy, deshalb geht das auch offline.</span></li>
      <li><b>Deine Sammlung</b><span>Sie bleibt im Handy. Es gibt kein Konto.</span></li>
      <li><b>Sicherungsdatei</b><span>Mit einem Tipp legst du sie in iCloud Drive oder Google Drive ab.</span></li>
    </ol>
  </div>
  <div class="zone net">
    <div class="zone-title">Nur das kommt aus dem Internet</div>
    <ul class="plain">
      <li><b>Kartenbilder</b> von Scryfall. Was du einmal gesehen hast, zeigt die App auch offline.</li>
      <li><b>Preise</b> von Scryfall, wenn du auf „Preise aktualisieren“ tippst oder eine Karte scannst.</li>
      <li><b>Neue Kartenliste</b>, wenn es neue Sets gibt. Sie kommt von Scryfall über GitHub auf dein Handy.</li>
    </ul>
  </div>
  <p class="flow-note">Nichts davon landet bei GonzooTV, und niemand sieht deine Sammlung.</p>
</figure>`;

export const INSTALL = `
<div class="two">
  <div class="box"><h4>iPhone (Safari)</h4>
    <ol>
      <li>Den Link in <b>Safari</b> öffnen.</li>
      <li>Unten auf das Teilen-Symbol tippen (Quadrat mit Pfeil nach oben).</li>
      <li><b>„Zum Home-Bildschirm“</b> wählen und auf „Hinzufügen“ tippen.</li>
      <li>Die App ab jetzt über das neue Symbol öffnen.</li>
    </ol>
  </div>
  <div class="box"><h4>Android (Chrome)</h4>
    <ol>
      <li>Den Link in <b>Chrome</b> öffnen.</li>
      <li>Oben rechts auf die drei Punkte tippen.</li>
      <li><b>„App installieren“</b> wählen (manchmal heißt es „Zum Startbildschirm hinzufügen“).</li>
      <li>Die App ab jetzt über das neue Symbol öffnen.</li>
    </ol>
  </div>
</div>
<p class="small">Safari und die installierte App haben auf dem iPhone getrennte Speicher. Scanne deshalb gleich in der installierten App.</p>`;

export const SCAN_TIPS = `
<ul class="tips">
  <li><b>Dunkle, ruhige Unterlage.</b> Auf einer einfarbigen Matte oder einem dunklen Tisch findet die App den Kartenrand am besten.</li>
  <li><b>Ganze Karte im Rahmen.</b> Die Karte soll den Rahmen fast ausfüllen, ohne dass eine Ecke abgeschnitten ist.</li>
  <li><b>Licht ohne Spiegelung.</b> Halte das Handy so, dass keine Lampe auf der Karte glänzt. Karten in Hüllen spiegeln stärker, dann hilft es, das Handy etwas schräg zu halten.</li>
  <li><b>Erst auf „Karte erkannt“ warten.</b> Wird der Rand grün, ist die Karte gefunden und du kannst auslösen.</li>
</ul>`;

/** full help; inApp adds the storage status box (filled by the app) and the backup buttons */
export function helpHtml({ inApp = false } = {}) {
  return `
<section class="help">
  <h2>So funktioniert die App</h2>
  ${DIAGRAM}

  <h2>Installieren</h2>
  ${INSTALL}

  <h2>Gut scannen</h2>
  ${SCAN_TIPS}

  <h2>Karten wegräumen</h2>
  <p>Die App sagt dir zu jeder Karte, in welches <b>Fach</b> deiner Kiste sie gehört. Wie die Kiste aufgeteilt ist, suchst du
  unter Sammlung → „Fächer & Ordner“ aus:</p>
  <ul>
    <li><b>Nach Farbe:</b> ein Fach je Farbe, dazu Mehrfarbig, Farblos & Artefakte und Länder.</li>
    <li><b>Nach Kartentyp:</b> ein Fach je Typ, also Kreaturen, Spontanzauber, Hexereien und so weiter.</li>
    <li><b>Nach Aufgabe:</b> ein Fach je Aufgabe im Commander, zum Beispiel Removal, Kartenziehen oder Ramp.</li>
  </ul>
  <p>Passen 100 Karten in ein Fach, beginnt danach ein zweites, zum Beispiel „Schwarz 2“. Wechselst du später das System,
  zeigt dir die App vorher eine Umräumliste.</p>
  <p>Für den <b>Ordner</b> gilt eine einzige Regel: Karten ab 3 € kommen hinein. Ordner und Bulk kannst du auch abschalten. Die Seltenheit spielt keine Rolle, die App
  entscheidet nach dem Preis. Sehr billige Karten unter 0,20 €, die kaum jemand spielt, schlägt sie für <b>Bulk</b> vor.
  Taugt so eine Karte trotzdem etwas, tippst du auf „Behalten“, dann kommt der Vorschlag nie wieder.</p>
  <p>Neue Scans landen bei <b>„Einsortieren“</b>. Dort siehst du, wohin jede Karte gehört, die Karten für den Ordner zuerst.
  Leg die Karte an ihren Platz, hake sie ab und tippe zum Schluss auf „Speichern“. Mit den Farben oben gehst du eine Farbe
  nach der anderen durch. Für Ordner und Bulk braucht die App die Preise, tippe dafür auf „Preise aktualisieren“.</p>
  <p>Eine nachgedruckte Karte markierst du in der Karte als <b>Proxy</b>. Sie zählt dann als Karte, aber nicht zum Wert, und
  die App schlägt sie nie für den Ordner oder Bulk vor.</p>

  <h2>Karten eintippen</h2>
  <p>Wenn eine Karte nicht erkannt wird, tippst du den Namen ein, ab zwei Buchstaben auf Deutsch oder Englisch. Danach wählst du
  Edition, Sprache, Anzahl, Foil und Proxy. Mit „Liste einfügen“ trägst du viele Karten auf einmal ein, eine pro Zeile, zum
  Beispiel „1 Sol Ring“. Die App zeigt vorher, was sie gefunden hat, und schlägt bei Tippfehlern Karten vor.</p>

  <h2>Decks</h2>
  <p>Im Reiter <b>Decks</b> legst du Commander-Decks an. Wähle den Commander und füge Karten per Scan, Eintippen oder aus deiner
  Sammlung hinzu. Die App prüft die Regeln: 100 Karten, die Farbidentität des Commanders, jede Karte nur einmal (außer Standardländer)
  und ob Karten verboten sind. Bei jeder Karte siehst du, ob du sie besitzt, ob ein anderes Deck sie schon braucht und wie viele fehlen.
  Die Zahlen zu Ramp, Kartenziehen, Removal und Länder zeigen, was in einem Commander-Deck üblich ist. Es sind Richtwerte, keine Regeln.</p>
  <p>Zum Scannen für ein Deck setzt du in dem Deck das Häkchen „Beim Scannen in dieses Deck legen“. Dann kommt jede gescannte Karte
  in die Sammlung und ins Deck.</p>

  <h2>Deine Daten</h2>
  <p>Deine Sammlung liegt nur in diesem Handy. Löschst du die App, ist sie weg. Speichere deshalb ab und zu eine
  <b>Sicherungsdatei</b>. Die App erinnert dich daran, wenn du viele Karten hinzugefügt hast.</p>
  <p>Auf dem iPhone wählst du im Teilen-Menü „In Dateien sichern“ und dann iCloud Drive. Auf Android landet die Datei
  in „Downloads“, von dort kannst du sie in Google Drive hochladen.</p>
  <p>Auf einem neuen Handy oder nach dem Neuinstallieren tippst du auf <b>„Sicherung laden“</b> und wählst die Datei aus.</p>
  ${inApp ? '<div id="help-status" class="box small">Speicher wird geprüft …</div><div class="buttons"><button id="help-save">Sicherung speichern</button><button id="help-load">Sicherung laden</button></div>' : ''}

  <h2>Was offline geht</h2>
  <p>Scannen, die Sammlung und die Sicherung funktionieren ohne Internet, auch im Flugmodus. Eine Verbindung brauchen
  nur Kartenbilder, die du noch nie gesehen hast, und die Preise. Beim ersten Start lädt die App einmalig das Datenpaket mit allen
  Karten (etwa 30 MB, am besten im WLAN).</p>

  <h2>Über die Kartenkiste</h2>
  <p>Die Kartenkiste ist von <b>GonzooTV</b>. Sie ist kostenlos, ohne Werbung und ohne Konto. Wenn du magst, schau auf
  meinem YouTube-Kanal vorbei: <a href="${CHANNEL_URL}" target="_blank" rel="noopener">GonzooTV auf YouTube</a>.</p>
  <p>Datenschutz: Die App sammelt nichts und schickt nichts an GonzooTV. Kartenbilder und Preise holt sie von Scryfall
  (cards.scryfall.io und api.scryfall.com). Für die Preise schickt sie dabei die Kennungen deiner Karten mit, aber
  keinen Namen und kein Konto. Scryfall sieht wie jede Webseite deine IP-Adresse.</p>
  <h2>Preise</h2>
  <p>Die Preise kommen von Scryfall, das sie von Cardmarket übernimmt. Sie sind ein Richtwert für die englische
  Ausgabe einer Karte und nicht der Preis, den du beim Verkauf bekommst. Hat eine Karte keinen Euro-Preis, zeigt die
  App den Dollar-Preis.</p>
  <p class="small">Kartendaten und Kartenbilder: <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>.
  Die Kartenkiste ist kein Angebot von Scryfall.</p>
  <p class="small" lang="en">${FAN_CONTENT}</p>
  <p class="small">Verwendete Software: OpenCV (Apache-2.0), ONNX Runtime Web (MIT), PaddleOCR-Modelle (Apache-2.0).</p>
  <p class="small">© 2026 GonzooTV, alle Rechte vorbehalten.</p>
</section>`;
}
