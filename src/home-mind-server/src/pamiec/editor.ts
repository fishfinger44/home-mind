/**
 * Strona podglądu pamięci — cała w tym module, bo serwer nie serwuje plików
 * statycznych (build emituje sam JS, więc `.html` nie trafiłby do obrazu).
 * Ten sam układ co edytor reguł.
 */

export const EDYTOR_PAMIECI_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pamięć asystenta</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#ddd; --bad:#b3261e; --ok:#0a7d32; --tlo2:#f6f6f6; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#eee; --bg:#151515; --muted:#9a9a9a; --line:#333; --bad:#f2b8b5; --ok:#7ddb9a; --tlo2:#1e1e1e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .5rem; }
  .sub { color:var(--muted); margin:0 0 1rem; font-size:.9rem; }
  .pasek { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; margin-bottom:1rem; }
  select, button { font:inherit; padding:.4rem .7rem; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  button { cursor:pointer; }
  button.usun { border-color:var(--bad); color:var(--bad); }
  button.przyjmij { border-color:var(--ok); color:var(--ok); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .wpis { border:1px solid var(--line); border-radius:8px; padding:.7rem .9rem; margin-bottom:.5rem; background:var(--tlo2); }
  .wpis .gora { display:flex; gap:.5rem; align-items:center; justify-content:space-between; }
  .tresc { margin:.2rem 0; overflow-wrap:anywhere; }
  .meta { color:var(--muted); font-size:.82rem; }
  .znacznik { font-size:.75rem; border:1px solid var(--line); border-radius:99px; padding:.05rem .5rem; color:var(--muted); white-space:nowrap; }
  .odrzucony { opacity:.72; }
  .kontrola { border:1px solid var(--line); border-left-width:4px; border-radius:8px; padding:.7rem .9rem; margin-bottom:.5rem; background:var(--tlo2); }
  .kontrola.sprzeczny { border-left-color:var(--bad); }
  .kontrola.pokryty { border-left-color:var(--muted); }
  .kontrola .czym { color:var(--muted); font-size:.85rem; margin-top:.2rem; }
  .pusto { color:var(--muted); font-style:italic; }
  .akcje { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; margin-top:.5rem; }
  .gora .akcje { margin-top:0; }
  #stan { min-height:1.2em; color:var(--muted); font-size:.85rem; }
</style>
</head>
<body>
<h1>Pamięć asystenta</h1>
<p class="sub">Fakty, które asystent zapamiętał, oraz to, czego filtry nie wpuściły. Edycji nie ma celowo — pamięć nie zna aktualizacji, poprawka znaczyłaby utratę historii faktu.</p>

<div class="pasek">
  <label>Profil:
    <select id="profil"></select>
  </label>
  <button id="odswiez">Odśwież</button>
  <button id="kontrola">Sprawdź z regułami</button>
  <span id="stan"></span>
</div>

<div id="znaleziska"></div>

<h2>Zapamiętane fakty (<span id="licznik-faktow">0</span>)</h2>
<div id="fakty"></div>

<h2>Odrzucone — nie ma ich w pamięci (<span id="licznik-odrzuconych">0</span>)</h2>
<p class="sub">Wpisy z filtrów. <strong>Nic z tego nie działa</strong>, dopóki nie przyjmiesz tego świadomie.</p>
<div id="odrzucone"></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const stan = (t) => { $("stan").textContent = t; };

async function wczytajProfile() {
  // Lista rosnie sama: osoby z HA + profile widziane w dzienniku odrzucen.
  // Drugi domownik z wlasnym odciskiem glosu pojawi sie tu bez zmiany kodu.
  const { profile } = await fetch("/api/pamiec/profile").then(r => r.json());
  const wybrany = $("profil").value;
  $("profil").innerHTML = (profile || []).map(p =>
    \`<option value="\${esc(p.id)}">\${esc(p.nazwa)} — \${esc(p.faktow)} faktów</option>\`
  ).join("");
  if (wybrany) $("profil").value = wybrany;
}

async function wczytaj() {
  stan("wczytuję…");
  const profil = $("profil").value;
  const [f, p] = await Promise.all([
    fetch("/api/memory/" + encodeURIComponent(profil)).then(r => r.json()),
    fetch("/api/pominiete").then(r => r.json()),
  ]);
  rysujFakty(f.facts || [], profil);
  rysujOdrzucone(p.pominiete || []);
  stan("");
}

// Profil wspolny trzyma tylko wiedze o domu — te same kategorie, ktore
// przepuszcza zapis z rozmowy (IMPERSONAL_FACT_CATEGORIES na serwerze).
const BEZOSOBOWE = ["device", "baseline", "correction"];

function rysujFakty(fakty, profil) {
  $("licznik-faktow").textContent = fakty.length;
  const wspolny = profil === "default";
  $("fakty").innerHTML = fakty.length ? fakty.map(f => {
    // W profilu wspolnym nie ma dokad przenosic; przy fakcie osobistym przycisk
    // zostaje widoczny, ale wylaczony — inaczej regula bylaby niewidzialna.
    const osobisty = !BEZOSOBOWE.includes(f.category);
    const przenies = wspolny ? "" : \`<button class="przenies" data-przenies="\${esc(f.id)}" data-profil="\${esc(profil)}"\${
      osobisty ? \` disabled title="Kategoria „\${esc(f.category)}” opisuje osobę — profil wspólny trzyma tylko wiedzę o domu."\` : ""
    }>Przenieś do wspólnego</button>\`;
    return \`
    <div class="wpis">
      <div class="gora">
        <span class="znacznik">\${esc(f.category)}</span>
        <span class="akcje">\${przenies}<button class="usun" data-fakt="\${esc(f.id)}" data-profil="\${esc(profil)}">Usuń</button></span>
      </div>
      <div class="tresc">\${esc(f.content)}</div>
      <div class="meta">użyć: \${esc(f.useCount ?? 0)} · dodany: \${esc((f.createdAt || "").slice(0,16).replace("T"," "))}</div>
    </div>\`;
  }).join("") : '<p class="pusto">Brak faktów w tym profilu.</p>';
}

function rysujOdrzucone(wpisy) {
  $("licznik-odrzuconych").textContent = wpisy.length;
  $("odrzucone").innerHTML = wpisy.length ? wpisy.map(w => {
    // Dwa rodzaje wpisow wymagaja dwoch roznych drog: tresc z filtru JEST
    // faktem, tresc z bramki to surowa wypowiedz, ktora trzeba dopiero
    // przepuscic przez ekstrakcje.
    const akcja = w.rodzaj === "filtr"
      ? \`<select data-kat="\${esc(w.id)}">
           <option value="">— kategoria —</option>
           \${["baseline","preference","identity","device","pattern","correction"].map(k => \`<option>\${k}</option>\`).join("")}
         </select>
         <button class="przyjmij" data-przyjmij="\${esc(w.id)}">Przyjmij do pamięci</button>\`
      : \`<button class="przyjmij" data-przyjmij="\${esc(w.id)}">Przepuść przez ekstrakcję</button>\`;
    return \`
    <div class="wpis odrzucony">
      <div class="gora">
        <span class="znacznik">\${w.rodzaj === "filtr" ? "odrzucony fakt" : "cała tura (polecenie)"}</span>
        <button class="usun" data-odrzuc="\${esc(w.id)}">Usuń z listy</button>
      </div>
      <div class="tresc">\${esc(w.tresc)}</div>
      <div class="meta">\${esc((w.kiedy || "").slice(0,16).replace("T"," "))} · \${esc(w.powod)}\${w.narzedzia?.length ? " · narzędzia: " + esc(w.narzedzia.join(", ")) : ""}</div>
      <div class="akcje">\${akcja}</div>
    </div>\`;
  }).join("") : '<p class="pusto">Nic nie zostało odrzucone.</p>';
}

function rysujZnaleziska(w) {
  // Wynik NIE jest sporem do rozstrzygnięcia: reguła jest pisana ręcznie i
  // pilnowana, fakt powstał sam. Dlatego jedyna akcja to skasowanie faktu.
  if (w.blad) {
    $("znaleziska").innerHTML = \`<div class="kontrola sprzeczny">Kontrola się nie powiodła: \${esc(w.blad)}</div>\`;
    return;
  }
  if (!w.znaleziska.length) {
    $("znaleziska").innerHTML = \`<p class="pusto">Sprawdzono \${esc(w.sprawdzono)} faktów — nic nie kłóci się z regułami ani ich nie powtarza.</p>\`;
    return;
  }
  $("znaleziska").innerHTML = w.znaleziska.map(z => \`
    <div class="kontrola \${esc(z.rodzaj)}">
      <div class="gora">
        <span class="znacznik">\${z.rodzaj === "sprzeczny" ? "sprzeczny z regułą" : "powtarza regułę"} · \${esc(z.regula)}</span>
        <button class="usun" data-fakt="\${esc(z.factId)}" data-profil="\${esc(z.userId)}">Skasuj fakt</button>
      </div>
      <div class="tresc">\${esc(z.tresc)}</div>
      <div class="czym">profil \${esc(z.userId)} · \${esc(z.dlaczego)}</div>
    </div>\`).join("");
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.fakt) {
    if (!confirm("Usunąć ten fakt z pamięci? Tego nie da się cofnąć.")) return;
    stan("usuwam…");
    await fetch(\`/api/memory/\${encodeURIComponent(t.dataset.profil)}/facts/\${encodeURIComponent(t.dataset.fakt)}\`, { method: "DELETE" });
    // Ten sam przycisk stoi w liście faktów i w wyniku kontroli. Skasowany
    // wpis musi zniknąć z obu, a nie tylko z tej listy, którą i tak wczytujemy
    // na nowo — inaczej znalezisko zostaje i kusi drugim kliknięciem.
    t.closest(".kontrola")?.remove();
    await wczytajProfile();
    return wczytaj();
  }
  if (t.dataset.przenies) {
    // Shodh nie zna zmiany wlasciciela: to zapis pod nowym profilem i usuniecie
    // starego, wiec licznik uzyc i waga faktu przepadaja. Trzeba to powiedziec.
    if (!confirm("Przenieść ten fakt do profilu wspólnego?\\n\\nFakt zacznie liczyć użycia od zera — pamięć nie umie przenieść wpisu, tylko zapisać go na nowo.")) return;
    stan("przenoszę…");
    const r = await fetch(\`/api/pamiec/\${encodeURIComponent(t.dataset.profil)}/fakty/\${encodeURIComponent(t.dataset.przenies)}/przenies\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docelowy: "default" }),
    });
    const o = await r.json();
    if (!r.ok) return stan("Błąd: " + (o.error || r.status));
    await wczytajProfile();
    await wczytaj();
    return stan(o.wynik === "scalony" ? "Profil wspólny już to wiedział — usunięto kopię z tego profilu." : "Przeniesiono do profilu wspólnego.");
  }
  if (t.dataset.odrzuc) {
    stan("usuwam z listy…");
    await fetch("/api/pominiete/" + encodeURIComponent(t.dataset.odrzuc), { method: "DELETE" });
    return wczytaj();
  }
  if (t.dataset.przyjmij) {
    const id = t.dataset.przyjmij;
    const wybor = document.querySelector(\`[data-kat="\${id}"]\`);
    const kategoria = wybor ? wybor.value : undefined;
    if (wybor && !kategoria) return stan("Najpierw wybierz kategorię.");
    stan("przyjmuję…");
    const r = await fetch(\`/api/pominiete/\${encodeURIComponent(id)}/przyjmij\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kategoria }),
    });
    const o = await r.json();
    if (!r.ok) return stan("Błąd: " + (o.error || r.status));
    await wczytaj();
    stan(o.zapisane ? \`Zapisano faktów: \${o.zapisane}.\` : "Ekstrakcja nie znalazła nic wartego zapamiętania.");
  }
});

$("kontrola").addEventListener("click", async () => {
  $("kontrola").disabled = true;
  stan("sprawdzam pamięć z regułami…");
  try {
    const w = await fetch("/api/pamiec/kontrola", { method: "POST" }).then(r => r.json());
    rysujZnaleziska(w);
    stan(w.blad ? "" : \`Sprawdzono \${w.sprawdzono} faktów, znalezisk: \${w.znaleziska.length}.\`);
  } catch (err) {
    stan("Kontrola się nie powiodła: " + err);
  } finally {
    $("kontrola").disabled = false;
  }
});

$("odswiez").addEventListener("click", async () => { await wczytajProfile(); wczytaj(); });
$("profil").addEventListener("change", wczytaj);
wczytajProfile().then(wczytaj);
</script>
</body>
</html>`;
