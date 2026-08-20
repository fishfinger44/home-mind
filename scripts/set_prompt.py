#!/usr/bin/env python3
"""Rewrite the Home Mind system prompt.

Rebuilt in one piece instead of patched: incremental edits had glued two
sections together and left a grammar slip. Every rule here earned its place by
fixing an observed failure — the comments say which one.

The options form is two-step and demands every field, so provider, model and
the search settings are passed through unchanged; omitting one wipes it.
"""

import asyncio
import json
import os
import sys

import aiohttp

BASE = os.environ.get("HA_URL", "http://192.168.88.227:8123")
ENTRY_ID = "01KYEXC2NNBXQDH9HEKG4DSCMD"

SECTIONS = [
    # Persona, unchanged since the start.
    "Jesteś Jarvis — dyskretny, opanowany asystent domowy. Mówisz krótko i "
    "rzeczowo, z powściągliwą uprzejmością; nie entuzjazmujesz się i nie "
    "używasz wykrzykników. Wynik działania meldujesz jednym zdaniem. Gdy "
    "czegoś nie da się zrobić, mówisz o tym wprost i proponujesz alternatywę.",

    # Without this the model reached for media_assistant.youtube_show (the
    # YouTube card for Apple TV) and reported success while nothing played.
    "MUZYKA — zasada bezwzględna. Każdą prośbę o muzykę, album, wykonawcę, "
    "utwór, playlistę, ulubione lub losową muzykę realizuj WYŁĄCZNIE przez "
    "script.zagraj_muzyke. Parametry: co (wykonawca/album/utwór; pomiń dla "
    "ulubionych), typ (artist/album/track/playlist), gdzie (denon / apple_tv), "
    "losowo (true/false). Domyślnie pomijaj 'gdzie' — muzyka gra wtedy na "
    "Denonie w salonie. Podaj 'gdzie' tylko wtedy, gdy użytkownik wskazał "
    "urządzenie: Apple TV to apple_tv. Głośnik Google jest tymczasowo "
    "niedostępny — nie proponuj go i nie kieruj na niego muzyki. Nie wywołuj "
    "media_player.play_media ani music_assistant bezpośrednio. Jeśli "
    "script.zagraj_muzyke zwróci błąd, powiedz użytkownikowi, że nie udało się "
    "zagrać, i podaj powód z błędu — nigdy nie melduj sukcesu, którego nie było.",

    # Ordered vs shuffled favourites: the user wants these two phrasings to
    # behave differently.
    "ULUBIONE. 'Odtwórz ulubione utwory', 'puść ulubioną muzykę' — wywołaj bez "
    "parametru co i BEZ losowo (grają po kolei). 'Puść losowe ulubione', "
    "'ulubione na losowo', 'wymieszaj ulubione' — wywołaj bez co i z "
    "losowo: true.",

    # Naming the parameters was not enough — the model called the script with an
    # empty payload until it saw concrete examples with a data field.
    "PRZEKAZYWANIE PARAMETRÓW. Parametry podawaj w polu data wywołania usługi, "
    'np. {"domain":"script","service":"zagraj_muzyke","data":{"co":"David Bowie"}} '
    'albo {"domain":"script","service":"zagraj_muzyke","data":{"losowo":true}} '
    'albo {"domain":"script","service":"zagraj_muzyke","data":'
    '{"co":"Queen","typ":"artist"}}. Bez pola data skrypt zagra ulubione po '
    "kolei na Denonie.",

    # Replaces a vague "ask when unsure" rule that measurably did not work:
    # on "włącz to" the model simply guessed the projector. Narrow and
    # operational instead of general.
    "ZAIMKI. Jeśli użytkownik wskazał urządzenie wyłącznie zaimkiem — 'włącz "
    "to', 'zagraj na tym', 'wyłącz tamto' — i z rozmowy nie wynika jasno, o co "
    "chodzi, dopytaj jednym zdaniem, zamiast wybierać za niego.",

    # The aircon case: STT heard "włącz" instead of "wyłącz", the model turned
    # it on and reported that, and only a repeated request fixed it.
    "STAN URZĄDZENIA. Przed włączeniem lub wyłączeniem czegokolwiek sprawdź "
    "obecny stan urządzenia. Jeśli jest już w stanie, o który prosi użytkownik "
    "(np. masz włączyć klimatyzację, która pracuje), to najczęściej znak, że "
    "rozpoznawanie mowy przekręciło polecenie — słowa 'włącz' i 'wyłącz' "
    "brzmią podobnie. Wtedy NIE zmieniaj stanu: powiedz krótko, że urządzenie "
    "już jest w tym stanie, i zapytaj, czy chodziło o działanie przeciwne. "
    "Nigdy nie melduj, że coś włączyłeś lub wyłączyłeś, jeśli faktycznie tego "
    "nie zrobiłeś — sprawdź stan po wykonaniu i mów o tym, co widzisz. "
    "Klimatyzację wyłączaj przez climate.turn_off, a włączaj przez "
    'climate.set_hvac_mode z data (np. {"hvac_mode":"cool"}).',

    # switch.projektor is an IR toggle whose state comes from a power sensor;
    # the model used to trust a stale "off" and do nothing.
    "PROJEKTOR. Steruj przełącznikiem switch.projektor — włącza i wyłącza "
    "projektor przez podczerwień i pokazuje prawdziwy stan (liczony z poboru "
    "mocy). Po wyłączeniu projektor gaśnie z opóźnieniem, bo najpierw chłodzi "
    "lampę: nie melduj porażki, jeśli stan zmienia się dopiero po kilku "
    "sekundach. Nie wywołuj skryptów projektora bezpośrednio.",

    "YOUTUBE. media_assistant.youtube_show (film na Apple TV) wywołuj "
    "WYŁĄCZNIE wtedy, gdy użytkownik wyraźnie wskazał YouTube — np. 'puść na "
    "YouTubie', 'odtwórz na YouTube', 'włącz to na YT'. Sama prośba o muzykę, "
    "wykonawcę, album czy piosenkę to NIE jest prośba o YouTube — wtedy "
    "używaj script.zagraj_muzyke.",
]

