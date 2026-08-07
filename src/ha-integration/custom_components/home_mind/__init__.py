"""Home Mind integration for Home Assistant."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN

if TYPE_CHECKING:
    from homeassistant.helpers.typing import ConfigType

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.CONVERSATION, Platform.SENSOR]

# Ile sekund mikrofon czeka na mowe, zanim tura sie podda.
#
# Home Assistant ma tu na sztywno 15 s (`assist_pipeline/vad.py`:
# `VoiceCommandSegmenter.timeout_seconds`) i NIE wystawia tego w zadnym
# ustawieniu — `pipeline.py` przekazuje do segmentera wylacznie `silence_seconds`
# (to jest suwak „wykrywanie zakonczenia mowienia"), a `timeout_seconds` zostaje
# na domyslnej wartosci klasy.
#
# 15 s to dwa do trzech razy wiecej niz u komercyjnych asystentow, ktorzy zbiegli
# sie na tym przedziale niezaleznie od siebie: Google Continued Conversation
# slucha 8 s, Alexa Follow-Up 5 s. Kazda sekunda otwartego mikrofonu to sekunda,
# w ktorej pokoj moze wejsc w ture — a w logach mostka widac wprost nagrania
# „Cisza (14.5s)" i „(15.0s)", czyli okno regularnie dobiega do konca.
#
# 8 s, nie 5 s, bo przy ciaglej rozmowie czekamy takze na to, az czlowiek
# sformuluje mysl, a nie tylko na to, czy w ogole cos powie.
OKNO_NASLUCHU_S = 8.0


def _skroc_okno_nasluchu() -> None:
    """Skroc okno oczekiwania na mowe z 15 s do OKNO_NASLUCHU_S.

    Robione podmiana klasy w przestrzeni nazw `pipeline`, a nie ustawieniem pola
    na klasie: `VoiceCommandSegmenter` jest dataclass'a, wiec domyslna wartosc
    jest juz wpieczona w sygnature wygenerowanego `__init__` i przypisanie do
    atrybutu klasy NIE zmienia tego, co dostana nowe instancje.

    Zmiana jest GLOBALNA — dotyczy kazdego potoku Assist w tym Home Assistancie,
    takze gry Wladka. To jest zamierzone: 15 s jest za duzo wszedzie.

    Jesli Home Assistant przebuduje te czesc potoku, patch ma zawiesc GLOSNO i
    zostawic dzialajacy system, a nie po cichu przestac dzialac.
    """
    try:
        import dataclasses

        from homeassistant.components.assist_pipeline import pipeline as _pipeline
        from homeassistant.components.assist_pipeline.vad import VoiceCommandSegmenter

        @dataclasses.dataclass
        class _KrotszeOkno(VoiceCommandSegmenter):
            timeout_seconds: float = OKNO_NASLUCHU_S

        # Idempotencja po WARTOSCI, nie po tozsamosci klasy: `_KrotszeOkno`
        # powstaje na nowo przy kazdym wywolaniu, wiec porownanie `is` nigdy by
        # nie wyszlo i przy przeladowaniu integracji patch nakladalby sie na
        # samego siebie, dokladajac klase do lancucha dziedziczenia.
        if getattr(_pipeline.VoiceCommandSegmenter, "timeout_seconds", None) == OKNO_NASLUCHU_S:
            return
        _pipeline.VoiceCommandSegmenter = _KrotszeOkno
        _LOGGER.info(
            "Okno nasłuchu skrócone z %.0f s do %.0f s",
            VoiceCommandSegmenter.timeout_seconds,
            OKNO_NASLUCHU_S,
        )
    except Exception:  # pylint: disable=broad-except
        _LOGGER.warning(
            "Nie udało się skrócić okna nasłuchu — Home Assistant zmienił "
            "assist_pipeline. Mikrofon zostaje na domyślnych 15 s",
            exc_info=True,
        )


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Home Mind component."""
    hass.data.setdefault(DOMAIN, {})
    _skroc_okno_nasluchu()
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Home Mind from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry.data

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info("Home Mind integration loaded")
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the config entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id)

    return unload_ok
