"""Sesja rozmowy należy do jednej osoby — test maszyny stanów.

Uruchamianie: `python3 src/ha-integration/tests/test_sesja_rozmowy.py`

Bez pytest i bez Home Assistanta. Integracja żyje w HAOS-ie na osobnej maszynie,
a na hoście nie ma z czego zbudować `homeassistant` — więc zamiast udawać, że da
się ją zaimportować, podstawiamy zaślepki pod te nieliczne rzeczy, których
`conversation.py` naprawdę używa, i wykonujemy PRAWDZIWY plik. Wzorzec znacznika
mówcy czytamy z prawdziwego `const.py`, żeby test nie mógł się z nim rozjechać.
"""

from __future__ import annotations

import asyncio
import importlib.util
import itertools
import re
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

SKLADNIK = Path(__file__).resolve().parents[1] / "custom_components" / "home_mind"


def modul(nazwa: str, **atrybuty) -> types.ModuleType:
    m = types.ModuleType(nazwa)
    for k, v in atrybuty.items():
        setattr(m, k, v)
    sys.modules[nazwa] = m
    return m


# --- Zaślepki Home Assistanta -------------------------------------------------


class ConversationEntity:
    def __init__(self, *a, **k):
        pass


class ConversationEntityFeature:
    CONTROL = 1


class ChatLog:
    """Dziennik rozmowy — u nas tylko po to, zeby zebrac delty.

    Prawdziwy `ChatLog` wola `delta_listener`, na ktorym potok Assist opiera
    strumieniowanie do TTS. Tutaj wystarczy, ze zbierze kawalki: sprawdzamy
    zachowanie tury, nie samo HA.
    """

    def __init__(self):
        self.delty = []

    async def async_add_delta_content_stream(self, agent_id, stream):
        async for kawalek in stream:
            self.delty.append(kawalek)
            yield kawalek


class ConversationResult:
    def __init__(self, response=None, conversation_id=None, continue_conversation=False):
        self.response = response
        self.conversation_id = conversation_id
        self.continue_conversation = continue_conversation


class ConversationInput:
    pass


class IntentResponse:
    def __init__(self, language=None):
        self.speech = None

    def async_set_speech(self, tekst):
        self.speech = tekst

    def async_set_error(self, *a, **k):
        pass


class IntentResponseType:
    ACTION_DONE = "action_done"
    QUERY_ANSWER = "query_answer"


class IntentResponseErrorCode:
    UNKNOWN = "unknown"


