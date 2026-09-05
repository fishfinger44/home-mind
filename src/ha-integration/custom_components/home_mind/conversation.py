"""Conversation agent for Home Mind."""

from __future__ import annotations

import json
import logging
import random
import re
import time
from collections import deque
from dataclasses import replace
from typing import Any, Literal

import aiohttp

from homeassistant.components import conversation as ha_conversation
from homeassistant.components.conversation import (
    ChatLog,
    ConversationEntity,
    ConversationEntityFeature,
    ConversationInput,
    ConversationResult,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, intent
from homeassistant.components.homeassistant.exposed_entities import (
    async_should_expose,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import ulid

from .const import (
    SPEAKER_TAG_PATTERN,
    DOMAIN,
    CONF_API_URL,
    CONF_API_TOKEN,
    CONF_USER_ID,
    CONF_CUSTOM_PROMPT,
    CONF_PREFER_LOCAL,
    CONF_WEB_SEARCH_LIMIT,
    DEFAULT_WEB_SEARCH_LIMIT,
    CONF_MEMORY_TOKEN_LIMIT,
    DEFAULT_MEMORY_TOKEN_LIMIT,
    CONF_WEB_SEARCH_MODE,
    DEFAULT_USER_ID,
    DEFAULT_TIMEOUT,
    API_CHAT_ENDPOINT,
    API_CHAT_STREAM_ENDPOINT,
    HOME_ASSISTANT_AGENT,
)

_LOGGER = logging.getLogger(__name__)

# Ciagla rozmowa: mikrofon zostaje otwarty po kazdej turze glosowej.
#
# WLACZONE 2026-08-06. Krotko bylo wylaczone na podstawie blednej diagnozy:
# uznalem niskie podobienstwo (0.05-0.10) za dowod, ze satelita slyszy wlasny
# glosnik, a historia rozmowy pokazala normalna wymiane z uzytkownikiem — tak
# niski wynik daja po prostu bardzo krotkie wypowiedzi, przy ktorych weryfikacja
# mowcy jest zawodna. Prawdziwa przyczyna zlego dzialania bylo wycinanie mowy
# przez bramke energetyczna w voice-match (naprawione osobno).
#
# Po odpowiedzi mikrofon zostaje otwarty przez 15 s (timeout VAD w potoku HA);
# cisza konczy ture i wraca slowo budzace, mowa przedluza lancuch.
CONTINUE_CONVERSATION = True

# Kiedy zamknac mikrofon w ciaglej rozmowie.
#
# Problem, ktory to rozwiazuje (zapis z satelity 07.08): kazda odpowiedz
# otwiera mikrofon ponownie, wiec halas w pokoju wypelnia to otwarcie, dostaje
# odpowiedz i otwiera mikrofon nastepny raz. Po „Dziekuje" -> „Prosze bardzo"
# przyszlo „mama." -> „W czym moge pomoc?" i przekrecone zdanie -> „Nie
# rozumiem…", a mikrofon byl otwarty TAKZE po tej ostatniej turze. Rozmowa
# ucichla dlatego, ze zabraklo dosc glosnego dzwieku, a nie dlatego, ze ja
# zamknelismy.
#
# ROZPOZNANY MOWCA NIE MA ZADNEGO LIMITU. Ciagla rozmowa istnieje po to, zeby
# byla ciagla; ucinanie jej po dwoch turach „bez akcji" kaleczylo dokladnie to,
# czemu ma sluzyc. Sygnal, ktory odroznia czlowieka od pokoju, mamy juz i w tej
# rozmowie zadzialal bezblednie: tury 1-2 przyszly ze znacznikiem `[lech]` z
# voice-match, tury 3-4 (szum) bez zadnego znacznika.
#
# Stad dwa progi dla dwoch roznych sytuacji:

# SESJA NALEZY DO JEDNEJ OSOBY (2026-08-07).
#
# Dotad kazda tura byla oceniana osobno, wiec glos z tla — telewizor albo drugi
# domownik — wchodzil w otwarty mikrofon i dostawal swoje polecenie wykonane.
# Liczniki ponizej zamykaly nasluch DOPIERO PO fakcie, czyli po turze, ktora juz
# cos zrobila. 07.08 „Ok." nierozpoznanym glosem uruchomilo odkurzacz ponownie i
# zatrzymala to dopiero bramka `ograniczenia.json`, nie ta funkcja.
#
# Teraz pierwsza rozpoznana tura ZAMYKA sesje na te osobe, a kazda nastepna tura
# musi przyjsc od niej. Cudza — rozpoznana czy nie — jest po cichu ignorowana:
# bez modelu, bez akcji, bez odpowiedzi. Nowe slowo budzace = nowa sesja i
# rozpoznanie od zera.
#
# ⚠️ Slowo budzace NIE identyfikuje mowcy (microWakeWord zna fraze, nie barwe
# glosu; ~1 s to za malo dla ECAPA), wiec kotwica to tura PIERWSZA, nie
# wybudzenie. Ta jedna tura zostaje bez ochrony — jest tez najbezpieczniejsza,
# bo beam wlasnie zatrzasnal sie na kierunku, z ktorego padlo slowo budzace.

# Ile obcych tur z rzedu wolno przeczekac, zanim mikrofon sie zamknie.
#
# Ignorowanie jest tanie po stronie modelu (zero tokenow, zero akcji), ale NIE po
# stronie ASR: obca tura zostaje najpierw nagrana i przetranskrybowana, dopiero
# potem tu odrzucona. Limit jest wiec po to, zeby gadajacy telewizor ani nie
# trzymal mikrofonu otwartego w nieskonczonosc, ani nie przejadal kredytow
# ElevenLabs. Przy suficie tury 15 s (`__init__.py`: `SUFIT_TURY_S`) trzy tury to
# najwyzej ~45 s nagrania na sesje.
#
# UWAGA: od 08.08 okno nasluchu to nie jest juz jedna liczba — 8 s CISZY konczy
# ture, a 15 s to bezwzgledny sufit dla dzwieku bez przerw. Ten rachunek opiera
# sie na suficie, bo tylko on ogranicza ture, w ktorej cos gada non stop.
#
# 3, nie 1, bo pod ten sam licznik podpada wlasciciel, ktorego voice-match
# chybil: weryfikacja jest zawodna przy BARDZO KROTKICH wypowiedziach („tak",
# „nie", „jeszcze jeden") — pomiar 07.08 dal 0.221 dla „Okej." (2,1 s). Dwie
# proby powtorzenia to minimum, zeby ta zawodnosc nie kosztowala polecenia.
MAX_TUR_OBCYCH = 3

# Ile trzeba, zeby OTWORZYC sesje na swoje nazwisko (tylko to — tozsamosc dla
# pamieci zostaje bez zmian).
#
# Zostac w juz otwartej sesji jest LZEJ: wystarczy, ze znacznik od voice-match w
# ogole przyszedl i wskazuje wlasciciela, czyli faktycznie prog 0.30
# (`VERIFY_THRESHOLD` — ponizej niego znacznika nie ma wcale, wiec HA nie ma
# czego porownywac i nizszego progu NIE DA SIE tu ustawic; trzeba by ruszyc
# voice-match, a to zmienia takze przypisywanie faktow do pamieci). Asymetria
# jest celowa i zasadna: wiemy juz, kto mowi, wiec slabsze dopasowanie niesie
# wiecej informacji niz przy otwieraniu sesji.
#
# voice-match przepuszcza wszystko powyzej 0.30. Ale 0.31 i 0.95 to dwie rozne
# rzeczy, a dotad byly nierozroznialne: liczba powstawala co ture i szla
# wylacznie do logu, a dalej jechal goly werdykt. Dopasowanie tuz nad progiem
# rownie dobrze moze byc halasem, ktory przypadkiem trafil — i wtedy trzymanie
# mikrofonu otwartego bez konca jest dokladnie ta petla, ktora zamykamy.
#
# 0.35 to prog OSTROZNY, nie zmierzony: jedyny znany pomiar prawdziwej mowy to
# 0.556, danych o halasie tuz nad progiem nie ma wcale. Kazda tura ponizej tej
# wartosci loguje sie na INFO wlasnie po to, zeby strojenie bylo pytaniem o
# dane, a nie o przeczucie. Pojedyncza niepewna tura i tak niczego nie utnie —
# licznik wybacza jedna.
PEWNE_ROZPOZNANIE = 0.35

# DETEKTOR ZANIECZYSZCZONEJ TURY — obcy glos W TYM SAMYM nagraniu co mowca.
#
# Progi dobrane do jedynego zmierzonego materialu (rozmowa 14.08): tury czyste
# 0,509-0,684, tura z doklejona cudza mowa 0,384. Przy sredniej ~0,62 daje to
# 62% normy, wiec prog 75% lapie ten przypadek z zapasem i nie rusza wahania
# 0,589/0,62 (95%), ktore od zwyklej zmiennosci glosu jest nieodroznialne.
#
# ⚠️ To sa progi z JEDNEJ rozmowy. Zanim cokolwiek na nich oprzec poza logiem,
# zebrac wiecej trafien — patrz ostrzezenie w `_zbadaj_zanieczyszczenie`.
PROG_ZAPASCI = 0.75
OKNO_PODOBIENSTW = 20
MIN_PROBEK_ODNIESIENIA = 5

# WZNAWIANIE PRZERWANEJ ROZMOWY.
#
# Mikrofon bywa zamykany za wcześnie — cisza w złym momencie kończy turę,
# a przy następnym wybudzeniu asystent zaczynał od zera i gubił wątek
# (zgłoszone przez Lecha 15.08 przy rundzie zagadek).
#
# 🔑 Kluczem jest URZĄDZENIE, nie mówca — bo przerwana rozmowa najczęściej
# wraca z tego samego satelity, a wymaganie pewnego rozpoznania sprawiłoby,
# że wznowienie prawie nigdy by nie zaskoczyło (weryfikacja bywa zawodna przy
# krótkich wypowiedziach — zmierzone 0,221 dla „Okej.").
#
# ⛔ Biometria zostaje jednak jako WETO, nie jako warunek: gdy poprzednią
# rozmowę miała rozpoznana osoba, a teraz mówi rozpoznana INNA — nie wznawiamy.
# Bez tego jedno wybudzenie oddawałoby cudzą historię.
#
# ⛔ Okno jest krótkie z rozmysłem. Dłuższe zlepiałoby rozmowy niezwiązane
# ze sobą i zamieniało „wznowienie" w „asystent pamięta wszystko z rana" —
# czyli w lawinę, przed którą sami się bronimy.
OKNO_WZNOWIENIA_S = 180.0


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up conversation agent from a config entry."""
    agent = HomeMindConversationAgent(hass, config_entry)
    async_add_entities([agent])


class HomeMindConversationAgent(ConversationEntity):
    """Home Mind conversation agent."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = ConversationEntityFeature.CONTROL
    # Potok Assist zaczyna mowic, zanim model skonczy — ale TYLKO gdy agent to
    # zglosi (`pipeline.py`: `tts_stream.supports_streaming_input AND
    # intent_agent.supports_streaming`). Piper po naszej stronie juz to potrafi.
    _attr_supports_streaming = True

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the agent."""
        self.hass = hass
        self.entry = entry
        self._api_url = entry.data[CONF_API_URL].rstrip("/")
        self._api_token = entry.data.get(CONF_API_TOKEN, "").strip() or None
        self._default_user_id = entry.data.get(CONF_USER_ID, DEFAULT_USER_ID)
        self._session = async_get_clientsession(hass)
        # Stan ciaglej rozmowy, per conversation_id: do kogo nalezy sesja
        # (`wlasciciel` — profil pamieci osoby, ktora ja otworzyla) i ile obcych
        # tur z rzedu przeczekalismy. Slownik, a nie pojedyncze liczniki, bo
        # rozmowa pisana moze trwac obok glosowej; wpis znika, gdy tura sie
        # domyka, wiec nie rosnie w nieskonczonosc.
        self._stan_rozmowy: dict[str, dict[str, Any]] = {}
        # Ostatnie CZYSTE dopasowania per mowca — odniesienie dla detektora
        # zanieczyszczonej tury (patrz `_zbadaj_zanieczyszczenie`).
        #
        # Per MOWCA, a nie per rozmowa, swiadomie: zanieczyszczona bywa juz
        # PIERWSZA tura sesji (tak bylo 14.08 — 0,384 otwieralo rozmowe), a
        # odniesienie liczone w obrebie jednej sesji nie mialoby wtedy z czym
        # porownywac i przegapiloby dokladnie ten przypadek.
        self._podobienstwa_mowcy: dict[str, deque[float]] = {}
        # Ostatnia rozmowa na urządzeniu:
        # {urządzenie: (conversation_id, kiedy, mówca_lub_None)}.
        # Patrz OKNO_WZNOWIENIA_S.
        self._ostatnia_rozmowa: dict[str, tuple[str, float, str | None]] = {}
        # Podmiany `conversation_id`: {id_od_HA: (nasze_nowe_id, kiedy)}.
        #
        # Gdy przejmiemy sesje po kims innym, zakladamy WLASNE id — inaczej nowy
        # mowca dostalby cudza historie po stronie serwera (to samo id = ten sam
        # watek). Ale HA o tym nie wie i w nastepnej turze poda znowu SWOJE,
        # stare id. Bez tej mapy tura druga wracalaby na cudzy watek, z ktorego
        # tura pierwsza wlasnie uciekla.
        self._podmiana: dict[str, tuple[str, float]] = {}

        self._attr_unique_id = entry.entry_id
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Home Mind",
            manufacturer="Home Mind",
            model="AI Assistant",
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return supported languages."""
        return MATCH_ALL

    async def _async_handle_message(
        self, user_input: ConversationInput, chat_log: ChatLog
    ) -> ConversationResult:
        """Process a conversation input and return a response.

        🔑 To bylo `async_process`. Przeniesione, bo bazowe `async_process`
        otwiera `chat_log` i dopiero podaje go tutaj — a bez `chat_log` nie ma
        jak wpychac delt, czyli nie ma strumieniowania do TTS. Zachowanie tury
        jest bez zmian; dochodzi tylko dostep do dziennika rozmowy.

        ⚠️ Wczesne wyjscia (cisza dla obcego glosu, odpowiedz agenta lokalnego)
        `chat_log` NIE dotykaja i tak ma zostac — potok radzi sobie z tura, ktora
        nie przyslala ani jednej delty.
        """
        _LOGGER.debug("Processing conversation input: %s", user_input.text)

        # A speaker tag from voice-match has to come off before anything reads
        # the text: the built-in agent below would fail to match "[lech] zapal
        # światło" against any intent, and the model should never see it either.
        message, speaker, podobienstwo = self._split_speaker_tag(user_input.text)
        if speaker:
            user_input = replace(user_input, text=message)

        # Pusta transkrypcja konczy ture bez pytania modelu i bez otwierania
        # mikrofonu ponownie. Home Assistant tego nie sprawdza — po pustym
        # rozpoznaniu mowy woła agenta z pustym tekstem (`assert intent_input
        # is not None` i nic wiecej), wiec przy wlaczonej ciaglej rozmowie
        # kazda cisza zaczynalaby kolejna ture. Mostek do Gemini odrzuca cisze
        # wczesniej i zwraca wlasnie pusty tekst; tutaj domykamy petle.
        # (Pożegnanie zamyka nasłuch niżej, przy składaniu ConversationResult —
        # tutaj stał blok, który wyglądał jakby je obsługiwał, a tylko logował.)

        if not message.strip():
            _LOGGER.debug("Pusta transkrypcja — koncze ture")
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech("")
            return ConversationResult(
                response=intent_response,
                conversation_id=user_input.conversation_id or ulid.ulid_now(),
                continue_conversation=False,
            )

        # Get user ID from context if available, otherwise use default
        user_id = self._default_user_id
        user_name: str | None = None
        identity_confidence = "certain"
        if user_input.context and user_input.context.user_id:
            account_id = str(user_input.context.user_id)
            user_id = self._profile_for_account(account_id)
            user_name = await self._resolve_user_name(account_id)
        elif speaker:
            # No logged-in user, but the voiceprint matched. A satellite is the
            # only place this happens, and it is exactly the case that used to
            # fall back to the shared profile.
            account = self._person_for_voiceprint(speaker)
            if account:
                user_id, user_name = account
                identity_confidence = "asserted"
                _LOGGER.debug("Voice biometrics identified %s -> %s", speaker, user_id)
            else:
                _LOGGER.warning(
                    "Voiceprint '%s' matches nobody in Settings → People; "
                    "staying on the shared profile",
                    speaker,
                )

        # Who is asking, in one answer both the shortcut below and the payload
        # can use. A logged-in session is proof; a matched voiceprint is strong
        # evidence; anything else — including a satellite whose speaker matched
        # nobody — is a stranger, whatever the default above says.
        rozpoznany = bool(user_input.context and user_input.context.user_id) or (
            identity_confidence == "asserted"
        )

        # Osobna, ostrzejsza odpowiedz na to samo pytanie, uzywana WYLACZNIE do
        # decyzji o mikrofonie. Tozsamosc wysylana na serwer zostaje nietknieta:
        # slabe dopasowanie nadal jest dopasowaniem i pamiec ma sie zachowac tak
        # samo. Ale trzymanie mikrofonu otwartego bez limitu to zaufanie
        # wiekszego kalibru i wymaga wiekszej pewnosci.
        #
        # Zalogowana sesja nie ma podobienstwa (nie przeszla przez voice-match)
        # i jest dowodem sama w sobie — stad `is None` po stronie pewnych.
        pewnie_rozpoznany = rozpoznany and (
            podobienstwo is None or podobienstwo >= PEWNE_ROZPOZNANIE
        )
        if podobienstwo is not None and not pewnie_rozpoznany:
            # INFO, nie DEBUG: to jest material do strojenia progu i ma byc
            # widoczny bez wlaczania diagnostyki. Przypadek jest rzadki, wiec
            # nie zaleje logu.
            _LOGGER.info(
                "Głos '%s' dopasowany słabo (%.3f < %.2f) — do decyzji o "
                "mikrofonie traktuję jak nierozpoznany",
                speaker, podobienstwo, PEWNE_ROZPOZNANIE,
            )
        elif podobienstwo is not None:
            _LOGGER.debug("Głos '%s' dopasowany na %.3f", speaker, podobienstwo)

        # Wynik jest CELOWO nieuzywany: detektor na tym etapie tylko obserwuje
        # i zapisuje do logu. Zwraca bool, zeby dalo sie na nim oprzec decyzje,
        # gdy juz zobaczymy, jak czesto bije — patrz `_zbadaj_zanieczyszczenie`.
        self._zbadaj_zanieczyszczenie(speaker, podobienstwo)

        # Determine if this is a voice request
        is_voice = user_input.agent_id is not None

        # Generate conversation ID if not provided
        conversation_id = user_input.conversation_id or self._wznow_lub_nowa(
            user_id if pewnie_rozpoznany else None,
            is_voice,
            getattr(user_input, "device_id", None),
        )

        conversation_id = self._po_podmianie(conversation_id)

        # Czy ta sesja wciaz nalezy do tego, kto ja otworzyl — patrz
        # `_przejmij_lub_wygas`. Stoi PRZED bramka wlasciciela swiadomie:
        # bramka wie tylko tyle, ze mowca != wlasciciel, i kazda taka ture
        # kasuje w ciszy. Rozstrzygniecie, czy sesja w ogole jeszcze trwa,
        # musi zapasc wczesniej.
        conversation_id, stan = self._przejmij_lub_wygas(
            conversation_id,
            user_id if pewnie_rozpoznany else None,
            is_voice,
            getattr(user_input, "device_id", None),
        )
        wlasciciel = stan["wlasciciel"]

        # Sesja nalezy do osoby, ktora ja otworzyla. Cudza tura — rozpoznana czy
        # nie — konczy sie tutaj: bez modelu, bez akcji, bez odpowiedzi.
        #
        # Cisza, a nie „nie rozpoznaje Twojego glosu", bo to zdanie bylo dla
        # kogos, kto do asystenta nie mowil, a przy telewizorze w tle sam by je
        # wywolal w kolko. Mikrofon zostaje otwarty, wiec wlasciciel moze po
        # prostu powtorzyc — az do MAX_TUR_OBCYCH.
        #
        # Ta bramka stoi PRZED skrotem `prefer_local` swiadomie: wbudowany agent
        # HA rozumie „zapal swiatlo" i wykonalby polecenie z tla, nie docierajac
        # ani tu, ani na serwer, gdzie leza reguly. Ta sama dziura wymagala juz
        # raz osobnej latki przy ograniczeniach urzadzen.
        # 🔴 PUSTA tura to NIE jest obcy człowiek — to najczęściej NASZ WŁASNY głośnik.
        # Zmierzone 19.08: satelita otwiera mikrofon ~1 s po wysłaniu tekstu do lektora,
        # czyli DZIESIĄTKI SEKUND przed końcem odtwarzania (odpowiedź 26,8 s: mikrofon
        # o 19:19:48, koniec grania o 19:20:16). Łapie własną odpowiedź, biometria ją
        # słusznie odrzuca (podobieństwo 0,03), transkrypcja przychodzi pusta — a stara
        # bramka liczyła to jako turę obcą i po `MAX_TUR_OBCYCH` ZAMYKAŁA sesję.
        # Skutek: asystent kończył pytaniem i nie słuchał odpowiedzi.
        # Pusta tura nie niesie żadnej treści, więc nie ma czego pilnować — przepuszczamy
        # ją w ciszy, NIE ruszając licznika obcych i NIE zamykając nasłuchu.
        if is_voice and not message.strip():
            _LOGGER.info(
                "Pusta tura (%s) — najpewniej własne odtwarzanie; trzymam nasłuch",
                f"podobieństwo {podobienstwo:.3f}" if podobienstwo is not None
                else "bez znacznika",
            )
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech("")
            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
                continue_conversation=CONTINUE_CONVERSATION,
            )

        # LATKA (05.09.2026, zgloszenie Lecha: krotkie "Tak"/"Nie" ignorowane w
        # ciszy). Krotka wypowiedz daje slaby odcisk glosu (ponizej progu w
        # wyoming-voice-match), wiec przychodzi BEZ znacznika mowcy — user_id
        # spada wtedy do wspolnego domyslnego id, co NIE jest dowodem na obca
        # osobe, tylko brakiem pewnej identyfikacji. _przejmij_lub_wygas
        # (wyzej) juz to uwzglednia i NIE kasuje wlasciciela dla takiej tury —
        # ta bramka ma byc z nim spojna, wiec wymaga tego samego: FAKTYCZNIE
        # potwierdzonej innej tozsamosci (rozpoznany), a nie samego
        # niedopasowania do domyslnego id.
        if is_voice and wlasciciel is not None and rozpoznany and user_id != wlasciciel:
            stan = {"wlasciciel": wlasciciel, "obce": stan["obce"] + 1}
            trzymaj = stan["obce"] < MAX_TUR_OBCYCH
            _LOGGER.info(
                "Sesja należy do '%s', a tura przyszła od '%s' (%s) — ignoruję "
                "w ciszy (%d/%d)%s",
                wlasciciel,
                speaker or "nierozpoznany",
                f"{podobienstwo:.3f}" if podobienstwo is not None else "bez znacznika",
                stan["obce"],
                MAX_TUR_OBCYCH,
                "" if trzymaj else " — zamykam nasłuch",
            )
            if trzymaj:
                self._stan_rozmowy[conversation_id] = stan
            else:
                self._stan_rozmowy.pop(conversation_id, None)
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech("")
            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
                continue_conversation=trzymaj,
            )

        # Pozegnanie i nic poza nim — odpowiadamy sami i konczymy ture.
        #
        # Tu, a nie nizej przy skladaniu wyniku: przy glosie tekst modelu jedzie
        # do lektora kawalkami, wiec pozniej nie ma juz czego poprawiac. Przy
        # okazji tura jest darmowa i natychmiastowa — model nie ma nic do
        # roboty przy „dobranoc".
        if is_voice:
            formula = self._formula_pozegnania(message)
            if formula:
                _LOGGER.info(
                    "Czyste pozegnanie ('%s') — domykam ture bez modelu: %s",
                    message.strip(), formula,
                )
                # Sesja i slad znikaja tak samo jak przy pozegnaniu obsluzonym
                # nizej: „dobranoc" znaczy koniec, a nie przerwe.
                self._stan_rozmowy.pop(conversation_id, None)
                self._ostatnia_rozmowa.pop(
                    getattr(user_input, "device_id", None) or "bez-urzadzenia", None
                )
                intent_response = intent.IntentResponse(language=user_input.language)
                intent_response.async_set_speech(formula)
                return ConversationResult(
                    response=intent_response,
                    conversation_id=conversation_id,
                    continue_conversation=False,
                )

        # Local-first: try Home Assistant's built-in agent (0 tokens, no LLM).
        # Only when it can actually act on the command do we return its result;
        # anything it can't match/handle falls through to the Home Mind server.
        #
        # An unrecognised voice never takes this shortcut. The built-in agent
        # understands "otwórz rolety" and "odkurz kuchnię" perfectly well and
        # would act on them without ever reaching the server, where the rules
        # about who may start what actually live — the saving is not worth a
        # door left open behind the lock.
        # Pierwsza pewnie rozpoznana tura zamyka sesje na te osobe. Slabe
        # dopasowanie (ponizej PEWNE_ROZPOZNANIE) polecenie owszem wykona, ale
        # sesji nie otworzy — nie ma na czym oprzec blokady.
        wlasciciel = wlasciciel or (user_id if pewnie_rozpoznany else None)

        if self.entry.options.get(CONF_PREFER_LOCAL) and rozpoznany:
            local_result = await self._try_local(user_input, wlasciciel)
            if local_result is not None:
                return local_result

        try:
            # Strumieniowo tylko przy glosie: przy rozmowie pisanej nie ma TTS,
            # ktory mialby ruszyc wczesniej, wiec caly zysk znika, a zostaje
            # dodatkowa droga, ktora moze sie zepsuc.
            wspolne = {
                "message": message,
                "user_id": user_id,
                "conversation_id": conversation_id,
                "is_voice": is_voice,
                "user_name": user_name,
                "identity_confidence": identity_confidence if rozpoznany else "unknown",
            }
            if is_voice:
                response_text, _tools_used = await self._call_api_stream(
                    chat_log, **wspolne
                )
            else:
                response_text, _tools_used = await self._call_api(**wspolne)
            _LOGGER.debug(
                "Got response: %s", response_text[:100] if response_text else "None"
            )

            # Tura wlasciciela zeruje licznik obcych: rozmowa moze trwac
            # dowolnie dlugo, a to, ze przed chwila cos gadalo w tle, przestaje
            # miec znaczenie, skoro znowu slychac tego samego czlowieka.
            # Licznik pytan zwrotnych w rozmowie bez wlasciciela. Zeruje sie za
            # kazdym razem, gdy asystent NIE odda glosu pytaniem — wiec rosnie
            # tylko w prawdziwym lancuchu pytanie-odpowiedz, a nie przez sam
            # uplyw rozmowy.
            pytania = stan.get("pytania", 0)
            if wlasciciel is None and self._oddaje_glos(response_text):
                pytania += 1
            else:
                pytania = 0
            stan = {"wlasciciel": wlasciciel, "obce": 0, "pytania": pytania}

            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech(response_text)

            trzymaj = self._trzymaj_mikrofon(
                response_text, is_voice, wlasciciel
            ) and not self._is_farewell(message)

            # Ślad do ewentualnego wznowienia. Zapisujemy po KAŻDEJ turze, nie
            # tylko przy zamknięciu mikrofonu: znacznik czasu ma liczyć od
            # ostatniej wymiany, a nie od początku rozmowy.
            # ⛔ Pożegnanie ślad KASUJE — „dobranoc" znaczy koniec, a nie
            # przerwę, i wracanie po nim do tamtego wątku byłoby dziwne.
            if self._is_farewell(message):
                self._ostatnia_rozmowa.pop(
                    getattr(user_input, "device_id", None) or "bez-urzadzenia", None
                )
            elif is_voice:
                self._zapamietaj_rozmowe(
                    getattr(user_input, "device_id", None), conversation_id, wlasciciel
                )

            if trzymaj and wlasciciel is None and pytania > self.MAX_PYTAN_BEZ_WLASCICIELA:
                _LOGGER.info(
                    "Rozmowa bez rozpoznanego mówcy trzymała mikrofon %d pytaniami "
                    "z rzędu — zamykam nasłuch",
                    pytania - 1,
                )
                trzymaj = False

            if trzymaj:
                self._stan_rozmowy[conversation_id] = stan
            else:
                # Tura sie domyka — nie ma czego pamietac, a slownik ma nie rosnac.
                self._stan_rozmowy.pop(conversation_id, None)

            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
                continue_conversation=trzymaj,
            )

        except Exception as err:
            _LOGGER.error("Error calling Home Mind API: %s", err, exc_info=True)

            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                f"Sorry, I couldn't process that request: {err}",
            )

            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
            )

    async def _try_local(
        self, user_input: ConversationInput, wlasciciel: str | None
    ) -> ConversationResult | None:
        """Try the built-in HA agent first. Return its result only if it acted
        on the command; return None to fall through to the Home Mind server.

        A result from here is returned to Home Assistant unchanged apart from
        the continue_conversation flag, which the built-in agent never sets for
        a completed action.
        """
        try:
            result = await ha_conversation.async_converse(
                hass=self.hass,
                text=user_input.text,
                conversation_id=user_input.conversation_id,
                context=user_input.context,
                language=user_input.language,
                agent_id=HOME_ASSISTANT_AGENT,
                device_id=getattr(user_input, "device_id", None),
            )
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.debug("Local agent failed, falling back to Home Mind: %s", err)
            return None

        response_type = result.response.response_type
        # Success = a device action or a data answer handled locally.
        if response_type in (
            intent.IntentResponseType.ACTION_DONE,
            intent.IntentResponseType.QUERY_ANSWER,
        ):
            _LOGGER.debug("Handled locally (%s) — no tokens spent", response_type)
            # The built-in agent ends every turn, so without this the wake word
            # would still be required after exactly the commands people chain
            # most — lights, switches, the time. Those are the ones it answers
            # locally, so they never reach the code below that sets the flag.
            if (
                CONTINUE_CONVERSATION
                and user_input.agent_id is not None
                and wlasciciel is not None
                and not self._is_farewell(user_input.text)
            ):
                result = replace(result, continue_conversation=True)
                # Tu sie trafia wylacznie z rozpoznanym mowca (warunek przy
                # wywolaniu) i wylacznie gdy agent WYKONAL akcje albo odpowiedzial
                # na pytanie o dane. Obie rzeczy zeruja licznik tak samo jak tura
                # obsluzona na serwerze — bez tego lancuch „zapal, zgas, otworz"
                # niosl by ze soba stan sprzed niego. Wlasciciela trzeba tu
                # PRZEPISAC, inaczej tura zalatwiona lokalnie kasowalaby blokade
                # sesji i nastepna moglaby przyjsc od kogokolwiek.
                if result.conversation_id:
                    self._stan_rozmowy[result.conversation_id] = {
                        "wlasciciel": wlasciciel, "obce": 0,
                    }
            return result

        # no_intent_match / no_valid_targets / error → let Home Mind (LLM) try.
        _LOGGER.debug(
            "Local agent could not handle it (%s) — falling back to Home Mind",
            response_type,
        )
        return None

    # Pożegnania. Po nich mikrofon ma się zamknąć — inaczej "dobranoc" zostawia
    # go otwartym na 15 sekund w cichym pokoju, a każdy trzask staje się turą.
    # Dokładnie tak 06.08 o 23:49 hałas przyszedł jako "Jeden.", asystent zrobił
    # z tego pytanie o sprzątanie kuchni i uruchomił mopowanie po niejednoznacznym
    # "Tak, to było trzasknięcie".
    POZEGNANIA = (
        "dobranoc", "do widzenia", "na razie", "to wszystko", "koniec",
        "dziękuję to wszystko", "papa", "cześć", "śpij dobrze", "idę spać",
    )

    # Wypowiedz, ktora JEST samym pozegnaniem, domykamy sami — bez modelu.
    #
    # 20.08: „dziekuje, to wszystko" model kwitowal uprzejmym pytaniem zwrotnym
    # („czy moge jeszcze w czyms pomoc?"), a mikrofon zamyka sie w tej samej
    # chwili — patrz `_is_farewell` nizej. Pytanie leci wiec w prozne powietrze i
    # prowokuje odpowiedz, ktorej nikt juz nie slyszy.
    #
    # ⚠️ Naprawa MUSI stac przed wywolaniem modelu, nie po nim: przy glosie
    # odpowiedz jedzie strumieniowo do lektora (`_call_api_stream`), wiec
    # obcinanie pytania z gotowego tekstu przyszloby po tym, jak zostalo
    # wypowiedziane.
    #
    # ⚠️ Tylko wypowiedz, ktora jest pozegnaniem W CALOSCI. „Dobranoc, zgas
    # swiatlo" niesie polecenie i idzie do modelu jak dotad — dlatego to jest
    # osobne, ostrzejsze sito niz `_is_farewell`, ktore lapie tez pozegnanie z
    # doklejona trescia.
    #
    # Frazy od NAJDLUZSZEJ, bo dopasowanie jest przez zawieranie: „to wszystko"
    # zjadloby polowe „to wszystko na dzis" i zostawilo nieznana reszte.
    FORMULY_KONCA = (
        ("to by bylo na tyle", "koniec"), ("to by było na tyle", "koniec"),
        ("to wszystko na dzis", "koniec"), ("to wszystko na dziś", "koniec"),
        ("spij dobrze", "noc"), ("śpij dobrze", "noc"),
        ("dobrej nocy", "noc"), ("ide spac", "noc"), ("idę spać", "noc"),
        ("do widzenia", "rozstanie"), ("do zobaczenia", "rozstanie"),
        ("na razie", "rozstanie"), ("to wszystko", "koniec"),
        ("to na tyle", "koniec"), ("nic wiecej", "koniec"), ("nic więcej", "koniec"),
        ("dobranoc", "noc"), ("papa", "rozstanie"), ("koniec", "koniec"),
        ("dziekuje", "podziekowanie"), ("dziękuję", "podziekowanie"),
        ("dzieki", "podziekowanie"), ("dzięki", "podziekowanie"),
    )

    # Uprzejmosci i doklejki bez tresci — wolno im zostac w resztce po wycieciu
    # formul. Cokolwiek innego znaczy, ze w wypowiedzi bylo jeszcze polecenie.
    WYPELNIACZE = (
        "bardzo", "ci", "wam", "panu", "pani", "wielkie", "serdecznie",
        "ok", "okej", "dobra", "no", "juz", "już", "na", "dzis", "dziś", "dzisiaj",
    )

    # Po jednym wariancie za malo: ta sama sylaba po kazdej rozmowie brzmi jak
    # automat, a to jest ostatnie zdanie, ktore czlowiek slyszy.
    ODPOWIEDZI_KONCA = {
        "noc": ("Dobranoc.", "Dobranoc, śpij dobrze."),
        "rozstanie": ("Do usłyszenia.", "Na razie."),
        "podziekowanie": ("Proszę bardzo.", "Nie ma za co."),
        "koniec": ("Jasne.", "W porządku."),
    }

    @classmethod
    def _formula_pozegnania(cls, message: str) -> str | None:
        """Zdanie na pozegnanie, jesli CALA wypowiedz nim jest. Inaczej None."""
        tekst = " ".join(re.sub(r"[.!?…,;:–-]+", " ", message.lower()).split())
        if not tekst or len(tekst) > 40:
            return None

        rodzaje = []
        for fraza, rodzaj in cls.FORMULY_KONCA:
            if fraza in tekst:
                tekst = tekst.replace(fraza, " ")
                rodzaje.append(rodzaj)

        if not rodzaje or any(s not in cls.WYPELNIACZE for s in tekst.split()):
            return None

        # „Dziekuje, to wszystko" to jedno i drugie naraz. Odpowiadamy na to,
        # co niesie wiecej: dobranoc bije rozstanie, a podziekowanie bije samo
        # oznajmienie konca — „prosze bardzo" pasuje lepiej niz „jasne".
        for rodzaj in ("noc", "rozstanie", "podziekowanie", "koniec"):
            if rodzaj in rodzaje:
                return random.choice(cls.ODPOWIEDZI_KONCA[rodzaj])
        return None

    # Podziekowanie konczy wymiane tylko wtedy, gdy jest CALA wypowiedzia.
    #
    # Osobno od POZEGNANIA, bo tamte dopasowuja sie takze jako poczatek zdania
    # („dobranoc, zgas swiatlo" to pozegnanie mimo doklejonego polecenia). Przy
    # podziekowaniu ta sama regula bylaby szkodliwa: „Dziekuje, zapal jeszcze
    # swiatlo w salonie" to polecenie, nie koniec rozmowy, a zamkniecie
    # mikrofonu kosztowaloby wypowiedziane juz zdanie.
    PODZIEKOWANIA = ("dziękuję", "dziekuje", "dzięki", "dzieki", "dziękuję ci")

    @classmethod
    def _is_farewell(cls, message: str) -> bool:
        tekst = message.strip().lower().rstrip(".!?…").strip()
        if not tekst or len(tekst) > 40:
            return False
        if tekst in cls.PODZIEKOWANIA:
            return True
        return any(tekst == p or tekst.endswith(" " + p) or tekst.startswith(p + ",")
                   or tekst.startswith(p + " ") for p in cls.POZEGNANIA)

    # Odpowiedzi, ktorymi asystent przyznaje, ze nie zrozumial.
    #
    # Niezrozumienie znaczy, ze wsadem byl szum — a wtedy przedluzanie nasluchu
    # jest odwrotnoscia tego, co trzeba zrobic: podstawia mikrofon pod ten sam
    # halas, ktory wlasnie wyprodukowal niezrozumiala ture.
    NIEZROZUMIENIE = (
        "nie zrozumiałem", "nie rozumiem", "nie dosłyszałem", "nie usłyszałem",
        "nie zrozumiałam", "nie wiem, o co",
    )

    @classmethod
    def _przyznaje_niezrozumienie(cls, response: str) -> bool:
        tekst = (response or "").strip().lower()
        return any(f in tekst for f in cls.NIEZROZUMIENIE)

    # Ile razy z rzedu wolno przedluzyc nasluch w rozmowie BEZ wlasciciela,
    # dlatego ze asystent sam zadal pytanie.
    #
    # Zagadki (08.08): asystent pyta „co to?", a mikrofon zamyka sie w tej samej
    # chwili, wiec dziecko odpowiada w prozne powietrze i musi powtarzac slowo
    # budzace przed kazda odpowiedzia. Gra, ktora ma byc zabawa, staje sie
    # walka z urzadzeniem. Wladek i Tadek nie maja jeszcze odciskow glosu, wiec
    # kazda ich tura jest wlasnie taka rozmowa bez wlasciciela.
    #
    # Limit, a nie „bez konca", bo to jest ta sama petla, ktora zamykalismy
    # 07.08: odpowiedz otwiera mikrofon, halas go wypelnia, dostaje odpowiedz.
    # Drugi hamulec juz stoi i jest wazniejszy — `_przyznaje_niezrozumienie()`
    # konczy ture natychmiast, a szum produkuje wlasnie niezrozumienie. Zeby
    # dobic do tego limitu, halas musialby ZA KAZDYM RAZEM byc zrozumialy i za
    # kazdym razem sprowokowac pytanie zwrotne.
    #
    # 10, bo runda zagadek to realnie kilkanascie tur, a licznik zeruje sie przy
    # kazdej turze, po ktorej asystent NIE pyta — czyli przy zwyklej rozmowie
    # nigdy nie dochodzi nawet blisko.
    MAX_PYTAN_BEZ_WLASCICIELA = 10

    def _wznow_lub_nowa(
        self, mowca: str | None, is_voice: bool, urzadzenie: str | None
    ) -> str:
        """Id rozmowy: wznów przerwaną na tym urządzeniu albo załóż nową.

        Rozwiązuje konkretną przypadłość: mikrofon bywa zamykany za wcześnie
        (cisza w złym momencie kończy turę), a przy następnym wybudzeniu
        asystent zaczynał od zera i gubił wątek — w środku rundy zagadek to
        znaczyło, że nie pamiętał, o którą zagadkę toczy się gra.

        Wznowienie NIE wymaga rozpoznania głosu, bo wtedy zaskakiwałoby rzadko.
        Biometria działa tu jako WETO: odmawiamy tylko wtedy, gdy wiemy na
        pewno, że to KTOŚ INNY niż poprzednio.

        ⚠️ Zostaje więc jeden przypadek świadomie przepuszczany: nierozpoznany
        głos budzi satelitę tuż po czyjejś rozmowie i dostaje jej historię.
        Okno jest krótkie właśnie dlatego.
        """
        if not is_voice:
            return ulid.ulid_now()

        klucz = urzadzenie or "bez-urzadzenia"
        wpis = self._ostatnia_rozmowa.get(klucz)
        if wpis is None:
            return ulid.ulid_now()

        poprzednia, kiedy, poprzedni_mowca = wpis
        wiek = time.monotonic() - kiedy
        if wiek > OKNO_WZNOWIENIA_S:
            return ulid.ulid_now()

        # Weto biometryczne: obie strony rozpoznane i to dwie różne osoby.
        if poprzedni_mowca and mowca and poprzedni_mowca != mowca:
            _LOGGER.info(
                "Nie wznawiam rozmowy '%s': poprzednio mówił %s, teraz %s",
                poprzednia, poprzedni_mowca, mowca,
            )
            return ulid.ulid_now()

        _LOGGER.info(
            "Wznawiam rozmowę '%s' (przerwana %.0f s temu, mówca: %s)",
            poprzednia, wiek, mowca or "nierozpoznany",
        )
        return poprzednia

    def _po_podmianie(self, conversation_id: str) -> str:
        """Nasze id zamiast tego, ktore HA trzyma po przejetej sesji."""
        wpis = self._podmiana.get(conversation_id)
        if wpis is None:
            return conversation_id
        nowa, kiedy = wpis
        # Ta sama granica co przy wznawianiu: po niej rozmowa i tak jest nowa,
        # wiec podmiana nie ma juz czego pilnowac.
        if time.monotonic() - kiedy > OKNO_WZNOWIENIA_S:
            self._podmiana.pop(conversation_id, None)
            return conversation_id
        return nowa

    def _cisza_od_ostatniej_tury(
        self, urzadzenie: str | None, conversation_id: str
    ) -> float | None:
        """Ile minelo od ostatniej PRAWDZIWEJ wymiany w tej rozmowie.

        Zrodlem jest slad wznowienia (`_zapamietaj_rozmowe`), bo zapisuje sie po
        kazdej udanej turze i po nic innego nie trzeba siegac. `None` znaczy
        „nie wiem" (inne urzadzenie, inna rozmowa, restart HA) i wtedy NIE
        wygaszamy — brak danych nie jest dowodem na cisze.
        """
        wpis = self._ostatnia_rozmowa.get(urzadzenie or "bez-urzadzenia")
        if wpis is None:
            return None
        poprzednia, kiedy, _mowca = wpis
        if poprzednia != conversation_id:
            return None
        return time.monotonic() - kiedy

    def _przejmij_lub_wygas(
        self,
        conversation_id: str,
        mowca: str | None,
        is_voice: bool,
        urzadzenie: str | None,
    ) -> tuple[str, dict[str, Any]]:
        """Czy sesja wciaz nalezy do tego, kto ja otworzyl.

        SKAD SIE WZIELO (28.08). Wladek skonczyl rozmawiac 07:31:46. Lech
        odezwal sie 07:39:16, po nowym slowie budzacym, i trzy jego tury poszly
        w cisze: „Sesja nalezy do 'wladek', a tura przyszla od 'lech'". Cala
        reszta lancucha zadzialala — biometria rozpoznala go pewnie za kazdym
        razem (0,442 / 0,511 / 0,526 przy progu 0,35).

        🔑 Zlozyly sie dwie rzeczy. Po pierwsze, wpis w `_stan_rozmowy` NIE ZNIKA,
        gdy mikrofon zgasnie sam: kasujemy go tylko przy turze, ktora domyka
        nasluch, a rozmowa rozpoznanego wlasciciela mikrofon trzyma ZAWSZE
        (`_trzymaj_mikrofon`). Gdy taka rozmowa po prostu ucichnie, wlasciciel
        zostaje w slowniku na zawsze. Po drugie, HA potrafi po kilku minutach
        oddac ten sam `conversation_id` — `helpers/chat_session.py` sprzata
        timerem przezbrajanym co 5 min, wiec sesja zyje do ~10 minut, nie 5.

        ⛔ Weto biometryczne na te sytuacje juz mielismy — w `_wznow_lub_nowa`.
        Nie odpalilo ani razu, bo tamta funkcja jest wolana WYLACZNIE wtedy, gdy
        HA nie poda id (`user_input.conversation_id or ...`), a HA je podalo.
        Dlatego reguly nie powielamy w tamtym miejscu, tylko stawiamy ja tu — na
        drodze, ktora przechodzi KAZDA tura, niezaleznie od zrodla id.

        Dwie warstwy, w tej kolejnosci:

        1. PRZEJECIE. Pewnie rozpoznany ktos inny przejmuje sesje od razu. Nie
           „ignoruje w ciszy", bo o czlowieku przed mikrofonem wiemy wszystko,
           co da sie wiedziec — odmowa byla tu skutkiem ubocznym, nie decyzja.
        2. WYGASZENIE. Gdy nowego mowcy NIE rozpoznano pewnie, zostaje czas:
           po `OKNO_WZNOWIENIA_S` ciszy sesja przestaje nalezec do kogokolwiek.
           Ta warstwa jest slabsza z rozmyslem — sam uplyw czasu nie mowi, kto
           stoi przed mikrofonem.

        ⚠️ Czego to NIE rozluznia: telewizor w tle i drugi domownik W TRAKCIE
        rozmowy trafiaja na bramke wlasciciela dokladnie jak dotad. Chroniona
        jest ciagla rozmowa, a nie wybudzenie sprzed osmiu minut.
        """
        stan = self._stan_rozmowy.get(conversation_id, {"wlasciciel": None, "obce": 0})
        wlasciciel = stan["wlasciciel"]
        if not is_voice or wlasciciel is None:
            return conversation_id, stan

        if mowca is not None and mowca != wlasciciel:
            powod = f"pewnie rozpoznany '{mowca}' zamiast '{wlasciciel}'"
        else:
            wiek = self._cisza_od_ostatniej_tury(urzadzenie, conversation_id)
            if wiek is None or wiek <= OKNO_WZNOWIENIA_S:
                return conversation_id, stan
            powod = f"cisza {wiek:.0f} s ponad okno {OKNO_WZNOWIENIA_S:.0f} s"

        nowa = ulid.ulid_now()
        _LOGGER.info(
            "Sesja '%s' przestaje nalezec do '%s' (%s) — zakladam nowa '%s'",
            conversation_id, wlasciciel, powod, nowa,
        )
        self._stan_rozmowy.pop(conversation_id, None)
        # Sufit jak przy sladzie wznowienia: satelitow jest garsc, nie tysiace.
        if len(self._podmiana) > 32:
            self._podmiana.clear()
        self._podmiana[conversation_id] = (nowa, time.monotonic())
        return nowa, {"wlasciciel": None, "obce": 0}

    def _zapamietaj_rozmowe(
        self, urzadzenie: str | None, conversation_id: str, mowca: str | None
    ) -> None:
        """Ślad do wznowienia. Sufit, bo satelitów jest garść, a nie tysiące."""
        if not conversation_id:
            return
        if len(self._ostatnia_rozmowa) > 32:
            self._ostatnia_rozmowa.clear()
        self._ostatnia_rozmowa[urzadzenie or "bez-urzadzenia"] = (
            conversation_id, time.monotonic(), mowca,
        )

    def _zbadaj_zanieczyszczenie(
        self, speaker: str | None, podobienstwo: float | None
    ) -> bool:
        """Czy w tym nagraniu slychac kogos jeszcze poza mowca.

        SKAD SIE WZIELO. 14.08 Lech uslyszal w odpowiedziach slady cudzej mowy,
        mimo ze biometria rozpoznala JEGO w kazdej turze. Bramka obcych tur nie
        miala czego lapac, bo obcy glos nie przyszedl jako osobna tura — trafil
        do TEGO SAMEGO nagrania. Jedno nagranie to jeden embedding i jedna
        transkrypcja, wiec z punktu widzenia sesji tura naprawde jest Lecha.

        🔑 SYGNAL. ECAPA liczy jeden wektor na CALYM segmencie, wiec drugi glos
        rozmywa go i ciagnie wynik w dol. Zmierzone tego wieczora: tury czyste
        0,509-0,684, a tura z doklejonym „Ja na przyklad kupilem zart" — 0,384,
        czyli minimum sesji. Nie liczy sie wiec wartosc bezwzgledna (0,384 wciaz
        przechodzi prog 0,30 i ma przechodzic), tylko ZAPASC wobec tego, jak ta
        osoba wypada zwykle.

        ⚠️ Wykrywa PRZYPADKI MOCNE. Druga podejrzana tura tego wieczora (0,589
        przy sredniej 0,62) NIE zostanie zlapana i to jest swiadoma granica:
        czulszy prog zaczalby oznaczac zwykle wahania glosu.

        ⛔ NA RAZIE TYLKO OBSERWUJE — nie odrzuca tury i nie zmienia trasy.
        Odrzucanie na podstawie jednej liczby kasowaloby czasem prawdziwa
        wypowiedz, a to gorsze niz slad cudzego zdania w kontekscie. Najpierw
        zbierzmy, jak czesto to bije.
        """
        if speaker is None or podobienstwo is None:
            return False

        historia = self._podobienstwa_mowcy.setdefault(
            speaker, deque(maxlen=OKNO_PODOBIENSTW)
        )
        # Zanim uzbiera sie odniesienie, nie ma czego porownywac — a zgadywanie
        # na dwoch probkach dawaloby falszywe alarmy na poczatku kazdej sesji.
        if len(historia) < MIN_PROBEK_ODNIESIENIA:
            historia.append(podobienstwo)
            return False

        srednia = sum(historia) / len(historia)
        if podobienstwo < srednia * PROG_ZAPASCI:
            _LOGGER.warning(
                "Tura '%s' podejrzana o obcy głos W TYM SAMYM nagraniu: "
                "dopasowanie %.3f przy zwykłych %.3f (%.0f%% normy, próg %.0f%%). "
                "Treść wchodzi do rozmowy bez zmian — to na razie tylko sygnał.",
                speaker, podobienstwo, srednia,
                100 * podobienstwo / srednia, 100 * PROG_ZAPASCI,
            )
            # 🔑 Podejrzanej probki NIE dopisujemy do odniesienia. Wliczona
            # obnizalaby srednia, czyli kazde kolejne zanieczyszczenie byloby
            # trudniej wykryc — detektor sam by sie stepial.
            return True

        historia.append(podobienstwo)
        return False

    @staticmethod
    def _oddaje_glos(response: str) -> bool:
        """Czy asystent skonczyl pytaniem, czyli czeka na odpowiedz."""
        return (response or "").strip().rstrip("”\"')]").endswith("?")

    @classmethod
    def _trzymaj_mikrofon(
        cls, response: str, is_voice: bool, wlasciciel: str | None
    ) -> bool:
        """Czy po tej turze mikrofon ma zostac otwarty.

        Rozmowy pisane nie trzymaja niczego — nie ma mikrofonu do trzymania.

        „Jednorazowa flaga, wiec nie ma sie czemu wyrwac" — jak glosilo
        wczesniejsze uzasadnienie tej funkcji — jest prawda WYLACZNIE w cichym
        pokoju. Przy halasie kazde otwarcie zostaje wypelnione szumem, szum
        dostaje odpowiedz, a odpowiedz otwiera mikrofon nastepny raz;
        jednorazowosc sklada sie w petle, ktora sama sie karmi.

        Ale lekiem NIE jest limit tur, bo to kaleczy ciaglosc, czyli cala
        wartosc tej funkcji. Lekiem jest pytanie „czy to nadal mowi ten sam
        czlowiek". Odpowiada na nie sesja zamknieta na wlasciciela: dopoki tury
        przychodza od niego, mikrofon zostaje otwarty BEZ ZADNEGO LIMITU, a
        cudze sa odsiewane wczesniej i tu nigdy nie docieraja.

        Rozmowa BEZ wlasciciela to strzal pojedynczy — Z JEDNYM WYJATKIEM.
        Ciagla rozmowa bez tozsamosci to dokladnie ta petla, ktora juz raz
        zamykalismy: nie ma czego pilnowac, wiec nie ma czym zatrzymac pokoju,
        ktory gada dalej. Ale gdy asystent sam skonczyl PYTANIEM, zamkniecie
        mikrofonu jest po prostu bledem: zapytal i nie sluchal odpowiedzi.
        Wtedy trzymamy, licznikowo (`MAX_PYTAN_BEZ_WLASCICIELA`) — patrz zagadki.
        """
        if not (CONTINUE_CONVERSATION and is_voice and response):
            return False
        # Niezrozumienie znaczy, ze wsadem byl szum; nasluchiwanie go dalej
        # podstawia mikrofon pod ten sam halas.
        if cls._przyznaje_niezrozumienie(response):
            return False
        return wlasciciel is not None or cls._oddaje_glos(response)

    def _person_for_voiceprint(self, speaker: str) -> tuple[str, str] | None:
        """Find the household member a voiceprint belongs to.

        Voiceprints are named after the person's Home Assistant id, so this is
        an exact match rather than a name comparison — the enrolment panel and
        this lookup cannot drift apart over how to fold "Michał".
        """
        for state in self.hass.states.async_all("person"):
            if state.attributes.get("id") != speaker:
                continue
            name = state.attributes.get("friendly_name") or state.object_id
            return speaker, name
        return None

    def _profile_for_account(self, account_id: str) -> str:
        """Memory profile for a logged-in Home Assistant session.

        Sessions are keyed through the person, not by the account, so that a
        phone and a satellite reach the same memory. Keying on the account
        directly would split them apart the moment somebody's login is added
        or replaced — the person id survives both, and survives a rename too.
        """
        for state in self.hass.states.async_all("person"):
            if state.attributes.get("user_id") == account_id:
                return state.attributes.get("id") or account_id
        # An account with no person has nothing more stable to offer.
        return account_id

    @staticmethod
    def _split_speaker_tag(text: str) -> tuple[str, str | None, float | None]:
        """Rozbierz "[lech:0.874] zapal światło" na polecenie, mowce i podobienstwo.

        Zwraca tekst bez zmian i `None`, gdy znacznika nie ma — czyli w kazdej
        rozmowie pisanej i w kazdym poleceniu glosowym, ktorego mowcy nie
        rozpoznano.

        Podobienstwo jest opcjonalne po obu stronach: starszy mostek wysyla samo
        `[lech]`, i to ma dalej dzialac.
        """
        if not text:
            return text, None, None
        match = re.match(SPEAKER_TAG_PATTERN, text)
        if not match:
            return text, None, None
        podobienstwo = None
        if match.group(2):
            try:
                podobienstwo = float(match.group(2))
            except ValueError:
                # Znacznik jest tylko wskazowka; jego uszkodzenie nie moze
                # kosztowac polecenia, ktore czlowiek wlasnie wypowiedzial.
                podobienstwo = None
        return text[match.end():], match.group(1), podobienstwo

    async def _resolve_user_name(self, user_id: str) -> str | None:
        """Name of the Home Assistant user behind this request, if there is one.

        Lets the assistant greet whoever is speaking instead of addressing the
        house. Requests without a user — automations, scripts, a shared device —
        stay nameless on purpose: the server is told to treat those as the shared
        profile rather than assume a person.
        """
        try:
            user = await self.hass.auth.async_get_user(user_id)
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.debug("Could not resolve user %s: %s", user_id, err)
            return None
        if user is None or user.system_generated:
            return None
        return user.name or None

    def _exposed_entities(self) -> list[str] | None:
        """Entity IDs the user exposed to Assist in HA. None = could not determine."""
        try:
            return [
                state.entity_id
                for state in self.hass.states.async_all()
                if async_should_expose(self.hass, "conversation", state.entity_id)
            ]
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.debug("Could not compute exposed entities: %s", err)
            return None

    async def _call_api(
        self,
        message: str,
        user_id: str,
        conversation_id: str,
        is_voice: bool = False,
        user_name: str | None = None,
        identity_confidence: str = "certain",
    ) -> tuple[str, list[str]]:
        """Call the Home Mind API. Zwraca odpowiedz i liste uzytych narzedzi.

        Narzedzia sa potrzebne, zeby odroznic ture, w ktorej cos sie w domu
        wydarzylo, od samej wymiany zdan — na tym opiera sie licznik tur
        jalowych, ktory zamyka mikrofon.
        """
        url = f"{self._api_url}{API_CHAT_ENDPOINT}"
        payload = self._zbuduj_payload(
            message, user_id, conversation_id, is_voice, user_name, identity_confidence
        )
        headers = self._naglowki_api()

        _LOGGER.debug("Calling Home Mind API: %s with payload: %s", url, payload)

        async with self._session.post(
            url,
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise Exception(f"API error {response.status}: {error_text}")

            data = await response.json()
            tools = data.get("toolsUsed") or []
            return (
                data.get("response") or "I received your request but got no response.",
                list(tools),
            )

    def _naglowki_api(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_token}"} if self._api_token else {}

    def _zbuduj_payload(
        self,
        message: str,
        user_id: str,
        conversation_id: str,
        is_voice: bool = False,
        user_name: str | None = None,
        identity_confidence: str = "certain",
    ) -> dict:
        """Ciało żądania — wspólne dla drogi zwykłej i strumieniowej.

        Wydzielone, żeby te dwie drogi nie mogły się rozjechać. Gdyby każda
        budowała payload po swojemu, opcja dodana w jednym miejscu (limit
        pamięci, tryb wyszukiwania) działałaby tylko przy jednym z trybów —
        i to zależnie od tego, czy akurat gra strumień.
        """
        payload = {
            "message": message,
            "userId": user_id,
            "conversationId": conversation_id,
            "isVoice": is_voice,
        }

        if user_name:
            payload["userName"] = user_name

        # A logged-in Home Assistant session is proof of who is asking. A
        # voiceprint is strong evidence rather than proof — the server trusts
        # both with personal memory and with the restricted devices, but saying
        # which one this was keeps the distinction visible if that ever needs to
        # change.
        #
        # The caller decides; this is never inferred from the presence of a
        # name. It used to be, and a logged-in session whose display name failed
        # to resolve would have been demoted to a stranger — refused the vacuum
        # by its own owner. "unknown" is still said out loud rather than left
        # out, because the server reads a missing value as "certain".
        payload["identityConfidence"] = identity_confidence

        exposed = self._exposed_entities()
        if exposed is not None:
            payload["exposedEntities"] = exposed

        custom_prompt = self.entry.options.get(CONF_CUSTOM_PROMPT)
        if custom_prompt:
            payload["customPrompt"] = custom_prompt

        payload["webSearchLimit"] = int(
            self.entry.options.get(CONF_WEB_SEARCH_LIMIT, DEFAULT_WEB_SEARCH_LIMIT)
        )
        payload["memoryTokenLimit"] = int(
            self.entry.options.get(
                CONF_MEMORY_TOKEN_LIMIT, DEFAULT_MEMORY_TOKEN_LIMIT
            )
        )
        # Only send the search mode once the user has actually chosen one, so
        # an untouched install keeps whatever the server is configured with.
        if search_mode := self.entry.options.get(CONF_WEB_SEARCH_MODE):
            payload["webSearchMode"] = search_mode

        return payload

    async def _call_api_stream(
        self,
        chat_log: ChatLog,
        message: str,
        user_id: str,
        conversation_id: str,
        is_voice: bool = False,
        user_name: str | None = None,
        identity_confidence: str = "certain",
    ) -> tuple[str, list[str]]:
        """To samo co `_call_api`, ale kawałkami — żeby TTS ruszył wcześniej.

        🔑 PO CO. Odpowiedź rozmowna powstaje w kilka sekund, ale pierwsze
        słowa są gotowe po ~2 s. Wpychając je do `chat_log` w miarę, jak
        przychodzą, pozwalamy potokowi Assist zacząć mówić, zanim model
        skończy — potok sam pilnuje, żeby nie wypowiedzieć całości drugi raz
        (`_streamed_response_text` w `pipeline.py`).

        ⚠️ Delty trzeba wpychać przez `chat_log`, a NIE zwracać samemu tekstem:
        potok nasłuchuje na `chat_log.delta_listener`, który sam podpiął przy
        otwieraniu dziennika. Zwrócony tekst obsługuje dopiero koniec tury.
        """
        url = f"{self._api_url}{API_CHAT_STREAM_ENDPOINT}"
        payload = self._zbuduj_payload(
            message, user_id, conversation_id, is_voice, user_name, identity_confidence
        )
        zebrane: list[str] = []
        narzedzia: list[str] = []
        calosc_z_konca: str | None = None

        async def kawalki():
            """Zamienia SSE serwera na delty, których oczekuje `chat_log`."""
            nonlocal calosc_z_konca
            yield {"role": "assistant"}
            async with self._session.post(
                url,
                json=payload,
                headers=self._naglowki_api(),
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as response:
                if response.status != 200:
                    tresc = await response.text()
                    raise Exception(f"API error {response.status}: {tresc}")
                zdarzenie = ""
                async for surowa in response.content:
                    linia = surowa.decode("utf-8").rstrip("\r\n")
                    if linia.startswith("event:"):
                        zdarzenie = linia[6:].strip()
                    elif linia.startswith("data:"):
                        try:
                            dane = json.loads(linia[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        if zdarzenie == "chunk":
                            tekst = dane.get("text") or ""
                            if tekst:
                                zebrane.append(tekst)
                                yield {"content": tekst}
                        elif zdarzenie == "done":
                            narzedzia.extend(dane.get("toolsUsed") or [])
                            calosc_z_konca = dane.get("response")
                        elif zdarzenie == "error":
                            raise Exception(f"API stream error: {dane}")

        async for _ in chat_log.async_add_delta_content_stream(self.entity_id, kawalki()):
            pass

        # `done` niesie pełną odpowiedź i jest źródłem prawdy; sklejone kawałki
        # są zapasem na wypadek, gdyby to zdarzenie nie doszło.
        tekst = (calosc_z_konca or "".join(zebrane)).strip()
        return (tekst or "I received your request but got no response.", narzedzia)
