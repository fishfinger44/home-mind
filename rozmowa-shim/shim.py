#!/usr/bin/env python3
"""Most między Home Mindem a Claude z abonamentu — ścieżka ROZMOWNA.

Po co osobny proces na hoście, a nie wywołanie z kontenera: poświadczenia
abonamentu (`~/.claude.json`, login OAuth) leżą na hoście i **nie mają czego
szukać w kontenerze**. `home-mind-server` ma `network_mode: host`, więc widzi
127.0.0.1 i nie trzeba mu montować ani binarki `claude`, ani kluczy.

🔑 Ten shim odpowiada WYŁĄCZNIE za rozmowę — żartów, zagadek, gawędzenia,
wiedzy ogólnej. Nie dostaje narzędzi do domu i nie ma ich dostać: komendy
zostają na szybkiej ścieżce (Gemini, 1,2 s), bo tam liczy się czas.

🔬 Zmierzone 14.08.2026 na tej maszynie (Sonnet 5, `--effort low`, rozmowa
z 20 faktami pamięci): **4,48 / 4,64 / 5,22 / 8,17 s**. Dla porównania Haiku 4.5
było WOLNIEJSZE (6,3–13,8 s) i słabsze jakościowo — stąd Sonnet, nie Haiku.
⛔ `--effort` na Haiku 4.5 w ogóle nie istnieje, więc podmiana modelu na Haiku
wymaga usunięcia tej flagi, inaczej wywołanie padnie.

⚠️ Dwie pułapki CLI, obie potwierdzone doświadczalnie:
* `--disallowed-tools` jest **wariadyczne** i połyka pozycyjny prompt
  („Input must be provided…"). Pytanie idzie więc przez **stdin**.
* myślenia NIE wyłączamy. Przy `thinking: disabled` model potrafi wypisać
  wywołanie narzędzia jako zwykły tekst — a tu narzędzi nie ma, więc realne
  ryzyko jest inne: gorsza jakość bez zysku na czasie. `effort: low` daje
  szybkość bez tej ceny.

    python3 shim.py            # 127.0.0.1:8765
"""

import json
import os
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sesje import Pula

# 🔴 KATALOG NEUTRALNY — wykryte doswiadczalnie 14.08.2026.
# `claude -p` dziedziczy katalog roboczy procesu i wciaga z niego kontekst
# projektu: shim odpalony w `~/home-mind/rozmowa-shim` doklejal do KAZDEJ
# domowej pogawedki `~/home-mind/CLAUDE.md` — **25 687 bajtow** dokumentacji
# deweloperskiej. Widac to bylo po odpowiedzi: "w tym, co widzę o twoim
# projekcie home-mind, nie ma sladu po...". Asystent domowy nie ma czego
# szukac w kodzie projektu.
# ⚠️ Katalog MUSI lezec poza drzewem projektu — CLAUDE.md jest szukany takze
# w katalogach nadrzednych, wiec podkatalog `~/home-mind/puste` nic by nie dal.
KATALOG_NEUTRALNY = os.path.join(tempfile.gettempdir(), "rozmowa-neutralny")
os.makedirs(KATALOG_NEUTRALNY, exist_ok=True)

HOST = os.environ.get("ROZMOWA_HOST", "127.0.0.1")
PORT = int(os.environ.get("ROZMOWA_PORT", "8765"))
MODEL = os.environ.get("ROZMOWA_MODEL", "claude-sonnet-5")
EFFORT = os.environ.get("ROZMOWA_EFFORT", "low")

