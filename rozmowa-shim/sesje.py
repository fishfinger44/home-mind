"""Pula żywych procesów `claude` — jeden na rozmowę, plus rozgrzany zapas.

PO CO. Każde `claude -p` płaci ~3 s startu obudowy Claude Code, niezależnie od
modelu i długości promptu (zmierzone 14.08: trywialne pytanie 3,0–3,7 s;
`--bare` zdejmuje ~2 s, ale zabija logowanie OAuth, więc jest dla nas zamknięte).
Proces utrzymany przy życiu płaci ten start RAZ: zmierzone 2,76 s → 1,52 s →
1,66 s dla trzech pytań pod rząd.

🔴 CENA, KTÓRĄ TRZEBA OBSŁUŻYĆ: PROCES PAMIĘTA POPRZEDNIE TURY. Sprawdzone
wprost — „zapamiętaj liczbę 7", a potem „jaką liczbę?" → „7". To jest dokładnie
mechanizm awarii „Echo", tylko poza naszą kontrolą, bo historia żyje w procesie,
a nie w prompcie, który budujemy. Stąd dwa bezpieczniki:
  * `MAX_TUR_SESJI` — po tylu turach proces jest ubijany i wstaje czysty;
  * pula jest kluczowana `conversation_id`, więc rozmowy nie mieszają kontekstu,
    a koniec rozmowy = koniec procesu.

🔑 PROMPT SYSTEMOWY JEST USTALANY PRZY STARCIE procesu (flaga CLI), więc do
systemowego trafia tylko część STAŁA (persona). Mówca i fakty — czyli to, co
zmienia się z tury na turę — jadą w wiadomości użytkownika. To ta sama decyzja,
którą podjęliśmy wcześniej dla cache'u Gemini: blok zmienny do tury użytkownika.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

# Ile tur obsłuży jeden proces, zanim zostanie wymieniony na czysty.
# Ta sama wartość co `ROZMOWA_TUR` po stronie serwera i z tego samego powodu:
# historia jest w rozmowie potrzebna, ale to ta sama droga, która zatruła
# asystenta przy awarii „Echo".
MAX_TUR_SESJI = int(os.environ.get("ROZMOWA_TUR_SESJI", "6"))
# Po tylu sekundach bezczynności proces jest ubijany — inaczej rozmowa, która
# się nie „zakończyła", trzymałaby proces i kontekst w nieskończoność.
BEZCZYNNOSC_S = float(os.environ.get("ROZMOWA_BEZCZYNNOSC", "600"))
# Sufit na wypadek, gdyby identyfikatory rozmów sypały się szybciej, niż
# zdążymy je sprzątać.
MAX_SESJI = int(os.environ.get("ROZMOWA_MAX_SESJI", "8"))


def _zbuduj_polecenie(model: str, effort: str, persona: str, wylaczone: list[str]) -> list[str]:
    polecenie = [
        "claude", "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",  # bez tego stream-json na wyjściu jest odrzucane
        "--model", model,
    ]
    if effort:
        polecenie += ["--effort", effort]
    polecenie += ["--system-prompt", persona]
    # ⚠️ `--disallowed-tools` jest wariadyczne — musi być OSTATNIE, inaczej
    # połyka kolejne flagi. (Przy `-p` z pozycyjnym promptem połykało prompt.)
    polecenie += ["--disallowed-tools", *wylaczone]
    return polecenie


class Sesja:
    """Jeden żywy proces `claude` wraz z wątkiem czytającym jego wyjście."""

    def __init__(self, model: str, effort: str, persona: str, wylaczone: list[str], katalog: str):
        self.model = model
        self.effort = effort
        self.persona = persona
        self.tury = 0
        self.uzyta = time.time()
        self.zamek = threading.Lock()
        self.proc = subprocess.Popen(
            _zbuduj_polecenie(model, effort, persona, wylaczone),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=katalog,
        )
        self._linie: queue.Queue[str | None] = queue.Queue()
        # Czytanie w osobnym wątku, bo `readline()` na potoku blokuje bez
        # możliwości ustawienia terminu — a termin jest tu obowiązkowy:
        # po drugiej stronie stoi człowiek, do którego asystent mówi.
        self._czytacz = threading.Thread(target=self._czytaj, daemon=True)
        self._czytacz.start()

    def _czytaj(self) -> None:
        try:
            for linia in self.proc.stdout:  # type: ignore[union-attr]
                self._linie.put(linia)
        except Exception:  # noqa: BLE001
            pass
        finally:
            self._linie.put(None)  # znacznik końca strumienia

    def zywa(self) -> bool:
        return self.proc.poll() is None

    def pasuje(self, model: str, effort: str, persona: str) -> bool:
        """Czy tę sesję można użyć do takiego zapytania.

        Model, wysiłek i persona są przybite do procesu flagami przy starcie,
        więc ich zmiana wymaga nowego procesu. Bez tego przełącznik modelu w HA
        „działałby", a odpowiadałby stary model — czyli cicha nieskuteczność,
        której w tym projekcie unikamy konsekwentnie.
        """
        return (
            self.zywa()
            and self.model == model
            and self.effort == effort
            and self.persona == persona
            and self.tury < MAX_TUR_SESJI
            and (time.time() - self.uzyta) < BEZCZYNNOSC_S
        )

    def zapytaj(self, tekst: str, limit_s: float):
        """Wysyła turę i ODDAJE KAWAŁKI TEKSTU w miarę, jak przychodzą.

        Generator: kolejne fragmenty odpowiedzi, a na końcu `None`. Błąd leci
        jako wyjątek, żeby wołający nie musiał rozróżniać pustej odpowiedzi od
        awarii — to rozróżnienie już raz nas kosztowało (`max_tokens: 8`).
        """
        self.tury += 1
        self.uzyta = time.time()
        wiadomosc = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": tekst}]},
        }
        try:
            self.proc.stdin.write(json.dumps(wiadomosc, ensure_ascii=False) + "\n")  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except (BrokenPipeError, ValueError) as e:
            raise RuntimeError(f"proces rozmowy nie przyjmuje wejscia: {e}") from e

        koniec = time.time() + limit_s
        cokolwiek = False
        while True:
            zostalo = koniec - time.time()
            if zostalo <= 0:
                raise RuntimeError(f"przekroczony limit {limit_s:.0f} s")
            try:
                linia = self._linie.get(timeout=zostalo)
            except queue.Empty:
                raise RuntimeError(f"przekroczony limit {limit_s:.0f} s") from None
            if linia is None:
                raise RuntimeError("proces rozmowy zakonczyl sie w trakcie tury")
            linia = linia.strip()
            if not linia:
                continue
            try:
                obiekt = json.loads(linia)
            except json.JSONDecodeError:
                continue

            typ = obiekt.get("type")
            if typ == "stream_event":
                zdarzenie = obiekt.get("event", {})
                if zdarzenie.get("type") == "content_block_delta":
                    kawalek = (zdarzenie.get("delta") or {}).get("text") or ""
                    if kawalek:
                        cokolwiek = True
                        yield kawalek
            elif typ == "result":
                # Domknięcie tury. Gdy nie poszedł ani jeden fragment, oddajemy
                # całość z pola `result` — inaczej krótka odpowiedź bez zdarzeń
                # cząstkowych zniknęłaby po cichu.
                if not cokolwiek:
                    calosc = (obiekt.get("result") or "").strip()
                    if calosc:
                        yield calosc
                    elif obiekt.get("is_error"):
                        raise RuntimeError(str(obiekt.get("result") or "blad rozmowy")[:300])
                return

    def zamknij(self) -> None:
        try:
            if self.proc.stdin and not self.proc.stdin.closed:
                self.proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                self.proc.kill()
            except Exception:  # noqa: BLE001
                pass


class Pula:
    """Sesje po `conversation_id` + jeden rozgrzany zapas."""

    def __init__(self, katalog: str, wylaczone: list[str]):
        self._katalog = katalog
        self._wylaczone = wylaczone
        self._sesje: dict[str, Sesja] = {}
        self._zapas: Sesja | None = None
        self._zamek = threading.Lock()

    # --- zapas -------------------------------------------------------------
    # Bez niego PIERWSZA tura każdej rozmowy nadal płaciłaby pełne ~2,8 s —
    # a każde wybudzenie satelity to nowy `conversation_id`, więc pierwsza tura
    # jest tu przypadkiem częstym, nie brzegowym.

    def _rozgrzej(self, model: str, effort: str, persona: str) -> None:
        def zrob() -> None:
            try:
                s = Sesja(model, effort, persona, self._wylaczone, self._katalog)
            except Exception as e:  # noqa: BLE001
                print(f"[rozmowa] nie moge rozgrzac zapasu: {e}", file=sys.stderr, flush=True)
                return
            with self._zamek:
                if self._zapas is None:
                    self._zapas = s
                else:
                    s.zamknij()

        threading.Thread(target=zrob, daemon=True).start()

    def _wez_zapas(self, model: str, effort: str, persona: str) -> Sesja | None:
        with self._zamek:
            z = self._zapas
            if z is not None and z.pasuje(model, effort, persona):
                self._zapas = None
                return z
        return None

    # --- sesje -------------------------------------------------------------

    def sesja(self, klucz: str, model: str, effort: str, persona: str) -> tuple[Sesja, bool]:
        """Zwraca (sesja, czy_swiezo_zalozona)."""
        self._posprzataj()
        with self._zamek:
            istniejaca = self._sesje.get(klucz)
            if istniejaca is not None and istniejaca.pasuje(model, effort, persona):
                return istniejaca, False
            if istniejaca is not None:
                istniejaca.zamknij()
                self._sesje.pop(klucz, None)

        nowa = self._wez_zapas(model, effort, persona)
        if nowa is None:
            nowa = Sesja(model, effort, persona, self._wylaczone, self._katalog)
        with self._zamek:
            # Sufit: gdyby identyfikatory sypały się szybciej niż sprzątanie.
            while len(self._sesje) >= MAX_SESJI:
                najstarszy = min(self._sesje, key=lambda k: self._sesje[k].uzyta)
                self._sesje.pop(najstarszy).zamknij()
            self._sesje[klucz] = nowa
        self._rozgrzej(model, effort, persona)
        return nowa, True

    def zakoncz(self, klucz: str) -> None:
        with self._zamek:
            s = self._sesje.pop(klucz, None)
        if s is not None:
            s.zamknij()

    def _posprzataj(self) -> None:
        teraz = time.time()
        with self._zamek:
            martwe = [
                k for k, s in self._sesje.items()
                if not s.zywa() or (teraz - s.uzyta) > BEZCZYNNOSC_S
            ]
            do_ubicia = [self._sesje.pop(k) for k in martwe]
        for s in do_ubicia:
            s.zamknij()

    def stan(self) -> dict:
        with self._zamek:
            return {
                "sesji": len(self._sesje),
                "zapas": self._zapas is not None and self._zapas.zywa(),
                "tury": {k: s.tury for k, s in self._sesje.items()},
            }