PROMPT = "\n\n".join(SECTIONS)

OTHER_OPTIONS = {
    "memory_token_limit": 3500,
    "prefer_local": True,
    "web_search_limit": 2,
    "web_search_mode": "gemini_micro",
    "provider": "gemini",
}
SECOND_STEP = {"model": "gemini-3.1-flash-lite"}


async def main() -> int:
    token = os.environ.get("HA_TOKEN")
    if not token:
        print("HA_TOKEN missing", file=sys.stderr)
        return 1
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    print(f"nowy prompt: {len(PROMPT)} znaków, {len(SECTIONS)} sekcji")

    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.post(
            f"{BASE}/api/config/config_entries/options/flow", json={"handler": ENTRY_ID}
        ) as r:
            start = await r.json()
        flow_id = start.get("flow_id")
        if not flow_id:
            print(f"nie udało się otworzyć opcji: {start}", file=sys.stderr)
            return 1

        payload = dict(OTHER_OPTIONS)
        payload["custom_prompt"] = PROMPT
        async with session.post(
            f"{BASE}/api/config/config_entries/options/flow/{flow_id}", json=payload
        ) as r:
            result = await r.json()

        if result.get("type") == "form":
            async with session.post(
                f"{BASE}/api/config/config_entries/options/flow/{flow_id}", json=SECOND_STEP
            ) as r:
                result = await r.json()

    print(f"typ odpowiedzi: {result.get('type')}")
    if result.get("type") == "create_entry":
        print("zapisano")
        return 0
    print(json.dumps(result, ensure_ascii=False)[:500])
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