def zbuduj_zaslepki() -> None:
    intent_stub = modul(
        "homeassistant.helpers.intent",
        IntentResponse=IntentResponse,
        IntentResponseType=IntentResponseType,
        IntentResponseErrorCode=IntentResponseErrorCode,
    )
    modul("aiohttp", ClientTimeout=MagicMock(), ClientError=Exception)
    modul("homeassistant")
    modul("homeassistant.components")
    modul(
        "homeassistant.components.conversation",
        ChatLog=ChatLog,
        ConversationEntity=ConversationEntity,
        ConversationEntityFeature=ConversationEntityFeature,
        ConversationInput=ConversationInput,
        ConversationResult=ConversationResult,
        async_converse=MagicMock(),
    )
    modul("homeassistant.config_entries", ConfigEntry=object)
    modul("homeassistant.const", MATCH_ALL="*")
    modul("homeassistant.core", HomeAssistant=object)
    modul("homeassistant.helpers", device_registry=MagicMock(), intent=intent_stub)
    modul(
        "homeassistant.helpers.device_registry",
        DeviceInfo=MagicMock(),
        DeviceEntryType=MagicMock(),
    )
    modul("homeassistant.components.homeassistant")
    modul(
        "homeassistant.components.homeassistant.exposed_entities",
        async_should_expose=lambda *a, **k: True,
    )
    modul("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda h: MagicMock())
    modul("homeassistant.helpers.entity_platform", AddEntitiesCallback=object)
    # `ulid_now` musi dawać ZA KAŻDYM RAZEM inną wartość: to ona odróżnia nowe
    # wybudzenie od kolejnej tury tej samej rozmowy, czyli dokładnie to, co
    # sprawdza przypadek 10.
    licznik = itertools.count(1)
    ulid = modul("homeassistant.util.ulid", ulid_now=lambda: f"ID{next(licznik)}")
    modul("homeassistant.util", ulid=ulid)


def zbuduj_const() -> None:
    """Prawdziwy wzorzec znacznika z const.py, reszta byle jaka."""
    tresc = (SKLADNIK / "const.py").read_text(encoding="utf-8")
    wzorzec = re.search(r"^SPEAKER_TAG_PATTERN\s*=\s*(.+)$", tresc, re.M)
    assert wzorzec, "SPEAKER_TAG_PATTERN zniknął z const.py"
    # Tak samo jak wzorzec: czytane z PRAWDZIWEGO pliku, bo znacznik
    # nierozpoznanego i wzorzec muszą do siebie pasować — gdyby test miał tu
    # własną kopię, rozjazd przeszedłby na zielono.
    znacznik = re.search(r"^ZNACZNIK_NIEROZPOZNANY\s*=\s*(.+)$", tresc, re.M)
    assert znacznik, "ZNACZNIK_NIEROZPOZNANY zniknął z const.py"
    modul(
        "const",
        SPEAKER_TAG_PATTERN=eval(wzorzec.group(1)),  # noqa: S307 — własny plik repo
        ZNACZNIK_NIEROZPOZNANY=eval(znacznik.group(1)),  # noqa: S307
        DOMAIN="home_mind",
        CONF_API_URL="api_url",
        CONF_API_TOKEN="api_token",
        CONF_USER_ID="user_id",
        CONF_CUSTOM_PROMPT="custom_prompt",
        CONF_PREFER_LOCAL="prefer_local",
        CONF_WEB_SEARCH_LIMIT="web_search_limit",
        DEFAULT_WEB_SEARCH_LIMIT=2,
        CONF_MEMORY_TOKEN_LIMIT="memory_token_limit",
        DEFAULT_MEMORY_TOKEN_LIMIT=4000,
        CONF_WEB_SEARCH_MODE="web_search_mode",
        DEFAULT_USER_ID="default",
        DEFAULT_TIMEOUT=30,
        API_CHAT_ENDPOINT="/api/chat",
        API_CHAT_STREAM_ENDPOINT="/api/chat/stream",
        HOME_ASSISTANT_AGENT="conversation.home_assistant",
    )


def wczytaj_agenta():
    plik = SKLADNIK / "conversation.py"
    spec = importlib.util.spec_from_file_location("conv", plik)
    conv = importlib.util.module_from_spec(spec)
    sys.modules["conv"] = conv
    # Plik jest częścią pakietu (`from .const import …`), a my ładujemy go luzem.
    zrodlo = plik.read_text(encoding="utf-8").replace("from .const import", "from const import")
    exec(compile(zrodlo, str(plik), "exec"), conv.__dict__)  # noqa: S102
    return conv


# --- Scena --------------------------------------------------------------------

OSOBY = {"lech": "Lech", "zuza": "Zuza"}


class Kontekst:
    def __init__(self, user_id=None):
        self.user_id = user_id


class Wejscie:
    def __init__(self, text, cid=None, uid=None, agent_id="conversation.home_mind"):
        self.text = text
        self.conversation_id = cid
        self.context = Kontekst(uid)
        self.agent_id = agent_id
        self.language = "pl"
        self.device_id = None


def agent(conv, prefer_local=False):
    a = object.__new__(conv.HomeMindConversationAgent)
    a._stan_rozmowy = {}
    # Agent budowany przez `object.__new__` omija `__init__`, wiec KAZDE nowe
    # pole obiektu trzeba dolozyc tutaj. Bez tego testy padaja na
    # AttributeError daleko od miejsca, ktore je wprowadzilo.
    a._podobienstwa_mowcy = {}
    a._ostatnia_rozmowa = {}
    a._podmiana = {}
    a._default_user_id = "default"
    a.entry = MagicMock()
    a.entry.options = {"prefer_local": prefer_local}
    a.hass = MagicMock()
    a.hass.states.async_all.return_value = []
    a._person_for_voiceprint = lambda s: (s, OSOBY[s]) if s in OSOBY else None

    async def call_api(**k):
        return (a._odpowiedz, True)

    a._call_api = call_api

    async def call_api_stream(chat_log, **k):
        # Odwzorowuje to, co robi prawdziwa droga strumieniowa: wpycha delty do
        # dziennika, a dopiero potem oddaje calosc. Dzieki temu test zlapie
        # regresje, w ktorej tura przestaje karmic `chat_log` — czyli asystent
        # przestaje mowic wczesniej, choc odpowiedz nadal wraca.
        async def kawalki():
            yield {"role": "assistant"}
            yield {"content": a._odpowiedz}

        async for _ in chat_log.async_add_delta_content_stream("test", kawalki()):
            pass
        return (a._odpowiedz, True)

    a._call_api_stream = call_api_stream
    a.entity_id = "conversation.home_mind"
    a._odpowiedz = "Zrobione."

    async def resolve(uid):
        return "Lech"

    a._resolve_user_name = resolve
    return a


async def uruchom(conv, a, tekst, cid=None, odpowiedz="Zrobione."):
    a._odpowiedz = odpowiedz
    # Wolamy `_async_handle_message`, a nie `async_process`: to drugie nalezy
    # do bazy HA i samo otwiera `chat_log`, czego bez prawdziwego HA nie ma jak
    # zrobic. Nasza logika tury siedzi w calosci tutaj.
    return await a._async_handle_message(Wejscie(tekst, cid), ChatLog())


class Wynik:
    def __init__(self):
        self.ok = True

    def __call__(self, nazwa, warunek):
        print(("  ✅ " if warunek else "  ❌ ") + nazwa)
        self.ok = self.ok and bool(warunek)


async def main() -> int:
    zbuduj_zaslepki()
    zbuduj_const()
    conv = wczytaj_agenta()

    # `replace` z dataclasses nie ugryzie naszego prostego Wejscia.
    def replace_stub(obj, **zmiany):
        nowy = Wejscie(obj.text, obj.conversation_id, obj.context.user_id, obj.agent_id)
        for k, v in zmiany.items():
            setattr(nowy, k, v)
        return nowy

    conv.replace = replace_stub
    sprawdz = Wynik()

    print("\n1. Rozpoznany otwiera sesję, mikrofon zostaje otwarty")
    a = agent(conv)
    r = await uruchom(conv, a, "[lech:0.62] zapal światło")
    cid = r.conversation_id
    sprawdz("mikrofon otwarty", r.continue_conversation is True)
    sprawdz("właściciel = lech", a._stan_rozmowy[cid]["wlasciciel"] == "lech")
    sprawdz("asystent odpowiedział", r.response.speech == "Zrobione.")

    print("\n2. Ta sama osoba w tej samej sesji — przechodzi")
    r = await uruchom(conv, a, "[lech:0.41] a teraz zgaś", cid)
    sprawdz("odpowiedź jest", r.response.speech == "Zrobione.")
    sprawdz("mikrofon dalej otwarty", r.continue_conversation is True)
    sprawdz("licznik obcych wyzerowany", a._stan_rozmowy[cid]["obce"] == 0)

    print("\n3. Tło (bez znacznika) w cudzej sesji — cisza, mikrofon zostaje")
    r = await uruchom(conv, a, "wyłącz wszystko w domu", cid)
    sprawdz("CISZA (pusta odpowiedź)", r.response.speech == "")
    sprawdz("mikrofon otwarty — właściciel może powtórzyć", r.continue_conversation is True)
    sprawdz("obce = 1", a._stan_rozmowy[cid]["obce"] == 1)

    print("\n4. Inny ROZPOZNANY domownik w cudzej sesji — też cisza")
    r = await uruchom(conv, a, "[zuza:0.55] otwórz rolety", cid)
    sprawdz("CISZA", r.response.speech == "")
    sprawdz("obce = 2", a._stan_rozmowy[cid]["obce"] == 2)

    print("\n5. Trzecia obca tura z rzędu — mikrofon się zamyka")
    r = await uruchom(conv, a, "coś z telewizora", cid)
    sprawdz("CISZA", r.response.speech == "")
    sprawdz("mikrofon ZAMKNIĘTY", r.continue_conversation is False)
    sprawdz("stan posprzątany", cid not in a._stan_rozmowy)

    print("\n6. Właściciel wraca przed limitem — licznik się zeruje")
    a = agent(conv)
    r = await uruchom(conv, a, "[lech:0.62] zapal światło")
    cid = r.conversation_id
    await uruchom(conv, a, "szum z pokoju", cid)
    sprawdz("obce = 1", a._stan_rozmowy[cid]["obce"] == 1)
    r = await uruchom(conv, a, "[lech:0.44] zgaś", cid)
    sprawdz("polecenie wykonane", r.response.speech == "Zrobione.")
    sprawdz("obce z powrotem 0", a._stan_rozmowy[cid]["obce"] == 0)

    print("\n7. Nierozpoznana pierwsza tura — wykonuje, ale zamyka sesję")
    a = agent(conv)
    r = await uruchom(conv, a, "zapal światło w kuchni")
    sprawdz("polecenie WYKONANE", r.response.speech == "Zrobione.")
    sprawdz("mikrofon ZAMKNIĘTY (strzał pojedynczy)", r.continue_conversation is False)
    sprawdz("brak sesji", r.conversation_id not in a._stan_rozmowy)

    print("\n8. Słabe dopasowanie (0.31 < 0.35) — wykonuje, sesji nie otwiera")
    a = agent(conv)
    r = await uruchom(conv, a, "[lech:0.31] zapal światło")
    sprawdz("polecenie WYKONANE", r.response.speech == "Zrobione.")
    sprawdz("mikrofon ZAMKNIĘTY", r.continue_conversation is False)

    print("\n9. Pożegnanie właściciela zamyka sesję")
    a = agent(conv)
    cid = (await uruchom(conv, a, "[lech:0.62] zapal światło")).conversation_id
    r = await uruchom(conv, a, "[lech:0.60] dziękuję", cid)
    sprawdz("mikrofon ZAMKNIĘTY", r.continue_conversation is False)
    sprawdz("stan posprzątany", cid not in a._stan_rozmowy)

    print("\n10. Nowe wybudzenie = identyfikacja od zera")
    a = agent(conv)
    await uruchom(conv, a, "[lech:0.62] zapal światło")
    r = await uruchom(conv, a, "[zuza:0.55] otwórz rolety")
    sprawdz("Zuza dostaje SWOJĄ sesję", r.response.speech == "Zrobione.")
    sprawdz("właściciel = zuza", a._stan_rozmowy[r.conversation_id]["wlasciciel"] == "zuza")

    print("\n11. Detektor obcego głosu W TYM SAMYM nagraniu (zapaść dopasowania)")
    # Odtworzone z rozmowy 14.08: tury czyste ~0,6, a tura z doklejona cudza
    # mowa 0,384. Detektor porownuje z tym, jak ta osoba wypada ZWYKLE, bo
    # 0,384 to wciaz poprawne rozpoznanie — prog 0,30 przechodzi i ma przechodzic.
    a = agent(conv)
    for podobienstwo in ("0.62", "0.65", "0.59", "0.68", "0.61"):
        await uruchom(conv, a, f"[lech:{podobienstwo}] zapal światło")
    odniesienie = list(a._podobienstwa_mowcy["lech"])
    sprawdz("odniesienie uzbierane z 5 czystych tur", len(odniesienie) == 5)

    sprawdz(
        "tura 0.384 uznana za podejrzaną",
        a._zbadaj_zanieczyszczenie("lech", 0.384) is True,
    )
    sprawdz(
        "podejrzana próbka NIE weszła do odniesienia (detektor się nie tępi)",
        list(a._podobienstwa_mowcy["lech"]) == odniesienie,
    )
    sprawdz(
        "zwykłe wahanie 0.589 NIE jest alarmem",
        a._zbadaj_zanieczyszczenie("lech", 0.589) is False,
    )
    sprawdz(
        "bez znacznika podobieństwa detektor milczy",
        a._zbadaj_zanieczyszczenie("lech", None) is False,
    )
    b = agent(conv)
    sprawdz(
        "przed uzbieraniem odniesienia nie ma fałszywych alarmów",
        b._zbadaj_zanieczyszczenie("lech", 0.10) is False,
    )

    print("\n12. Strumieniowanie: tura głosowa karmi ChatLog")
    # Bez delt w dzienniku potok Assist NIE zacznie mowic wczesniej — a tura
    # i tak zwroci poprawna odpowiedz, wiec regresja bylaby niewidoczna z
    # zewnatrz. Stad osobny warownik.
    a = agent(conv)
    dziennik = conv.ChatLog()
    r = await a._async_handle_message(Wejscie("[lech:0.62] opowiedz żart", None), dziennik)
    sprawdz("odpowiedź wróciła", r.response.speech == "Zrobione.")
    sprawdz("delty trafiły do dziennika", len(dziennik.delty) >= 2)
    sprawdz(
        "pierwsza delta otwiera rolę asystenta",
        dziennik.delty[0].get("role") == "assistant",
    )
    sprawdz(
        "treść poszła jako delta",
        any(d.get("content") == "Zrobione." for d in dziennik.delty),
    )

    print("\n13. Wznawianie przerwanej rozmowy")
    # Mikrofon bywa zamykany za wcześnie. Bez wznawiania asystent gubił wątek
    # w środku rundy zagadek i pytał „czy to były słowa z naszej zagadki?".
    a = agent(conv)
    r1 = await uruchom(conv, a, "[lech:0.62] zadaj mi zagadkę")
    cid1 = r1.conversation_id
    r2 = await uruchom(conv, a, "[lech:0.62] nie wiem")     # nowe wybudzenie, bez cid
    sprawdz("ta sama osoba wraca do TEJ SAMEJ rozmowy", r2.conversation_id == cid1)

    # 🔑 Weto biometryczne: rozpoznany ktoś INNY nie dziedziczy cudzej historii.
    r3 = await uruchom(conv, a, "[zuza:0.62] a mnie coś opowiedz")
    sprawdz("inna rozpoznana osoba dostaje WŁASNĄ rozmowę", r3.conversation_id != cid1)

    # Pożegnanie kasuje ślad — „dobranoc" znaczy koniec, nie przerwę.
    b = agent(conv)
    rb1 = await uruchom(conv, b, "[lech:0.62] opowiedz żart")
    await uruchom(conv, b, "[lech:0.62] dobranoc")
    rb3 = await uruchom(conv, b, "[lech:0.62] a jednak jeszcze jedno")
    sprawdz("po pożegnaniu NIE wznawiamy", rb3.conversation_id != rb1.conversation_id)

    # Okno jest skończone: stary ślad nie może wracać po godzinie.
    c = agent(conv)
    rc1 = await uruchom(conv, c, "[lech:0.62] opowiedz żart")
    klucz = "bez-urzadzenia"
    cid, _, mowca = c._ostatnia_rozmowa[klucz]
    c._ostatnia_rozmowa[klucz] = (cid, 0.0, mowca)   # udajemy, że było dawno
    rc2 = await uruchom(conv, c, "[lech:0.62] i co dalej")
    sprawdz("po wygaśnięciu okna zaczynamy od nowa", rc2.conversation_id != rc1.conversation_id)

    print("\n14. Czyste pożegnanie domykamy sami, bez pytania zwrotnego")
    # 20.08: „dziękuję, to wszystko” wracało z uprzejmym „czy mogę jeszcze w
    # czymś pomóc?", a mikrofon był w tej samej chwili zamykany. Pytanie leciało
    # w próżnię i prowokowało odpowiedź, której nikt nie słyszał.
    a = agent(conv)
    cid = (await uruchom(conv, a, "[lech:0.62] zapal światło")).conversation_id
    r = await uruchom(conv, a, "[lech:0.60] Dziękuję, to wszystko.", cid)
    sprawdz("model NIE był pytany", r.response.speech != "Zrobione.")
    sprawdz(
        "odpowiedź to formułka podziękowania",
        r.response.speech in conv.HomeMindConversationAgent.ODPOWIEDZI_KONCA["podziekowanie"],
    )
    sprawdz("bez pytania na końcu", "?" not in (r.response.speech or ""))
    sprawdz("mikrofon ZAMKNIĘTY", r.continue_conversation is False)
    sprawdz("stan posprzątany", cid not in a._stan_rozmowy)
    sprawdz("ślad skasowany — po pożegnaniu nie wznawiamy", not a._ostatnia_rozmowa)

    r = await uruchom(conv, a, "[lech:0.62] dobranoc")
    sprawdz(
        "„dobranoc” dostaje formułkę nocną",
        r.response.speech in conv.HomeMindConversationAgent.ODPOWIEDZI_KONCA["noc"],
    )

    # 🔑 Pożegnanie z doklejonym poleceniem NIE jest czyste — polecenie musi
    # trafić do modelu, inaczej naprawa zjadałaby „dobranoc, zgaś światło”.
    r = await uruchom(conv, a, "[lech:0.62] dobranoc, zgaś światło")
    sprawdz("polecenie przy pożegnaniu WYKONANE", r.response.speech == "Zrobione.")
    sprawdz("ale mikrofon i tak zamknięty", r.continue_conversation is False)

    r = await uruchom(conv, a, "[lech:0.62] dziękuję, zapal jeszcze światło w salonie")
    sprawdz("„dziękuję” na początku polecenia nie kończy tury", r.response.speech == "Zrobione.")

    formula = conv.HomeMindConversationAgent._formula_pozegnania
    sprawdz("„dzięki wielkie” to podziękowanie", formula("Dzięki wielkie!") is not None)
    sprawdz("„to wszystko na dziś” łapane", formula("To wszystko na dziś.") is not None)
    sprawdz("zwykłe polecenie nie jest pożegnaniem", formula("zgaś światło") is None)
    sprawdz(
        "„koniec filmu” to nie pożegnanie",
        formula("wyłącz koniec filmu i zgaś") is None,
    )

    print("\n" + ("WSZYSTKO ZIELONE" if sprawdz.ok else "SĄ BŁĘDY"))
    return 0 if sprawdz.ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