# 🔑 TA LISTA JEST ZRODLEM PRAWDY dla wyboru modelu w Home Assistant.
# HA nie ma jej u siebie — pobiera ja przez `GET /modele`, wiec dopisanie
# modelu tutaj wystarczy, zeby pojawil sie w panelu. Odwrotnie tez: nie da sie
# wybrac z HA modelu, ktorego ten shim nie przyjmie.
#
# `effort` mowi, czy model zna flage `--effort`. ⛔ Haiku 4.5 jej NIE ma
# i wywolanie z nia pada — dlatego to wlasciwosc modelu, a nie osobne
# ustawienie, o ktorego zgodnosc musialby pamietac czlowiek.
MODELE = {
    "claude-sonnet-5": {"nazwa": "Sonnet 5 (domyslny)", "effort": True},
    "claude-opus-5": {"nazwa": "Opus 5", "effort": True},
    "claude-fable-5": {"nazwa": "Fable 5", "effort": True},
    "claude-haiku-4-5-20251001": {"nazwa": "Haiku 4.5 (bez wysilku)", "effort": False},
}
WYSILKI = ["low", "medium", "high"]
# Mierzone 4,5–8,2 s. Limit z zapasem, ale skończony: lepiej oddać sterowanie
# z błędem niż zawiesić asystenta, który mówi do człowieka.
TIMEOUT_S = float(os.environ.get("ROZMOWA_TIMEOUT", "20"))

# Narzędzia Claude Code wyłączone co do jednego. Ten proces ma rozmawiać,
# a nie czytać i pisać po dysku hosta.
WYLACZONE = [
    "Bash", "Read", "Write", "Edit", "Glob", "Grep",
    "WebSearch", "WebFetch", "Task", "TodoWrite", "NotebookEdit",
]

PULA = Pula(KATALOG_NEUTRALNY, WYLACZONE)

PERSONA_DOMYSLNA = (
    "Jesteś domowym asystentem głosowym. Rozmawiasz po polsku, swobodnie i krótko — "
    "odpowiedź ma się nadawać do przeczytania na głos, więc bez list, nagłówków "
    "i znaczników. Nie sterujesz teraz domem i nie masz do tego narzędzi: jeśli "
    "padnie prośba o wykonanie czegoś w domu, powiedz krótko, żeby powtórzyć ją "
    "jako polecenie, i nie udawaj, że coś zrobiłeś."
)


def persona_stala(dane: dict) -> str:
    """Część promptu, która NIE zmienia się z tury na turę.

    🔑 Tylko to trafia do `--system-prompt`, bo prompt systemowy jest przybity
    do procesu przy jego starcie (patrz `sesje.py`). Wszystko zmienne — mówca,
    fakty, historia — jedzie w wiadomości użytkownika. Ta sama decyzja, którą
    podjęliśmy dla cache'u Gemini, tylko z innego powodu.
    """
    return dane.get("persona") or PERSONA_DOMYSLNA


def blok_zmienny(dane: dict, swieza_sesja: bool) -> str:
    """Kontekst tury + samo pytanie, jako jedna wiadomość użytkownika.

    ⚠️ `historia` jedzie WYŁĄCZNIE przy świeżej sesji. Żywy proces pamięta
    poprzednie tury sam, więc dosyłanie naszej kopii dublowałoby rozmowę
    i szybciej pchało ją w stronę awarii „Echo". Przy świeżej sesji (pierwsza
    tura albo proces właśnie wymieniony po `MAX_TUR_SESJI`) historia jest
    natomiast konieczna, żeby wymiana procesu nie ucinała wątku w pół zdania.
    """
    czesci: list[str] = []

    mowca = dane.get("mowca")
    if mowca:
        czesci.append(
            f"## Z kim rozmawiasz:\n{mowca}. Używaj imienia naturalnie, "
            "ale nie w każdym zdaniu."
        )
    else:
        # Ta sama zasada co w `speakerSection` po stronie Home Minda: bez
        # rozpoznanego rozmówcy nie zgadujemy, kto to jest.
        czesci.append(
            "## Z kim rozmawiasz:\nNie wiadomo — to może być urządzenie "
            "współdzielone albo gość. Nie zgaduj, kto to jest, i nie zwracaj "
            "się do nikogo po imieniu."
        )

    fakty = dane.get("fakty") or []
    if fakty:
        czesci.append("## Co pamiętasz:\n" + "\n".join(f"- {f}" for f in fakty))

    historia = dane.get("historia") or []
    if historia and swieza_sesja:
        linie = [
            f"{'Użytkownik' if w.get('role') == 'user' else 'Ty'}: {w.get('content', '')}"
            for w in historia
        ]
        czesci.append("## Wcześniej w tej rozmowie:\n" + "\n".join(linie))

    czesci.append((dane.get("pytanie") or "").strip())
    return "\n\n".join(c for c in czesci if c)


