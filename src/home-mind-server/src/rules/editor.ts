/**
 * The rules editor, served as one self-contained page.
 *
 * Embedded in the source rather than shipped as a static file because the
 * server has no static pipeline and the build only emits JavaScript; a stray
 * .html would simply not reach the image.
 */

export const EDYTOR_HTML = String.raw`<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reguły asystenta</title>
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
  .podtytul{color:var(--slaby);font-size:13px;margin-bottom:18px}
  .karta{background:var(--karta);border:1px solid var(--kreska);border-radius:12px;
         padding:14px;margin-bottom:10px}
  .karta.wylaczona{opacity:.55}
  .karta.sugestia{border-left:3px solid var(--uwaga)}
  .karta.chroniona{border-left:3px solid var(--alarm)}
  .gora{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .tytul{font-weight:600;flex:1;min-width:0}
  .znacznik{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--kreska);
            color:var(--slaby);white-space:nowrap}
  .znacznik.s{color:var(--uwaga);border-color:var(--uwaga)}
  .znacznik.c{color:var(--alarm);border-color:var(--alarm)}
  textarea{width:100%;min-height:70px;font:13px/1.5 ui-monospace,monospace;padding:9px;
           border-radius:8px;border:1px solid var(--kreska);background:var(--tlo);
           color:var(--tekst);resize:vertical}
  input[type=text]{font:inherit;padding:6px 9px;border-radius:8px;border:1px solid var(--kreska);
                   background:var(--tlo);color:var(--tekst);flex:1;min-width:0}
  button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--kreska);
         background:var(--karta);color:var(--tekst);cursor:pointer}
  button:hover{border-color:var(--akcent)}
  button.glowny{background:var(--akcent);border-color:var(--akcent);color:#fff}
  button.grozny{color:var(--alarm);border-color:var(--alarm)}
  button.maly{padding:3px 8px;font-size:13px}
  button:disabled{opacity:.4;cursor:not-allowed}
  .rzad{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:8px}
  .rosnie{flex:1}
  .pasek{position:sticky;bottom:0;background:var(--tlo);padding:12px 0;border-top:1px solid var(--kreska);
         display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}
  .info{color:var(--slaby);font-size:13px}
  .komunikat{padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;white-space:pre-wrap}
  .k-ok{background:rgba(31,122,61,.12);border:1px solid var(--ok);color:var(--ok)}
  .k-uwaga{background:rgba(183,121,31,.12);border:1px solid var(--uwaga);color:var(--uwaga)}
  .k-blad{background:rgba(180,35,24,.12);border:1px solid var(--alarm);color:var(--alarm)}
  .schowaj{display:none}
  pre.podglad{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;background:var(--tlo);
              border:1px solid var(--kreska);border-radius:8px;padding:12px;max-height:340px;overflow:auto}
</style>
</head>
<body>
<div class="ramka">
  <h1>Reguły asystenta</h1>
  <div class="podtytul">
    Instrukcje dla tego domu. Trafiają do modelu <strong>po</strong> instrukcjach wbudowanych,
    w kolejności z tej listy. Wyłączone nie idą wcale.
  </div>

  <div id="komunikat" class="komunikat schowaj"></div>
  <div id="lista">Wczytuję…</div>

  <div class="pasek">
    <button class="glowny" id="btn-zapisz">Zapisz</button>
    <button id="btn-dodaj">Dodaj regułę</button>
    <button id="btn-sprawdz">Sprawdź sprzeczności</button>
    <button id="btn-podglad">Podgląd promptu</button>
    <span class="info rosnie" id="stan"></span>
  </div>

  <div id="karta-podgladu" class="karta schowaj">
    <div class="info" id="podglad-info"></div>
    <pre class="podglad" id="podglad"></pre>
  </div>
</div>

<script>
var reguly = [];
var brudne = false;

function $(id){ return document.getElementById(id); }
function esc(t){ var d=document.createElement("div"); d.textContent=t==null?"":t; return d.innerHTML; }

function pokazKomunikat(tekst, rodzaj){
  var k = $("komunikat");
  k.className = "komunikat k-" + (rodzaj || "ok");
  k.textContent = tekst;
  k.classList.remove("schowaj");
}
function schowajKomunikat(){ $("komunikat").classList.add("schowaj"); }

function odswiezStan(){
  var wl = reguly.filter(function(r){ return r.enabled; }).length;
  var znakow = reguly.filter(function(r){ return r.enabled; })
                     .map(function(r){ return r.text.trim(); }).join("\n\n").length;
  $("stan").textContent = reguly.length + " reguł, " + wl + " włączonych, " +
    znakow + " znaków w prompcie" + (brudne ? " — NIEZAPISANE ZMIANY" : "");
  $("btn-zapisz").disabled = !brudne;
}

function rysuj(){
  $("lista").innerHTML = reguly.map(function(r, i){
    var klasy = "karta" + (r.enabled ? "" : " wylaczona") +
                (r.suggested ? " sugestia" : "") + (r.protected ? " chroniona" : "");
    return '<div class="' + klasy + '">' +
      '<div class="gora">' +
        '<input type="checkbox" data-wl="' + i + '"' + (r.enabled ? " checked" : "") +
          ' title="Włącz lub wyłącz tę regułę">' +
        '<input type="text" data-tyt="' + i + '" value="' + esc(r.title) + '" placeholder="Tytuł">' +
        (r.protected ? '<span class="znacznik c">! chroniona</span>' : "") +
        (r.suggested ? '<span class="znacznik s">sugestia asystenta</span>' : "") +
      "</div>" +
      '<textarea data-txt="' + i + '" placeholder="Treść reguły — dokładnie tak trafi do modelu">' +
        esc(r.text) + "</textarea>" +
      '<div class="rzad">' +
        '<button class="maly" data-gora="' + i + '"' + (i === 0 ? " disabled" : "") + '>↑</button>' +
        '<button class="maly" data-dol="' + i + '"' + (i === reguly.length-1 ? " disabled" : "") + '>↓</button>' +
        '<span class="rosnie"></span>' +
        (r.suggested ? '<button class="maly" data-przyjmij="' + i + '">Przyjmij jako własną</button>' : "") +
        '<button class="maly" data-chron="' + i + '">' +
          (r.protected ? "Zdejmij ochronę" : "Oznacz jako chronioną") + "</button>" +
        '<button class="maly grozny" data-usun="' + i + '">Usuń</button>' +
      "</div></div>";
  }).join("") || '<div class="karta info">Brak reguł. Dodaj pierwszą albo poczekaj na sugestię asystenta.</div>';

  $("lista").querySelectorAll("[data-wl]").forEach(function(el){
    el.onchange = function(){ reguly[+el.dataset.wl].enabled = el.checked; brudne = true; rysuj(); };
  });
  $("lista").querySelectorAll("[data-tyt]").forEach(function(el){
    el.oninput = function(){ reguly[+el.dataset.tyt].title = el.value; brudne = true; odswiezStan(); };
  });
  $("lista").querySelectorAll("[data-txt]").forEach(function(el){
    el.oninput = function(){ reguly[+el.dataset.txt].text = el.value; brudne = true; odswiezStan(); };
  });
  $("lista").querySelectorAll("[data-gora]").forEach(function(el){
    el.onclick = function(){ var i = +el.dataset.gora; przenies(i, i-1); };
  });
  $("lista").querySelectorAll("[data-dol]").forEach(function(el){
    el.onclick = function(){ var i = +el.dataset.dol; przenies(i, i+1); };
  });
  $("lista").querySelectorAll("[data-chron]").forEach(function(el){
    el.onclick = function(){ var r = reguly[+el.dataset.chron]; r.protected = !r.protected; brudne = true; rysuj(); };
  });
  $("lista").querySelectorAll("[data-przyjmij]").forEach(function(el){
    el.onclick = function(){ reguly[+el.dataset.przyjmij].suggested = false; brudne = true; rysuj(); };
  });
  $("lista").querySelectorAll("[data-usun]").forEach(function(el){
    el.onclick = function(){
      var i = +el.dataset.usun, r = reguly[i];
      var pytanie = 'Usunąć regułę "' + (r.title || "bez tytułu") + '"?';
      if (r.protected) {
        pytanie = 'UWAGA: ta reguła jest oznaczona jako chroniona.\n\n"' +
          (r.title || "bez tytułu") + '"\n\nUsunięcia nie da się cofnąć. Na pewno?';
      }
      if (!confirm(pytanie)) return;
      if (r.protected && !confirm("Potwierdź jeszcze raz — reguła chroniona.")) return;
      reguly.splice(i, 1); brudne = true; rysuj();
    };
  });
  odswiezStan();
}

function przenies(z, doGdzie){
  if (doGdzie < 0 || doGdzie >= reguly.length) return;
  var t = reguly[z]; reguly[z] = reguly[doGdzie]; reguly[doGdzie] = t;
  brudne = true; rysuj();
}

$("btn-dodaj").onclick = function(){
  reguly.push({ id: "r" + Date.now().toString(36), title: "", text: "",
                enabled: false, protected: false, suggested: false });
  brudne = true; rysuj();
  window.scrollTo(0, document.body.scrollHeight);
};

$("btn-zapisz").onclick = function(){
  schowajKomunikat();
  fetch("/api/rules", {
    method: "PUT", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ rules: reguly })
  }).then(function(o){ return o.json(); }).then(function(d){
    if (d.error) { pokazKomunikat("Nie zapisano: " + d.error, "blad"); return; }
    reguly = d.rules; brudne = false; rysuj();
    pokazKomunikat("Zapisane. Działa od następnego pytania — bez restartu.", "ok");
    sprawdzPamiec();
  }).catch(function(e){ pokazKomunikat("Nie zapisano: " + e, "blad"); });
};

/**
 * Po zapisie skonfrontuj reguły z pamięcią.
 *
 * To jest moment, w którym rozjazd POWSTAJE: zmieniasz mapę odkurzacza w
 * regule, a fakt ze starą mapą zostaje w pamięci i trafia do promptu jeszcze
 * niżej, czyli z przewagą pozycji. Sprawdzacz sprzeczności obok tego nie widzi
 * — porównuje reguły z regułami.
 *
 * Uruchamiane PO zapisie i osobno, żeby wolne wywołanie modelu nie opóźniało
 * samego zapisu ani nie mogło go wywrócić. Kasowanie faktów zostaje w pulpicie
 * Pamięć — tu jest tylko wiadomość, że jest co sprzątać.
 */
function sprawdzPamiec(){
  fetch("/api/pamiec/kontrola", { method: "POST" })
    .then(function(o){ return o.json(); }).then(function(d){
      if (d.error || d.blad || !d.znaleziska || !d.znaleziska.length) return;
      var opis = d.znaleziska.slice(0, 5).map(function(z){
        return "• " + (z.rodzaj === "sprzeczny" ? "SPRZECZNY" : "powtarza") +
               " [" + z.regula + "] — " + z.tresc;
      }).join("\n");
      var reszta = d.znaleziska.length > 5 ? "\n…i jeszcze " + (d.znaleziska.length - 5) : "";
      pokazKomunikat("Pamięć kłóci się z regułami (" + d.znaleziska.length + "):\n" +
        opis + reszta + "\nSkasujesz je w pulpicie „Pamięć asystenta”.", "uwaga");
    }).catch(function(){ /* Kontrola jest dodatkiem — jej awaria nie dotyczy zapisu. */ });
}

$("btn-sprawdz").onclick = function(){
  var b = $("btn-sprawdz");
  b.disabled = true; b.textContent = "Sprawdzam…";
  schowajKomunikat();
  fetch("/api/rules/sprawdz", {
    method: "POST", headers: {"Content-Type":"application/json"}, body: "{}"
  }).then(function(o){ return o.json(); }).then(function(d){
    var w = (d.wynik || "").trim();
    if (w === "BRAK") pokazKomunikat("Nie znalazłem sprzeczności między włączonymi regułami.", "ok");
    else if (w === "NIEZNANE") pokazKomunikat("Nie udało się sprawdzić: " + (d.blad || "") +
      "\nTo nie znaczy, że sprzeczności nie ma — sprawdź ponownie później.", "blad");
    else pokazKomunikat(w + (d.uwaga ? "\n" + d.uwaga : ""), "uwaga");
  }).catch(function(e){ pokazKomunikat("Nie udało się sprawdzić: " + e, "blad"); })
    .finally(function(){ b.disabled = false; b.textContent = "Sprawdź sprzeczności"; });
};

$("btn-podglad").onclick = function(){
  var k = $("karta-podgladu");
  if (!k.classList.contains("schowaj")) { k.classList.add("schowaj"); return; }
  var wl = reguly.filter(function(r){ return r.enabled && r.text.trim(); });
  var tekst = wl.map(function(r){ return r.text.trim(); }).join("\n\n");
  $("podglad").textContent = tekst || "(nic — żadna reguła nie jest włączona)";
  $("podglad-info").textContent = "Dokładnie to trafia do modelu, w tej kolejności — " +
    tekst.length + " znaków, około " + Math.round(tekst.length / 4) + " tokenów przy każdym pytaniu.";
  k.classList.remove("schowaj");
};

window.addEventListener("beforeunload", function(e){
  if (brudne) { e.preventDefault(); e.returnValue = ""; }
});

fetch("/api/rules").then(function(o){ return o.json(); }).then(function(d){
  reguly = d.rules || []; rysuj();
}).catch(function(e){ $("lista").innerHTML = '<div class="karta k-blad">Nie wczytano: ' + esc(String(e)) + "</div>"; });
</script>
</body>
</html>`;
