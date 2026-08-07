"""Conversation agent for Home Mind."""

from __future__ import annotations

import logging
import re
from dataclasses import replace
from typing import Any, Literal

import aiohttp

from homeassistant.components import conversation as ha_conversation
from homeassistant.components.conversation import (
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

# Rozmowe zaczal ktos rozpoznany, a teraz kolejne tury nie naleza do nikogo
# znanego — czyli albo odszedl, albo mikrofon nagrywa pokoj.
#
# Prog 2, nie 1, bo weryfikacja mowcy jest zawodna przy BARDZO KROTKICH
# wypowiedziach („tak", „nie", „jeszcze jeden") — to byla diagnoza tamtego
# wyniku 0,556. Jedno chybienie wolno; dwa pod rzad to juz nie przypadek.
MAX_TUR_BEZ_ROZPOZNANIA = 2

# Rozmowy, w ktorej NIKT nigdy nie zostal rozpoznany (gosc, albo voice-match
# nie ma odcisku), nie da sie pilnowac tozsamoscia — nie ma czego porownywac.
# Zostaje slabszy sygnal: tury, w ktorych nic sie w domu nie wydarzylo. Nie
# dotyczy rozmow z rozpoznanym mowca, wiec nie kaleczy ciaglosci.
MAX_TUR_BEZ_DZIALANIA = 2


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

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the agent."""
        self.hass = hass
        self.entry = entry
        self._api_url = entry.data[CONF_API_URL].rstrip("/")
        self._api_token = entry.data.get(CONF_API_TOKEN, "").strip() or None
        self._default_user_id = entry.data.get(CONF_USER_ID, DEFAULT_USER_ID)
        self._session = async_get_clientsession(hass)
        # Stan ciaglej rozmowy, per conversation_id: ile tur z rzedu bez
        # rozpoznanego mowcy, ile bez zadnego dzialania, i czy ktokolwiek w tej
        # rozmowie zostal kiedykolwiek rozpoznany. Slownik, a nie pojedyncze
        # liczniki, bo rozmowa pisana moze trwac obok glosowej; wpis znika, gdy
        # tura sie domyka, wiec nie rosnie w nieskonczonosc.
        self._stan_rozmowy: dict[str, dict[str, Any]] = {}

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

    async def async_process(self, user_input: ConversationInput) -> ConversationResult:
        """Process a conversation input and return a response."""
        _LOGGER.debug("Processing conversation input: %s", user_input.text)

        # A speaker tag from voice-match has to come off before anything reads
        # the text: the built-in agent below would fail to match "[lech] zapal
        # światło" against any intent, and the model should never see it either.
        message, speaker = self._split_speaker_tag(user_input.text)
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

        # Determine if this is a voice request
        is_voice = user_input.agent_id is not None

        # Generate conversation ID if not provided
        conversation_id = user_input.conversation_id or ulid.ulid_now()

        # Local-first: try Home Assistant's built-in agent (0 tokens, no LLM).
        # Only when it can actually act on the command do we return its result;
        # anything it can't match/handle falls through to the Home Mind server.
        #
        # An unrecognised voice never takes this shortcut. The built-in agent
        # understands "otwórz rolety" and "odkurz kuchnię" perfectly well and
        # would act on them without ever reaching the server, where the rules
        # about who may start what actually live — the saving is not worth a
        # door left open behind the lock.
        if self.entry.options.get(CONF_PREFER_LOCAL) and rozpoznany:
            local_result = await self._try_local(user_input)
            if local_result is not None:
                return local_result

        try:
            response_text, tools_used = await self._call_api(
                message=message,
                user_id=user_id,
                conversation_id=conversation_id,
                is_voice=is_voice,
                user_name=user_name,
                identity_confidence=identity_confidence if rozpoznany else "unknown",
            )
            _LOGGER.debug(
                "Got response: %s", response_text[:100] if response_text else "None"
            )

            # Rozpoznany mowca zeruje wszystko: rozmowa moze trwac dowolnie
            # dlugo, a to, ze pare tur temu ktos byl nierozpoznany, przestaje
            # miec znaczenie, skoro znowu slychac czlowieka.
            stan = self._stan_rozmowy.get(
                conversation_id, {"bez_rozpoznania": 0, "jalowe": 0, "znany": False}
            )
            if rozpoznany:
                stan = {"bez_rozpoznania": 0, "jalowe": 0, "znany": True}
            else:
                stan = {
                    "bez_rozpoznania": stan["bez_rozpoznania"] + 1,
                    "jalowe": 0 if tools_used else stan["jalowe"] + 1,
                    "znany": stan["znany"],
                }

            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech(response_text)

            trzymaj = self._trzymaj_mikrofon(
                response_text, is_voice, rozpoznany, stan
            ) and not self._is_farewell(message)

            if trzymaj:
                self._stan_rozmowy[conversation_id] = stan
            else:
                # Tura sie domyka — nie ma czego pamietac, a slownik ma nie rosnac.
                self._stan_rozmowy.pop(conversation_id, None)
                if not rozpoznany and stan["znany"]:
                    _LOGGER.debug(
                        "%d tury bez rozpoznanego mowcy — zamykam nasluch",
                        stan["bez_rozpoznania"],
                    )

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
        self, user_input: ConversationInput
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
                and not self._is_farewell(user_input.text)
            ):
                result = replace(result, continue_conversation=True)
                # Tu sie trafia wylacznie z rozpoznanym mowca (warunek przy
                # wywolaniu) i wylacznie gdy agent WYKONAL akcje albo odpowiedzial
                # na pytanie o dane. Obie rzeczy zeruja stan tak samo jak tura
                # obsluzona na serwerze — bez tego lancuch „zapal, zgas, otworz"
                # niosl by ze soba liczniki sprzed niego.
                if result.conversation_id:
                    self._stan_rozmowy[result.conversation_id] = {
                        "bez_rozpoznania": 0, "jalowe": 0, "znany": True,
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

    @classmethod
    def _trzymaj_mikrofon(
        cls, response: str, is_voice: bool, rozpoznany: bool, stan: dict[str, Any]
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
        czlowiek": dopoki voice-match kogos rozpoznaje, mikrofon zostaje
        otwarty BEZ ZADNEGO LIMITU. Progi wchodza dopiero wtedy, gdy tozsamosc
        znika — i sa inne w zaleznosci od tego, czy bylo co tracic.
        """
        if not (CONTINUE_CONVERSATION and is_voice and response):
            return False
        # Niezrozumienie znaczy, ze wsadem byl szum; nasluchiwanie go dalej
        # podstawia mikrofon pod ten sam halas.
        if cls._przyznaje_niezrozumienie(response):
            return False
        if rozpoznany:
            return True
        if stan["znany"]:
            # Rozmowe zaczal ktos rozpoznany, a teraz nie wiadomo, kto mowi.
            return stan["bez_rozpoznania"] < MAX_TUR_BEZ_ROZPOZNANIA
        # Nikt w tej rozmowie nigdy nie zostal rozpoznany — tozsamosc nie jest
        # dostepna jako sygnal, wiec zostaje slabszy: brak dzialan.
        return stan["jalowe"] < MAX_TUR_BEZ_DZIALANIA

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
    def _split_speaker_tag(text: str) -> tuple[str, str | None]:
        """Split "[lech] zapal światło" into the command and the speaker.

        Returns the text unchanged with `None` when there is no tag, which is
        every text conversation and every voice command whose speaker was not
        recognised.
        """
        if not text:
            return text, None
        match = re.match(SPEAKER_TAG_PATTERN, text)
        if not match:
            return text, None
        return text[match.end():], match.group(1)

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

        headers = {}
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"

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