def wybierz_model(dane: dict) -> tuple[str, str, str | None]:
    """Zwraca (model, effort, błąd) dla jednego zapytania.

    🔑 Model przychodzi Z ZADANIEM, a nie ze środowiska, bo wybiera się go
    z HA i ma działać od następnej tury — bez restartu usługi. Wartości
    z `.env` zostają domyślnymi na wypadek, gdy nikt nic nie wybrał.

    ⚠️ Nieznany model ODRZUCAMY zamiast podać dalej. Trafiłby do `argv`
    podprocesu, gdzie `claude` przemieliłby go we własny błąd dopiero po
    chwili — a wtedy przyczyna („literówka w nazwie") jest już nie do
    odczytania z tego, co widzi użytkownik.
    """
    zadany = (dane.get("model") or "").strip()
    if zadany and zadany not in MODELE:
        return MODEL, EFFORT, f"nieznany model: {zadany}"
    model = zadany or MODEL

    # Model spoza listy może przyjść tylko z `.env` (świadoma decyzja kogoś,
    # kto edytował jednostkę systemd) — zakładamy wtedy, że `--effort` zna,
    # czyli zachowujemy się dokładnie jak przed tym wyborem.
    obsluguje_effort = MODELE.get(model, {}).get("effort", True)

    effort = (dane.get("effort") or "").strip() or EFFORT
    if effort and effort not in WYSILKI:
        return model, EFFORT, f"nieznany poziom wysilku: {effort}"
    # ⛔ Nie błąd, tylko ciche zdjęcie flagi: wybór modelu i wybór wysiłku to
    # w panelu dwie osobne gałki, więc kombinacja „Haiku + medium" jest
    # nieunikniona. Odmowa zamieniłaby ją w awarię rozmowy zamiast w brak
    # ustawienia, którego ten model i tak nie ma.
    if not obsluguje_effort:
        effort = ""

    return model, effort, None


def strumien_odpowiedzi(dane: dict):
    """Generator kawałków odpowiedzi. Rzuca `RuntimeError` z powodem błędu.

    Jedno miejsce dla obu końcówek: `/rozmowa` skleja to w JSON (droga odwrotu),
    `/rozmowa/strumien` oddaje kawałek po kawałku.
    """
    if not (dane.get("pytanie") or "").strip():
        raise RuntimeError("puste pytanie")

    model, effort, blad = wybierz_model(dane)
    if blad:
        raise RuntimeError(blad)

    persona = persona_stala(dane)
    # Klucz sesji = rozmowa. Bez niego (np. wywołanie z ręki) każde zapytanie
    # dostaje własny, jednorazowy proces — czyli zachowanie jak przed zmianą.
    klucz = (dane.get("rozmowa_id") or "").strip() or f"bez-id-{time.time()}"

    try:
        sesja, swieza = PULA.sesja(klucz, model, effort, persona)
    except FileNotFoundError as e:
        raise RuntimeError("nie znaleziono polecenia `claude` na hoście") from e

    print(
        f"[rozmowa] model {model}, effort {effort or 'brak'}, "
        f"sesja {'NOWA' if swieza else f'wznowiona (tura {sesja.tury + 1})'}",
        flush=True,
    )

    # Jedna tura naraz na proces: to pojedynczy strumień stdin/stdout i dwa
    # równoległe pytania rozjechałyby się nie do rozplątania.
    with sesja.zamek:
        try:
            oddane = False
            for kawalek in sesja.zapytaj(blok_zmienny(dane, swieza), TIMEOUT_S):
                oddane = True
                yield kawalek
            if not oddane:
                raise RuntimeError("pusta odpowiedź")
        except RuntimeError:
            # Proces w nieznanym stanie — nie zostawiamy go w puli, bo następna
            # tura odziedziczyłaby po nim urwane wyjście.
            PULA.zakoncz(klucz)
            raise


