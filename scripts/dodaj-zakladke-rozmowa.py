#!/usr/bin/env python3
"""Dodaje widok „Rozmowa" do pulpitu „Reguły asystenta" przez WebSocket HA.

Dlaczego przez WS, a nie edycją `/config/.storage/lovelace.*`: HA trzyma
konfigurację pulpitów w pamięci i zapisuje ją z powrotem przy swoich zmianach —
plik podmieniony pod spodem albo nie zadziała do restartu, albo zostanie
nadpisany. `lovelace/config/save` przechodzi tą samą drogą co edycja z UI.

Skrypt jest IDEMPOTENTNY: gdy widok o ścieżce `rozmowa` już jest, podmienia go
zamiast dokładać drugi. Dlatego można go puścić ponownie, gdy `.storage` wróci
z kopii zapasowej albo gdy zakładka zostanie przypadkiem skasowana z UI.

⚠️ Tryb panelu (`panel: true`) jest ustawiany PER WIDOK. Pulpity w tym domu to
pojedyncza ramka `iframe` w trybie panelu — drugiej karty do TAKIEGO widoku
dołożyć się nie da, ale drugi widok obok niego wchodzi bez szkody dla ramki.

Uruchamianie (z katalogu repo, `HA_URL` i `HA_TOKEN` bierze z `.env`):

    set -a && . ./.env && set +a && python3 scripts/dodaj-zakladke-rozmowa.py

Wymaga `websockets` (na `mediaserwer` jest 10.4; `websocket-client` NIE ma).
"""

import asyncio
import json
import os
import sys

import websockets

URL = os.environ["HA_URL"].rstrip("/")
TOKEN = os.environ["HA_TOKEN"]
WS = URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
PULPIT = "reguly-asystenta"
SCIEZKA = "rozmowa"

WIDOK = {
    "title": "Rozmowa",
    "path": SCIEZKA,
    "icon": "mdi:chat-processing-outline",
    "cards": [
        {
            "type": "entities",
            "title": "Rozmowa przez abonament",
            "entities": [
                {
                    "entity": "switch.home_mind_rozmowa_przez_abonament",
                    "name": "Kieruj żarty i pogawędkę na Claude",
                },
                {"entity": "select.home_mind_model_rozmowy", "name": "Model"},
                {"entity": "select.home_mind_wysilek_rozmowy", "name": "Wysiłek"},
            ],
        },
        {
            "type": "markdown",
            "content": (
                "Dotyczy **wyłącznie** żartów, zagadek i pogawędki — polecenia dla domu "
                "zostają na szybkiej ścieżce i te ustawienia ich nie dotykają. "
                "Kierowanie odbywa się co turę, więc nie jest to tryb, z którego trzeba "
                "wychodzić.\n\n"
                "Zmierzone: Sonnet 5 ok. 5,8 s · Opus 5 ok. 6,8 s · Fable 5 ok. 9,9 s · "
                "Haiku 4.5 ok. 10,3 s i słabsza polszczyzna.\n\n"
                "*Wysiłek jest niedostępny przy modelach, które go nie obsługują.*"
            ),
        },
    ],
}


async def main() -> int:
    async with websockets.connect(WS, max_size=8_000_000) as ws:
        await ws.recv()  # auth_required
        await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        odp = json.loads(await ws.recv())
        if odp.get("type") != "auth_ok":
            print(f"BLAD logowania: {odp}", file=sys.stderr)
            return 1

        nr = 0

        async def wolaj(ladunek: dict) -> dict:
            nonlocal nr
            nr += 1
            await ws.send(json.dumps({"id": nr, **ladunek}))
            while True:
                wiadomosc = json.loads(await ws.recv())
                if wiadomosc.get("id") == nr and wiadomosc.get("type") == "result":
                    return wiadomosc

        odp = await wolaj({"type": "lovelace/config", "url_path": PULPIT})
        if not odp.get("success"):
            print(f"BLAD odczytu: {odp.get('error')}", file=sys.stderr)
            return 1

        cfg = odp["result"]
        widoki = cfg.get("views", [])
        print(f"widoki przed: {[w.get('title') for w in widoki]}")

        istniejacy = next(
            (i for i, w in enumerate(widoki) if w.get("path") == SCIEZKA), None
        )
        if istniejacy is None:
            widoki.append(WIDOK)
            print("dodaje nowy widok")
        else:
            widoki[istniejacy] = WIDOK
            print(f"podmieniam istniejacy widok nr {istniejacy}")
        cfg["views"] = widoki

        odp = await wolaj(
            {"type": "lovelace/config/save", "url_path": PULPIT, "config": cfg}
        )
        if not odp.get("success"):
            print(f"BLAD zapisu: {odp.get('error')}", file=sys.stderr)
            return 1

        # Odczyt PO zapisie — zeby nie polegac na tym, ze "success" znaczy zapisane.
        odp = await wolaj({"type": "lovelace/config", "url_path": PULPIT})
        po = [w.get("title") for w in odp["result"].get("views", [])]
        print(f"widoki po:   {po}")
        return 0


sys.exit(asyncio.run(main()))
