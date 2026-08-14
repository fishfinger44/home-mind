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
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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

PERSONA_DOMYSLNA = (
    "Jesteś domowym asystentem głosowym. Rozmawiasz po polsku, swobodnie i krótko — "
    "odpowiedź ma się nadawać do przeczytania na głos, więc bez list, nagłówków "
    "i znaczników. Nie sterujesz teraz domem i nie masz do tego narzędzi: jeśli "
    "padnie prośba o wykonanie czegoś w domu, powiedz krótko, żeby powtórzyć ją "
    "jako polecenie, i nie udawaj, że coś zrobiłeś."
)


def zbuduj_prompt_systemowy(dane: dict) -> str:
    czesci = [dane.get("persona") or PERSONA_DOMYSLNA]

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
    if historia:
        linie = [
            f"{'Użytkownik' if w.get('role') == 'user' else 'Ty'}: {w.get('content', '')}"
            for w in historia
        ]
        czesci.append("## Wcześniej w tej rozmowie:\n" + "\n".join(linie))

    return "\n\n".join(czesci)


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


def zapytaj_claude(dane: dict) -> tuple[str | None, str | None]:
    """Zwraca (odpowiedź, błąd) — dokładnie jedno z nich jest None."""
    pytanie = (dane.get("pytanie") or "").strip()
    if not pytanie:
        return None, "puste pytanie"

    model, effort, blad = wybierz_model(dane)
    if blad:
        return None, blad
    # Do dziennika, bo inaczej nie da sie odroznic „panel pokazuje Opusa"
    # od „Opus faktycznie odpowiedzial".
    print(f"[rozmowa] model {model}, effort {effort or 'brak'}", flush=True)

    polecenie = ["claude", "-p", "--model", model]
    if effort:
        polecenie += ["--effort", effort]
    polecenie += ["--system-prompt", zbuduj_prompt_systemowy(dane)]
    # ⚠️ `--disallowed-tools` MUSI być ostatnie i rozwinięte na osobne argumenty;
    # pytanie idzie przez stdin, bo inaczej ta flaga je połknie.
    polecenie += ["--disallowed-tools", *WYLACZONE]

    try:
        wynik = subprocess.run(
            polecenie,
            input=pytanie,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            # Patrz KATALOG_NEUTRALNY — bez tego doklejal sie CLAUDE.md projektu.
            cwd=KATALOG_NEUTRALNY,
        )
    except subprocess.TimeoutExpired:
        return None, f"przekroczony limit {TIMEOUT_S:.0f} s"
    except FileNotFoundError:
        return None, "nie znaleziono polecenia `claude` na hoście"

    if wynik.returncode != 0:
        return None, (wynik.stderr or "").strip()[:400] or f"kod wyjścia {wynik.returncode}"

    odpowiedz = (wynik.stdout or "").strip()
    return (odpowiedz, None) if odpowiedz else (None, "pusta odpowiedź")


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
            self._odpisz(200, {"stan": "ok", "model": MODEL, "effort": EFFORT})
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
        if self.path != "/rozmowa":
            self._odpisz(404, {"blad": "nie ma takiej sciezki"})
            return
        try:
            dlugosc = int(self.headers.get("Content-Length", "0"))
            dane = json.loads(self.rfile.read(dlugosc) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._odpisz(400, {"blad": f"zle wejscie: {e}"})
            return

        odpowiedz, blad = zapytaj_claude(dane)
        if blad:
            print(f"[rozmowa] BLAD: {blad}", flush=True)
            self._odpisz(502, {"blad": blad})
        else:
            self._odpisz(200, {"odpowiedz": odpowiedz})

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
