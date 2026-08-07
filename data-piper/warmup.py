#!/usr/bin/env python3
"""Rozgrzewka Pipera: wymusza zaladowanie modelu domyslnego glosu.

Piper laduje model dopiero przy pierwszym zapytaniu (~1,8 s) i trzyma go
w pamieci bez limitu czasu. Bez tego pierwsze zdanie asystenta po kazdym
starcie kontenera bylo o ~1,7 s wolniejsze.

Uzywany jako healthcheck, wiec dziala niezaleznie od tego, kto wystartowal
kontener (compose, `docker restart`, restart hosta) i przy okazji utrzymuje
model zaladowany. Zwraca 0 gdy Piper odpowiedzial audio, 1 w kazdym innym
przypadku.
"""
import json
import socket
import sys

HOST, PORT = "127.0.0.1", 10200
TEXT = "Gotowy."  # krotkie zdanie: rozgrzewa model, minimalny koszt CPU


def main() -> int:
    try:
        with socket.create_connection((HOST, PORT), timeout=30) as s:
            f = s.makefile("rwb")
            body = json.dumps({"text": TEXT}).encode()  # bez pola voice = glos domyslny
            f.write((json.dumps({"type": "synthesize", "data_length": len(body)}) + "\n").encode())
            f.write(body)
            f.flush()

            audio_bytes = 0
            while True:
                line = f.readline()
                if not line:
                    break
                head = json.loads(line)
                if head.get("data_length"):
                    f.read(head["data_length"])
                payload = f.read(head["payload_length"]) if head.get("payload_length") else b""
                if head["type"] == "audio-chunk":
                    audio_bytes += len(payload)
                elif head["type"] == "audio-stop":
                    break

        if audio_bytes == 0:
            print("rozgrzewka: brak audio", file=sys.stderr)
            return 1
        print(f"rozgrzewka OK: {audio_bytes} B")
        return 0
    except Exception as err:  # noqa: BLE001 - healthcheck ma tylko zwrocic kod
        print(f"rozgrzewka nieudana: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