class Uchwyt(BaseHTTPRequestHandler):
    def _odpisz(self, kod: int, tresc: dict) -> None:
        dane = json.dumps(tresc, ensure_ascii=False).encode("utf-8")
        self.send_response(kod)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dane)))
        self.end_headers()
        self.wfile.write(dane)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/zdrowie":
            self._odpisz(200, {
                "stan": "ok", "model": MODEL, "effort": EFFORT,
                "strumien": True, "sesje": PULA.stan(),
            })
        elif self.path == "/modele":
            # Lista do wypelnienia wyboru w HA. Domysly ida razem z nia, zeby
            # panel mogl pokazac, co sie stanie, gdy nikt nic nie wybral.
            self._odpisz(200, {
                "modele": [
                    {"id": mid, "nazwa": opis["nazwa"], "effort": opis["effort"]}
                    for mid, opis in MODELE.items()
                ],
                "wysilki": WYSILKI,
                "domyslny": MODEL,
                "effortDomyslny": EFFORT,
            })
        else:
            self._odpisz(404, {"blad": "nie ma takiej sciezki"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/rozmowa", "/rozmowa/strumien", "/rozmowa/koniec"):
            self._odpisz(404, {"blad": "nie ma takiej sciezki"})
            return
        try:
            dlugosc = int(self.headers.get("Content-Length", "0"))
            dane = json.loads(self.rfile.read(dlugosc) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._odpisz(400, {"blad": f"zle wejscie: {e}"})
            return

        if self.path == "/rozmowa/koniec":
            # Rozmowa się domknęła — proces nie ma po co żyć dalej z jej
            # kontekstem. Bez tego czekalibyśmy na `BEZCZYNNOSC_S`.
            PULA.zakoncz((dane.get("rozmowa_id") or "").strip())
            self._odpisz(200, {"ok": True})
            return

        if self.path == "/rozmowa":
            self._bez_strumienia(dane)
        else:
            self._ze_strumieniem(dane)

    def _bez_strumienia(self, dane: dict) -> None:
        """Droga odwrotu: pełna odpowiedź jednym JSON-em, jak przed zmianą."""
        try:
            odpowiedz = "".join(strumien_odpowiedzi(dane)).strip()
        except RuntimeError as e:
            print(f"[rozmowa] BLAD: {e}", flush=True)
            self._odpisz(502, {"blad": str(e)})
            return
        if not odpowiedz:
            self._odpisz(502, {"blad": "pusta odpowiedź"})
            return
        self._odpisz(200, {"odpowiedz": odpowiedz})

    def _ze_strumieniem(self, dane: dict) -> None:
        """NDJSON: linia na kawałek, `{"koniec": true}` na końcu.

        ⚠️ Nagłówki lecą PRZED pierwszym kawałkiem, więc błąd, który wyjdzie
        w trakcie, nie może już zmienić kodu odpowiedzi — dlatego jedzie jako
        `{"blad": …}` w treści. Wołający musi to sprawdzać; samo HTTP 200 nie
        znaczy tu, że tura się udała.
        """
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def wyslij(obiekt: dict) -> None:
            self.wfile.write((json.dumps(obiekt, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()

        try:
            for kawalek in strumien_odpowiedzi(dane):
                wyslij({"tekst": kawalek})
            wyslij({"koniec": True})
        except RuntimeError as e:
            print(f"[rozmowa] BLAD: {e}", flush=True)
            try:
                wyslij({"blad": str(e)})
            except Exception:  # noqa: BLE001
                pass
        except (BrokenPipeError, ConnectionResetError):
            # Odbiorca się rozłączył (np. HA przerwał turę) — to nie awaria.
            print("[rozmowa] odbiorca rozlaczyl sie w trakcie", flush=True)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        print(f"[rozmowa] {format % args}", file=sys.stderr, flush=True)


def main() -> None:
    serwer = ThreadingHTTPServer((HOST, PORT), Uchwyt)
    print(f"[rozmowa] nasłuchuję na http://{HOST}:{PORT} "
          f"(model {MODEL}, effort {EFFORT or 'brak'}, limit {TIMEOUT_S:.0f} s)", flush=True)
    try:
        serwer.serve_forever()
    except KeyboardInterrupt:
        print("\n[rozmowa] koniec", flush=True)


if __name__ == "__main__":
    main()
