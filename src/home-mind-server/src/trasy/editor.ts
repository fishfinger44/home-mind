/**
 * Panel planowania tras, podany jako jedna samodzielna strona.
 *
 * Wbudowany w zrodlo, a nie wystawiony jako plik statyczny, z tego samego
 * powodu co edytor regul: serwer nie ma sciezki na pliki statyczne, a build
 * emituje wylacznie JavaScript - zabladzony .html nie trafilby do obrazu.
 */

export const PANEL_HTML = String.raw`<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trasy — komunikacja miejska</title>
<style>
  :root {
    --tlo:#f6f7f9; --karta:#fff; --tekst:#16191d; --slaby:#5d646e; --kreska:#e2e5ea;
    --akcent:#0b7285; --ok:#1f7a3d; --alarm:#b42318; --uwaga:#b7791f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --tlo:#14171a; --karta:#1c2024; --tekst:#e8eaed; --slaby:#9aa2ac; --kreska:#2c3238;
            --akcent:#38bec9; --ok:#4ac47a; --alarm:#ff6b5e; --uwaga:#e3b341; }
  }
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--tlo);color:var(--tekst);
       font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .ramka{max-width:820px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px}
  h2{font-size:15px;margin:0 0 10px}
  .podtytul{color:var(--slaby);font-size:13px;margin-bottom:18px}
  .karta{background:var(--karta);border:1px solid var(--kreska);border-radius:12px;
         padding:14px;margin-bottom:12px}
  .info{color:var(--slaby);font-size:13px}
  .rzad{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
  .rosnie{flex:1;min-width:0}
  label{display:block;font-size:13px;color:var(--slaby);margin-bottom:3px}
  input,select{font:inherit;padding:6px 9px;border-radius:8px;border:1px solid var(--kreska);
               background:var(--tlo);color:var(--tekst);min-width:0}
  input[type=number]{width:110px}
  button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--kreska);
         background:var(--karta);color:var(--tekst);cursor:pointer}
  button:hover{border-color:var(--akcent)}
  button.glowny{background:var(--akcent);border-color:var(--akcent);color:#fff}
  button.grozny{color:var(--alarm);border-color:var(--alarm)}
  button.maly{padding:3px 8px;font-size:13px}
  button:disabled{opacity:.4;cursor:not-allowed}
  .znacznik{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--kreska);
            color:var(--slaby);white-space:nowrap}
  .znacznik.ok{color:var(--ok);border-color:var(--ok)}
  .znacznik.zle{color:var(--alarm);border-color:var(--alarm)}
  .znacznik.uwaga{color:var(--uwaga);border-color:var(--uwaga)}
  .komunikat{padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;white-space:pre-wrap}
  .k-ok{background:rgba(31,122,61,.12);border:1px solid var(--ok);color:var(--ok)}
  .k-uwaga{background:rgba(183,121,31,.12);border:1px solid var(--uwaga);color:var(--uwaga)}
  .k-blad{background:rgba(180,35,24,.12);border:1px solid var(--alarm);color:var(--alarm)}
  .schowaj{display:none}
  .miejsce{display:flex;gap:8px;align-items:center;margin-bottom:7px}
  .miejsce input.nazwa{width:150px}
  .miejsce input.adres{flex:1}
  .trasa{border:1px solid var(--kreska);border-radius:10px;padding:10px;margin-top:9px;background:var(--tlo)}
  .trasa .naglowek{font-weight:600;margin-bottom:6px}
  .krok{font-size:13px;padding:3px 0;border-top:1px dashed var(--kreska)}
  .krok:first-child{border-top:0}
  .kierunek{color:var(--akcent);font-weight:600}
  .stat{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--slaby)}
  .stat b{color:var(--tekst);font-weight:600}
</style>
</head>
<body>
<div class="ramka">
  <h1>Trasy — komunikacja miejska</h1>
  <div class="podtytul">
    Narzędzie <code>zaplanuj_trase</code> pyta Google Routes API o dojazd i oddaje asystentowi
    numer linii, <strong>kierunek</strong>, przystanek i godziny. To nie jest tablica odjazdów
    i nie zna opóźnień na żywo — rozkład jest planowy, odświeżany raz na dobę.
  </div>

  <div id="komunikat" class="komunikat schowaj"></div>

  <div class="karta">
    <h2>Stan</h2>
    <div class="stat" id="stan">Wczytuję…</div>
  </div>

  <div class="karta">
    <h2>Klucz do Routes API</h2>
    <div class="info">
      Klucz z Google Maps Platform z włączonym <strong>Routes API</strong> — to inny produkt niż
      darmowy klucz Gemini i wymaga konta rozliczeniowego. Zapisany klucz nigdy nie jest tu
      pokazywany. Puste pole = bez zmian.
      <br>Twardy limit ustaw w konsoli Google (<em>quota cap</em>) — budżet tylko powiadamia po fakcie.
    </div>
    <div class="rzad">
      <input type="password" id="klucz" class="rosnie" placeholder="wklej klucz i zapisz" autocomplete="off">
      <button class="glowny" id="btn-klucz">Zapisz klucz</button>
      <button class="grozny maly" id="btn-klucz-kasuj">Usuń zapisany</button>
    </div>
  </div>

  <div class="karta">
    <h2>Miejsca</h2>
    <div class="info">
      Skróty, których używa się w mowie. Wpis <strong>dom</strong> jest domyślnym początkiem każdej
      trasy — bez niego asystent musi dopytywać, skąd jedziesz. Nazwa spoza tej listy leci do Google
      jako adres, więc nie trzeba tu wpisywać wszystkiego.
    </div>
    <div id="miejsca" style="margin-top:10px"></div>
    <div class="rzad">
      <button id="btn-dodaj-miejsce">Dodaj miejsce</button>
    </div>
  </div>

  <div class="karta">
    <h2>Limity</h2>
    <div class="info">
      Dzienny limit to hamulec po naszej stronie: liczy się <strong>przed</strong> zapytaniem, więc
      zatrzymuje także model, który zapętlił się na samych błędach. 0 wyłącza narzędzie zupełnie.
      Warianty nic nie kosztują — to jedno zapytanie.
    </div>
    <div class="rzad">
      <div>
        <label for="limit">Wywołań na dobę</label>
        <input type="number" id="limit" min="0" step="10">
      </div>
      <div>
        <label for="warianty">Wariantów trasy</label>
        <input type="number" id="warianty" min="1" max="5">
      </div>
    </div>
  </div>

  <div class="karta">
    <h2>Sprawdź trasę</h2>
    <div class="info">
      Zapytanie próbne kosztuje dokładnie tyle samo co pytanie zadane głosem:
      <strong>jedno wywołanie</strong> i jeden punkt dziennego limitu.
    </div>
    <div class="rzad">
      <div class="rosnie">
        <label for="dokad">Dokąd</label>
        <input type="text" id="dokad" class="rosnie" placeholder="centrum" style="width:100%">
      </div>
      <div class="rosnie">
        <label for="skad">Skąd (puste = dom)</label>
        <input type="text" id="skad" class="rosnie" placeholder="dom" style="width:100%">
      </div>
    </div>
    <div class="rzad">
      <div>
        <label for="kiedy">Kiedy (puste = teraz)</label>
        <input type="datetime-local" id="kiedy">
      </div>
      <div>
        <label for="znaczy">To godzina</label>
        <select id="znaczy">
          <option value="wyjazd">wyjazdu</option>
          <option value="przyjazd">przyjazdu na miejsce</option>
        </select>
      </div>
      <button class="glowny" id="btn-sprawdz" style="align-self:flex-end">Sprawdź trasę</button>
    </div>
    <div id="wynik"></div>
  </div>

  <div class="rzad">
    <button class="glowny" id="btn-zapisz">Zapisz ustawienia</button>
    <span class="info rosnie" id="stopka"></span>
  </div>
</div>

<script>
var stan = null;

function $(id){ return document.getElementById(id); }
function esc(t){ var d=document.createElement("div"); d.textContent=(t==null?"":t); return d.innerHTML; }

function pokaz(tekst, rodzaj){
  var k = $("komunikat");
  k.className = "komunikat k-" + (rodzaj || "ok");
  k.textContent = tekst;
  k.classList.remove("schowaj");
}
function schowaj(){ $("komunikat").classList.add("schowaj"); }

function rysujStan(){
  var zn = [];
  if (stan.maKlucz) zn.push('<span class="znacznik ok">klucz: ' + esc(stan.zrodloKlucza) + '</span>');
  else zn.push('<span class="znacznik zle">brak klucza — narzędzie nie zadzwoni</span>');
  if (!stan.maDom) zn.push('<span class="znacznik uwaga">brak wpisu „dom”</span>');
  $("stan").innerHTML =
    zn.join(" ") +
    ' <span>dziś: <b>' + stan.zuzyteDzis + "</b> / " + stan.limitDzienny + " wywołań" +
    " (zostało " + stan.zostaloDzis + ")</span>" +
    ' <span>miejsca z: <b>' + esc(stan.zrodloMiejsc) + "</b></span>";
}

function wierszMiejsca(nazwa, adres){
  var d = document.createElement("div");
  d.className = "miejsce";
  d.innerHTML =
    '<input type="text" class="nazwa" value="' + esc(nazwa) + '" placeholder="nazwa">' +
    '<input type="text" class="adres" value="' + esc(adres) + '" placeholder="adres, który zrozumie Google">' +
    '<button class="grozny maly">Usuń</button>';
  d.querySelector("button").onclick = function(){ d.remove(); };
  return d;
}

function rysujMiejsca(){
  var lista = $("miejsca");
  lista.innerHTML = "";
  var nazwy = Object.keys(stan.miejsca);
  // "dom" na gorze - to jedyny wpis, ktory zmienia zachowanie asystenta.
  nazwy.sort(function(a,b){
    if (a.toLowerCase() === "dom") return -1;
    if (b.toLowerCase() === "dom") return 1;
    return a.localeCompare(b, "pl");
  });
  for (var i = 0; i < nazwy.length; i++) {
    lista.appendChild(wierszMiejsca(nazwy[i], stan.miejsca[nazwy[i]]));
  }
  if (nazwy.length === 0) lista.appendChild(wierszMiejsca("dom", ""));
}

function zebraneMiejsca(){
  var wynik = {};
  var wiersze = $("miejsca").querySelectorAll(".miejsce");
  for (var i = 0; i < wiersze.length; i++) {
    var nazwa = wiersze[i].querySelector(".nazwa").value.trim();
    var adres = wiersze[i].querySelector(".adres").value.trim();
    if (nazwa && adres) wynik[nazwa] = adres;
  }
  return wynik;
}

function przyjmij(nowy){
  stan = nowy;
  rysujStan();
  $("limit").value = stan.limitDzienny;
  $("warianty").value = stan.ileWariantow;
}

function wczytaj(){
  fetch("/api/trasy").then(function(r){ return r.json(); }).then(function(d){
    przyjmij(d);
    rysujMiejsca();
    $("stopka").textContent = "Ustawienia z panelu nadpisują .env i przeżywają restart.";
  }).catch(function(e){ pokaz("Nie mogę wczytać ustawień: " + e.message, "blad"); });
}

function zapisz(zmiany, komunikat){
  return fetch("/api/trasy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(zmiany)
  }).then(function(r){
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(d){
    przyjmij(d);
    pokaz(komunikat, "ok");
  }).catch(function(e){ pokaz("Nie udało się zapisać: " + e.message, "blad"); });
}

$("btn-zapisz").onclick = function(){
  schowaj();
  zapisz({
    miejsca: zebraneMiejsca(),
    limitDzienny: Number($("limit").value),
    ileWariantow: Number($("warianty").value)
  }, "Zapisane.").then(rysujMiejsca);
};

$("btn-klucz").onclick = function(){
  var k = $("klucz").value.trim();
  if (!k) { pokaz("Puste pole — nic nie zmieniam.", "uwaga"); return; }
  schowaj();
  zapisz({ klucz: k }, "Klucz zapisany.").then(function(){ $("klucz").value = ""; });
};

$("btn-klucz-kasuj").onclick = function(){
  if (!confirm("Usunąć klucz zapisany w panelu? Zostanie ten z pliku .env, jeśli tam jest.")) return;
  schowaj();
  zapisz({ klucz: "" }, "Klucz z panelu usunięty.");
};

$("btn-dodaj-miejsce").onclick = function(){
  $("miejsca").appendChild(wierszMiejsca("", ""));
};

function opisKroku(k){
  if (k.pieszo_minut != null) return "🚶 pieszo " + k.pieszo_minut + " min";
  var t = "🚌 <b>" + esc(k.linia) + "</b>";
  if (k.kierunek) t += ' w kierunku <span class="kierunek">' + esc(k.kierunek) + "</span>";
  if (k.wsiadz) t += " — wsiądź: " + esc(k.wsiadz) + (k.o ? " o " + esc(k.o) : "");
  if (k.wysiadz) t += ", wysiądź: " + esc(k.wysiadz) + (k.przyjazd ? " o " + esc(k.przyjazd) : "");
  if (k.przystankow != null) t += " (" + k.przystankow + " przyst.)";
  return t;
}

$("btn-sprawdz").onclick = function(){
  var dokad = $("dokad").value.trim();
  if (!dokad) { pokaz("Podaj, dokąd.", "uwaga"); return; }
  schowaj();
  $("wynik").innerHTML = '<div class="info" style="margin-top:10px">Pytam Google…</div>';
  var kiedy = $("kiedy").value ? new Date($("kiedy").value).toISOString() : undefined;

  fetch("/api/trasy/sprawdz", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dokad: dokad, skad: $("skad").value.trim() || undefined,
                           kiedy: kiedy, kiedy_znaczy: $("znaczy").value })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.stan) przyjmij(d.stan);
    var w = d.wynik || {};
    if (w.error) {
      $("wynik").innerHTML = "";
      pokaz(w.error, "blad");
      return;
    }
    var html = '<div class="info" style="margin-top:10px">' + esc(w.skad) + " → " + esc(w.dokad) +
               "<br>" + esc(w.zrodlo) + "</div>";
    for (var i = 0; i < w.trasy.length; i++) {
      var t = w.trasy[i];
      html += '<div class="trasa"><div class="naglowek">' + t.czas_minut + " min" +
              (t.wyjazd ? " · wyjazd " + esc(t.wyjazd) : "") +
              (t.przyjazd ? " · na miejscu " + esc(t.przyjazd) : "") + "</div>";
      for (var j = 0; j < t.kroki.length; j++) {
        html += '<div class="krok">' + opisKroku(t.kroki[j]) + "</div>";
      }
      html += "</div>";
    }
    if (w.uwaga) html += '<div class="info" style="margin-top:8px">' + esc(w.uwaga) + "</div>";
    $("wynik").innerHTML = html;
  }).catch(function(e){
    $("wynik").innerHTML = "";
    pokaz("Zapytanie nie doszło: " + e.message, "blad");
  });
};

wczytaj();
</script>
</body>
</html>`;
