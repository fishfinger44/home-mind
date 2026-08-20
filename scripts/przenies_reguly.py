#!/usr/bin/env python3
"""Przenosi reguły domowe z `custom_prompt` na listę regul w Home Mindzie.

Po co: `custom_prompt` to jeden blok tekstu. Jedna nieuwazna edycja wycina
regule, o ktorej sie zapomnialo, nie da sie zadnej oznaczyc jako chronionej ani
wylaczyc na probe, a kolejnosc — ktora rozstrzyga sprzecznosci — jest
niewidoczna. Po przeniesieniu w opcjach HA zostaje wylacznie osobowosc, a
reguly zyja jako lista pod `/rules`.

Podzial jest mechaniczny: akapity oddzielone pusta linia. Pierwszy akapit to
osobowosc, kazdy nastepny to jedna regula. Tytul bierze sie z pierwszego slowa
naglowka, wiec nic tu nie jest przepisywane recznie — tresc regul wchodzi do
listy znak w znak taka, jaka dzis dziala.

    ./przenies_reguly.py            # podglad, nic nie zapisuje
    HA_TOKEN=... ./przenies_reguly.py --zapisz

Kolejnosc zapisu ma znaczenie: najpierw lista, potem skrocenie promptu. Gdyby
drugi krok padl, reguly obowiazuja podwojnie (raz z listy, raz z promptu) — to
tylko marnotrawstwo tokenow. Odwrotna kolejnosc zostawialaby dom bez regul.

Tylko biblioteka standardowa — systemowy Python nie ma aiohttp, a instalowanie
czegokolwiek pod jeden skrypt migracyjny jest gorsze niz kilka linii urllib.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

PLIK = Path(__file__).parent / "prompt_home_mind.txt"
KOPIA = Path(__file__).parent / "reguly_domowe.json"
SERWER = os.environ.get("HOME_MIND_URL", "http://192.168.88.228:3100")
HA = os.environ.get("HA_URL", "http://192.168.88.227:8123")
ENTRY_ID = "01KYEXC2NNBXQDH9HEKG4DSCMD"

# Naglowek reguly -> (tytul na liscie, czy chroniona).
#
# Chronione sa te trzy, ktorych utrate widac dopiero po szkodzie: asystent
# meldujacy nieprawde, asystent zgadujacy zamiast pytac i asystent
# uruchamiajacy sprzet z wlasnej inicjatywy. Reszte da sie odkrecic w minute.
TYTULY = {
    "ZASADA": ("Zasada nadrzędna — nie melduj bez wywołania", True),
    "DOPYTUJ": ("Dopytuj, nie zgaduj", True),
    "WARTOŚĆ": ("Wartość, nie stan (rolety, światła)", False),
    "MUZYKA": ("Muzyka — tylko script.zagraj_muzyke", False),
    "ODKURZACZ": ("Odkurzacz — mapa pomieszczeń", False),
    "FILMY": ("Filmy i YouTube", False),
    "INTERNET": ("Internet", False),
    "DOM": ("Dom — lokalizacja", False),
    "PROJEKTOR": ("Projektor", False),
    "KLIMATYZACJA": ("Klimatyzacja", False),
    "DZIAŁANIA": ("Działania fizyczne — tylko na wyraźne polecenie", True),
}

# Odczytane z HA (opcje wpisu) i z serwera (/api/config/llm) przed migracja.
# Formularz opcji zada KAZDEGO pola — pominiete wraca do wartosci domyslnej.
OBECNE_OPCJE = {
    "memory_token_limit": 3500,
    "prefer_local": True,
    "web_search_limit": 2,
    "web_search_mode": "gemini_micro",
    "provider": "gemini",
}
DRUGI_KROK = {"model": "gemini-3.1-flash-lite"}


def zadanie(url: str, dane: dict | None = None, metoda: str = "GET", token: str | None = None) -> dict:
    tresc = json.dumps(dane).encode() if dane is not None else None
    req = urllib.request.Request(url, data=tresc, method=metoda)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as odp:
        return json.loads(odp.read().decode() or "{}")


def podziel(tekst: str) -> tuple[str, list[dict]]:
    akapity = [a.strip() for a in tekst.split("\n\n") if a.strip()]
    if len(akapity) < 2:
        print("Prompt nie ma akapitow do podzialu — przerywam.", file=sys.stderr)
        sys.exit(1)

    osobowosc, *bloki = akapity
    reguly = []
    for i, blok in enumerate(bloki, start=1):
        klucz = blok.split(maxsplit=1)[0].strip(".,:—")
        tytul, chroniona = TYTULY.get(klucz, (klucz.capitalize(), False))
        if klucz not in TYTULY:
            print(f'⚠️  nieznany naglowek "{klucz}" — tytul z pierwszego slowa')
        reguly.append({
            "id": f"r{i:02d}",
            "title": tytul,
            "text": blok,
            "enabled": True,
            "protected": chroniona,
            "suggested": False,
        })
    return osobowosc, reguly


def przytnij_prompt(osobowosc: str, token: str) -> bool:
    """Zostawia w opcjach HA sama osobowosc (dwuetapowy options flow)."""
    start = zadanie(
        f"{HA}/api/config/config_entries/options/flow",
        {"handler": ENTRY_ID},
        "POST",
        token,
    )
    flow_id = start.get("flow_id")
    if not flow_id:
        print(f"Nie udalo sie otworzyc opcji: {start}", file=sys.stderr)
        return False

    dane = dict(OBECNE_OPCJE)
    dane["custom_prompt"] = osobowosc
    wynik = zadanie(
        f"{HA}/api/config/config_entries/options/flow/{flow_id}", dane, "POST", token
    )
    if wynik.get("type") == "form":
        wynik = zadanie(
            f"{HA}/api/config/config_entries/options/flow/{flow_id}", DRUGI_KROK, "POST", token
        )

    if wynik.get("type") == "create_entry":
        print(f"custom_prompt przyciety do {len(osobowosc)} znakow.")
        return True
    print(json.dumps(wynik, ensure_ascii=False)[:500], file=sys.stderr)
    return False


def main(zapisz: bool) -> int:
    tekst = PLIK.read_text(encoding="utf-8")
    osobowosc, reguly = podziel(tekst)

    print(f"Prompt: {len(tekst)} znakow → osobowosc {len(osobowosc)} + {len(reguly)} regul\n")
    for r in reguly:
        znak = "!" if r["protected"] else " "
        print(f" {znak} [{r['id']}] {r['title']}  ({len(r['text'])} zn.)")
    print(f"\nW opcjach HA zostanie:\n  {osobowosc[:120]}…")

    if not zapisz:
        print("\nPODGLĄD — nic nie zapisano. Dodaj --zapisz.")
        return 0

    token = os.environ.get("HA_TOKEN")
    if not token:
        print("Ustaw HA_TOKEN, zeby przyciac prompt w HA.", file=sys.stderr)
        return 1

    zapisane = zadanie(f"{SERWER}/api/rules", {"rules": reguly}, "PUT")["rules"]
    print(f"Lista zapisana: {len(zapisane)} regul.")
    KOPIA.write_text(json.dumps(reguly, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Kopia listy w {KOPIA.name} (rules.json siedzi w wolumenie Dockera).")

    if not przytnij_prompt(osobowosc, token):
        print("Lista zapisana, ale prompt NIE przyciety — reguly obowiazuja podwojnie.",
              file=sys.stderr)
        return 1

    PLIK.write_text(osobowosc + "\n", encoding="utf-8")
    print(f"{PLIK.name} zawiera juz tylko osobowosc — zgodnie z tym, co w HA.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zapisz", action="store_true", help="wykonaj przeniesienie")
    sys.exit(main(ap.parse_args().zapisz))
