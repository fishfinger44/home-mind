"""Conversation agent for Home Mind."""

from __future__ import annotations

import logging
import re
from dataclasses import replace
from typing import Literal

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

        # Determine if this is a voice request
        is_voice = user_input.agent_id is not None

        # Generate conversation ID if not provided
        conversation_id = user_input.conversation_id or ulid.ulid_now()

        # Local-first: try Home Assistant's built-in agent (0 tokens, no LLM).
        # Only when it can actually act on the command do we return its result;
        # anything it can't match/handle falls through to the Home Mind server.
        if self.entry.options.get(CONF_PREFER_LOCAL):
            local_result = await self._try_local(user_input)
            if local_result is not None:
                return local_result

        try:
            response_text = await self._call_api(
                message=message,
                user_id=user_id,
                conversation_id=conversation_id,
                is_voice=is_voice,
                user_name=user_name,
                identity_confidence=identity_confidence,
            )
            _LOGGER.debug(
                "Got response: %s", response_text[:100] if response_text else "None"
            )

            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_speech(response_text)

            return ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
                continue_conversation=self._expects_an_answer(response_text, is_voice),
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
            if CONTINUE_CONVERSATION and user_input.agent_id is not None:
                result = replace(result, continue_conversation=True)
            return result

        # no_intent_match / no_valid_targets / error → let Home Mind (LLM) try.
        _LOGGER.debug(
            "Local agent could not handle it (%s) — falling back to Home Mind",
            response_type,
        )
        return None

    @staticmethod
    def _expects_an_answer(response: str, is_voice: bool) -> bool:
        """Whether to keep the microphone open after this turn.

        Every spoken turn keeps it open. Home Assistant reopens the microphone
        once and the satellite closes it again when nobody speaks, so this is a
        single-shot flag rather than a mode — there is nothing to run away
        with, unlike an earlier automation that reopened the microphone after
        playback and held two whole conversations with itself in nine seconds.

        Keeping it open only for questions was the cautious reading, and it
        was the wrong one: most turns are commands answered with a statement,
        so the wake word was still needed for every single one, which is the
        thing continuous conversation exists to remove.

        Text conversations keep nothing open — there is no microphone to hold.
        """
        return bool(CONTINUE_CONVERSATION and is_voice and response)

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
    ) -> str:
        """Call the Home Mind API."""
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
            # voiceprint is strong evidence rather than proof — the server
            # trusts both with personal memory, but saying which one this was
            # keeps the distinction visible if that ever needs to change.
            payload["identityConfidence"] = identity_confidence
        else:
            # Say "unknown" rather than leaving the field out. The server reads a
            # missing value as "certain" for compatibility with clients that
            # predate the field, so silence here would quietly grant a voice
            # satellite — which carries no user at all — the same trust as a
            # logged-in session, and file whatever it heard as somebody's
            # personal memory.
            payload["identityConfidence"] = "unknown"

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
            return data.get("response") or "I received your request but got no response."
