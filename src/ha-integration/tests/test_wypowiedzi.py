#!/usr/bin/env python3
"""Rozbiór tury na wypowiedzi mówców — parser i tekst, który widzi model.

Samodzielny: nie buduje agenta i nie zaślepia Home Assistanta, więc nie dzieli
losu `test_sesja_rozmowy.py`, który przewraca się na brakujących polach obiektu.
Testowane funkcje są statyczne i czyste, więc wyjmujemy je ze źródła i wołamy
wprost — a `SPEAKER_TAG_PATTERN` czytamy z PRAWDZIWEGO `const.py`, żeby wzorzec
i parser nie mogły się rozjechać.

Uruchamianie: python3 src/ha-integration/tests/test_wypowiedzi.py
"""
import re
import sys
from pathlib import Path

SKLADNIK = Path(__file__).resolve().parents[1] / "custom_components" / "home_mind"

tresc_const = (SKLADNIK / "const.py").read_text(encoding="utf-8")
SPEAKER_TAG_PATTERN = eval(  # noqa: S307 — własny plik repo
    re.search(r"^SPEAKER_TAG_PATTERN\s*=\s*(.+)$", tresc_const, re.M).group(1)
)
ZNACZNIK_NIEROZPOZNANY = eval(  # noqa: S307
    re.search(r"^ZNACZNIK_NIEROZPOZNANY\s*=\s*(.+)$", tresc_const, re.M).group(1)
)


def wyjmij(nazwa: str):
    """Wytnij statyczną metodę z conversation.py i zwróć ją jako funkcję."""
    zrodlo = (SKLADNIK / "conversation.py").read_text(encoding="utf-8")
    poczatek = zrodlo.index(f"    def {nazwa}(")
    reszta = zrodlo[poczatek + 1 :]
    kolejna = re.search(r"\n    (?:@staticmethod|def |async def )", reszta)
    blok = zrodlo[poczatek : poczatek + 1 + (kolejna.start() if kolejna else len(reszta))]
    kod = "\n".join(l[4:] if l.startswith("    ") else l for l in blok.split("\n"))
    przestrzen = {
        "re": re,
        "SPEAKER_TAG_PATTERN": SPEAKER_TAG_PATTERN,
        "ZNACZNIK_NIEROZPOZNANY": ZNACZNIK_NIEROZPOZNANY,
    }
    exec(compile(kod, "conversation.py", "exec"), przestrzen)  # noqa: S102
    return przestrzen[nazwa]


rozbierz = wyjmij("_rozbierz_wypowiedzi")
tekst_dla_modelu = wyjmij("_tekst_dla_modelu")

bledy: list[str] = []


def sprawdz(opis: str, warunek: bool) -> None:
    print(f"  {'✓' if warunek else '✗'} {opis}")
    if not warunek:
        bledy.append(opis)


print("\n— parser wypowiedzi —")

w = rozbierz("[lech:0.824] wyłącz projektor\n[wladek:0.51] zapal światło\n[?] jakiś urywek")
sprawdz("trzy wypowiedzi", len(w) == 3)
sprawdz("pierwsza należy do Lecha", w[0]["mowca"] == "lech" and w[0]["podobienstwo"] == 0.824)
sprawdz("druga do Władka", w[1]["mowca"] == "wladek")
sprawdz("nierozpoznany NIE dostaje nazwy mówcy", w[2]["mowca"] is None)
sprawdz("znacznik zdjęty z treści", w[0]["tekst"] == "wyłącz projektor")

w = rozbierz("[lech:0.87] zapal światło")
sprawdz("jeden mówca — jedna wypowiedź", len(w) == 1 and w[0]["mowca"] == "lech")

w = rozbierz("zwykły tekst pisany")
sprawdz("rozmowa pisana: bez mówcy, treść nietknięta",
        len(w) == 1 and w[0]["mowca"] is None and w[0]["tekst"] == "zwykły tekst pisany")

w = rozbierz("[lech] stary format bez podobieństwa")
sprawdz("starszy mostek (sam `[lech]`) nadal działa",
        len(w) == 1 and w[0]["mowca"] == "lech" and w[0]["podobienstwo"] is None)

w = rozbierz("[lech:0.8] pierwsza linia\ndalszy ciąg tej samej")
sprawdz("linia bez znacznika dokleja się, a nie udaje nowego mówcy",
        len(w) == 1 and w[0]["tekst"] == "pierwsza linia dalszy ciąg tej samej")

sprawdz("pusty tekst daje pustą listę", rozbierz("") == [])
sprawdz("same puste linie znikają", rozbierz("[lech:0.8] \n\n") == [])

# Uszkodzony znacznik nie pasuje do wzorca, więc linia zostaje ZWYKŁYM tekstem.
# To jest bezpieczna strona pomyłki: polecenie nie ginie, ale nikt nie dostaje
# tożsamości — a więc i uprawnień — na podstawie znacznika, którego nie da się
# odczytać.
w = rozbierz("[lech:zepsute] zapal światło")
sprawdz("uszkodzony znacznik nie gubi polecenia",
        len(w) == 1 and "zapal światło" in w[0]["tekst"])
sprawdz("🔴 uszkodzony znacznik NIE przyznaje tożsamości", w[0]["mowca"] is None)

print("\n— tekst, który widzi model —")

sprawdz("jeden mówca: czysta treść, bez podpisu",
        tekst_dla_modelu([{"mowca": "lech", "podobienstwo": 0.8, "tekst": "zapal światło",
                           "userName": "Lech"}]) == "zapal światło")

wynik = tekst_dla_modelu([
    {"mowca": "lech", "tekst": "wyłącz projektor", "userName": "Lech"},
    {"mowca": "wladek", "tekst": "zapal światło", "userName": "Władek"},
    {"mowca": None, "tekst": "jakiś urywek", "userName": None},
])
sprawdz("kilku mówców: wypowiedzi podpisane imionami",
        wynik == "Lech: wyłącz projektor\nWładek: zapal światło\nktoś nierozpoznany: jakiś urywek")
sprawdz("znacznik `[?]` NIE trafia do modelu", "[?]" not in wynik)

sprawdz("brak imienia wyświetlanego — zostaje nazwa odcisku",
        tekst_dla_modelu([{"mowca": "lech", "tekst": "a", "userName": None},
                          {"mowca": "wladek", "tekst": "b", "userName": None}])
        == "lech: a\nwladek: b")

sprawdz("pusta lista daje pusty tekst", tekst_dla_modelu([]) == "")

print()
if bledy:
    print(f"PADŁO {len(bledy)}:")
    for b in bledy:
        print(f"  - {b}")
    sys.exit(1)
print("wszystko zielone")
