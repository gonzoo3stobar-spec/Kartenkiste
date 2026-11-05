// "Was ist neu?": the release notes friends see once after their installed app has updated itself (newest first).
// Every new release only needs a new entry at the TOP: a new id, the date, a title and 3 to 5 short German sentences without
// technical words. The app remembers the last id a person has seen (IndexedDB meta 'lastSeenRelease').

export const RELEASES = [
  {
    id: '2026-11-11-stability',
    date: '11. November 2026',
    title: 'Stabiler scannen auf dem Handy',
    points: [
      'Der Scanner lässt sich nach einem fehlgeschlagenen Foto wieder benutzen.',
      'Die Kamera startet zuverlässiger, auch wenn du zwischen Apps oder Ansichten wechselst.',
      'Die Bildgröße beim Scannen passt sich an dein Gerät an: mehr Qualität, wenn es die Ressourcen erlauben, weniger Last bei Engpässen.',
      'Bei Verbindungsproblemen nutzt die App ihre gespeicherte Version. Preisabfragen bleiben nicht mehr endlos hängen.',
      'Kartenansichten sind sparsamer. Fehlerhafte Sicherungsdateien werden vor dem Laden abgefangen.',
    ],
  },
  {
    id: '2026-11-11-shutter',
    date: '11. November 2026',
    title: 'Rückmeldung beim Fotografieren',
    points: [
      'Beim Fotografieren hörst du jetzt einen kurzen Auslöseton.',
      'Die Kameravorschau blitzt kurz auf, sobald das Bild aufgenommen ist.',
      'Auf Handys, die es unterstützen, spürst du außerdem eine kurze Vibration.',
    ],
  },
  {
    id: '2026-11-07',
    date: '7. November 2026',
    title: 'Decks, Eintippen und Wegräumen',
    points: [
      'Decks: Lege Commander-Decks an. Die App prüft die Regeln und zeigt dir, welche Karten noch fehlen.',
      'Eintippen: Suche eine Karte per Name auf Deutsch oder Englisch, oder füge eine ganze Liste auf einmal ein.',
      'Wegräumen: Such dir aus, ob deine Kiste nach Farbe, Kartentyp oder Aufgabe sortiert ist. Die App sagt dir bei jeder Karte, in welches Fach sie gehört.',
      'Ordner und Bulk: Karten ab 3 € schlägt die App für den Ordner vor, sehr billige für Bulk. Nachgedruckte Karten markierst du als Proxy, sie zählen dann nicht zum Wert.',
      'Einsortieren: Neue Karten liegen auf einem Stapel, den du Farbe für Farbe abhakst und dann speicherst. Die Fenster passen jetzt auf jedes iPhone, ohne dass du zoomen musst.',
    ],
  },
];

export const newestId = () => RELEASES[0].id;
/** the releases after `lastSeen` (newest first, at most `max`); all of them when lastSeen is unknown */
export function since(lastSeen, max = 3) {
  const k = RELEASES.findIndex(r => r.id === lastSeen);
  return (k < 0 ? RELEASES : RELEASES.slice(0, k)).slice(0, max);
}
