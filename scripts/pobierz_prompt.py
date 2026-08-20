#!/usr/bin/env python3
"""Pobiera prompt asystenta z Home Assistanta do pliku w repozytorium.

Odwrotność `set_prompt.py`. Prompt da się edytować w dwóch miejscach — w UI
Home Assistanta (Ustawienia → Urządzenia i usługi → Home Mind → Konfiguruj) i w
pliku `prompt_home_mind.txt`. Bez tego skryptu edycja w UI cicho rozjeżdża
repozytorium z tym, co naprawdę działa, i przy następnym `set_prompt.py`
zmiany z UI zostałyby nadpisane.

    ./pobierz_prompt.py            # pokaż różnicę, nic nie zapisuj
    ./pobierz_prompt.py --zapisz   # nadpisz plik tym, co jest w HA

Czyta bezpośrednio magazyn HA przez SSH, bo opcje wpisu integracji nie są
wystawione w REST API — jedyną drogą przez API jest przejście całego options
flow, które przy okazji re-wysyła konfigurację modelu.
"""

from __future__ import annotations

import argparse
import difflib
import subprocess
import sys
from pathlib import Path

PLIK = Path(__file__).parent / "prompt_home_mind.txt"
HOST = "root@192.168.88.227"
KLUCZ = Path.home() / ".ssh" / "ha_ed25519"

ODCZYT = """python3 -c "
import json
d = json.load(open('/config/.storage/core.config_entries'))
for e in d['data']['entries']:
    if e['domain'] == 'home_mind' and e['title'] == 'Home Mind':
        print(e['options'].get('custom_prompt', ''), end='')
"
"""


def z_ha() -> str:
    wynik = subprocess.run(
        ["ssh", "-i", str(KLUCZ), "-o", "StrictHostKeyChecking=no", HOST, ODCZYT],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if wynik.returncode != 0:
        print(f"Nie mogę odczytać z HA: {wynik.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return wynik.stdout


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zapisz", action="store_true", help="nadpisz plik tym z HA")
    a = ap.parse_args()

    w_ha = z_ha()
    if not w_ha.strip():
        print("Prompt w HA jest pusty — nie nadpisuję.", file=sys.stderr)
        return 1

    w_pliku = PLIK.read_text(encoding="utf-8") if PLIK.exists() else ""

    if w_ha == w_pliku:
        print(f"Zgodne ({len(w_ha)} znaków). Nic do zrobienia.")
        return 0

    roznica = list(
        difflib.unified_diff(
            w_pliku.splitlines(keepends=True),
            w_ha.splitlines(keepends=True),
            fromfile="repozytorium",
            tofile="Home Assistant",
        )
    )
    print(f"Różnica: {len(w_pliku)} znaków w pliku, {len(w_ha)} w HA\n")
    print("".join(roznica[:80]), end="")
    if len(roznica) > 80:
        print(f"… i {len(roznica) - 80} dalszych linii")

    if not a.zapisz:
        print("\nPODGLĄD — nic nie zapisano. Dodaj --zapisz, żeby przyjąć wersję z HA.")
        return 0

    PLIK.write_text(w_ha, encoding="utf-8")
    print(f"\nZapisano {PLIK.name}. Zacommituj zmianę, żeby historia nadążała.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
