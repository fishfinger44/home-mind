"""Home Mind integration for Home Assistant."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN, KLUCZ_KOORDYNATORA

if TYPE_CHECKING:
    from homeassistant.helpers.typing import ConfigType

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.CONVERSATION,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
]

# Ile sekund CISZY konczy ture — i wylacznie ciszy.
#
# Home Assistant ma tu na sztywno 15 s (`assist_pipeline/vad.py`:
# `VoiceCommandSegmenter.timeout_seconds`) i NIE wystawia tego w zadnym
# ustawieniu — `pipeline.py` przekazuje do segmentera wylacznie `silence_seconds`
# (to jest suwak „wykrywanie zakonczenia mowienia"), a `timeout_seconds` zostaje
# na domyslnej wartosci klasy.
#
# UWAGA na pulapke, na ktora nadzialismy sie 08.08: `timeout_seconds` to NIE jest
# „ile czekamy, az czlowiek zacznie mowic". W `process()` licznik leci
# BEZWARUNKOWO na kazdej porcji audio, jeszcze zanim kod sprawdzi, czy to mowa, i
# nigdy nie jest dolewany, gdy mowa sie zacznie. To twardy sufit na CALA ture,
# liczony od otwarcia mikrofonu. Samo zbicie go z 15 s na 8 s (nasza wersja z
# 08.08 01:15) zaczelo wiec ucinac dluzsze pytania w pol slowa i wysylac do ASR
# urwany fragment: w nagraniach z tego dnia widac 3 z 48 wypowiedzi o dlugosci
# DOKLADNIE 8,0000 s (128000 ramek), m.in. „…czy jest ryzyko, ze dziecko zje".
# Wczesniej ten sam sufit widac bylo na 15,0000 s (240000 ramek).
#
# Dlatego liczymy inaczej: budzet drenuje sie tylko w ciszy, a kazda porcja z
# mowa dolewa go do pelna. Pusty pokoj dalej odpada po 8 s, ale dlugie zdanie nie
# ma jak zostac przerwane — ture konczy detektor ciszy (`silence_seconds`, suwak
# „wykrywanie zakonczenia mowienia"), czyli 0,7 s po tym, jak czlowiek skonczy.
#
# 8 s, nie 5 s, bo przy ciaglej rozmowie czekamy takze na to, az czlowiek
# sformuluje mysl, a nie tylko na to, czy w ogole cos powie.
OKNO_CISZY_S = 8.0

# Bezwzgledny sufit na ture, na wypadek zrodla, ktore mowi bez przerwy (telewizor,
# radio) — bez niego mikrofon zostawalby otwarty dowolnie dlugo, bo budzet ciszy
# nigdy by sie nie drenowal. Czlowiek tu nie siegnie: zeby dobic do 15 s, trzeba
# mowic bez ANI JEDNEJ przerwy dluzszej niz 0,7 s.
#
# To NIE jest obrona przed telewizorem — te trzyma bramka wlasciciela sesji w
# `conversation.py` (cudza tura leci do kosza bez modelu i bez akcji, a po
# `MAX_TUR_OBCYCH` nasluch sie zamyka). Sufit pilnuje czego innego: KREDYTOW
# ElevenLabs. Obca tura jest odrzucana dopiero PO transkrypcji, wiec gadajacy
# telewizor kosztuje `MAX_TUR_OBCYCH` x sufit sekund ASR na sesje.
#
# 15 s, bo tyle wynosilo stare okno VAD i na tej liczbie opiera sie rachunek
# „trzy tury to najwyzej ~45 s" w `conversation.py`. Gorna granica i tak jest
# 30 s: `wyoming-voice-match` czeka na AudioStop najwyzej tyle (`handler.py`) i
# potem transkrybuje to, co ma, mimo trwajacego strumienia — sufit musi wypasc
# przed tym momentem, zeby o koncu tury decydowal potok HA, a nie wyscig dwoch
# niezaleznych zegarow.
SUFIT_TURY_S = 15.0

# Podbijac przy kazdej zmianie SEMANTYKI patcha (nie przy samej zmianie liczb).
_WERSJA_PATCHA = 2


def _przestaw_licznik_okna_nasluchu() -> None:
    """Niech licznik konca tury tyka tylko w ciszy, nie w trakcie mowienia.

    Robione podmiana klasy w przestrzeni nazw `pipeline`, a nie ustawieniem pola
    na klasie: `VoiceCommandSegmenter` jest dataclass'a, wiec domyslna wartosc
    jest juz wpieczona w sygnature wygenerowanego `__init__` i przypisanie do
    atrybutu klasy NIE zmienia tego, co dostana nowe instancje.

    Zmiana jest GLOBALNA — dotyczy kazdego potoku Assist w tym Home Assistancie,
    takze gry Wladka. To jest zamierzone: ucinanie ludzi w pol slowa jest zle
    wszedzie.

    Jesli Home Assistant przebuduje te czesc potoku, patch ma zawiesc GLOSNO i
    zostawic dzialajacy system, a nie po cichu przestac dzialac.
    """
    try:
        import dataclasses

        from homeassistant.components.assist_pipeline import pipeline as _pipeline
        from homeassistant.components.assist_pipeline.vad import VoiceCommandSegmenter

        @dataclasses.dataclass
        class _LicznikTylkoWCiszy(VoiceCommandSegmenter):
            timeout_seconds: float = OKNO_CISZY_S
            sufit_tury_seconds: float = SUFIT_TURY_S
            _sufit_seconds_left: float = 0.0

            def reset(self) -> None:
                """Zeruj liczniki bazy i nasz sufit tury."""
                super().reset()
                self._sufit_seconds_left = self.sufit_tury_seconds

            def process(
                self, chunk_seconds: float, speech_probability: float | None
            ) -> bool:
                """Zwroc False, gdy tura ma sie skonczyc."""
                self._sufit_seconds_left -= chunk_seconds
                if self._sufit_seconds_left <= 0:
                    _LOGGER.debug(
                        "Tura ucieta sufitem %.0f s — cos mowi bez przerwy",
                        self.sufit_tury_seconds,
                    )
                    self.reset()
                    self.timed_out = True
                    return False

                # Budzet dolewa TYLKO trwajaca wypowiedz (`in_command`), nie kazdy
                # dzwiek powyzej progu. Dolewanie na samym `speech_probability`
                # bylo pierwszym podejsciem i POMIAR je obalil: kaszlniecie 0,2 s
                # co 3 s w pustym pokoju odnawialo budzet w kolko i trzymalo
                # mikrofon otwarty do sufitu 25 s zamiast 8 s. `in_command` robi
                # sie prawda dopiero po `speech_seconds` (0,3 s) ciaglej mowy,
                # wiec pojedyncze stukniecia go nie zapalaja.
                #
                # Prog bierzemy ten sam, ktorym za chwile posluzy sie baza, zeby
                # nie dolac budzetu na dzwieku, ktory baza uzna juz za cisze.
                if self.in_command and (speech_probability or 0.0) > self.in_command_speech_threshold:
                    # `super().process()` odejmie zaraz `chunk_seconds`, wiec
                    # dokladamy je z gory — inaczej dluga wypowiedz i tak
                    # sczerpywalaby budzet po kropli.
                    self._timeout_seconds_left = self.timeout_seconds + chunk_seconds

                return super().process(chunk_seconds, speech_probability)

        # Znacznik wersji zamiast porownywania `timeout_seconds`: wartosc zostala
        # ta sama (8 s), zmienilo sie ZNACZENIE licznika, wiec porownanie po
        # liczbie uznaloby stary patch za aktualny i nowego by nie nalozylo.
        # Po tozsamosci klasy tez nie: `_LicznikTylkoWCiszy` powstaje na nowo przy
        # kazdym wywolaniu, wiec `is` nigdy by nie wyszlo i patch nakladalby sie
        # na samego siebie, dokladajac klase do lancucha dziedziczenia.
        _LicznikTylkoWCiszy._home_mind_patch = _WERSJA_PATCHA  # noqa: SLF001

        if getattr(_pipeline.VoiceCommandSegmenter, "_home_mind_patch", 0) >= _WERSJA_PATCHA:
            return
        _pipeline.VoiceCommandSegmenter = _LicznikTylkoWCiszy
        _LOGGER.info(
            "Okno nasłuchu: %.0f s CISZY kończy turę (licznik nie tyka w trakcie "
            "mówienia), bezwzględny sufit tury %.0f s",
            OKNO_CISZY_S,
            SUFIT_TURY_S,
        )
    except Exception:  # pylint: disable=broad-except
        _LOGGER.warning(
            "Nie udało się przestawić okna nasłuchu — Home Assistant zmienił "
            "assist_pipeline. Mikrofon zostaje na domyślnych 15 s, które UCINAJĄ "
            "wypowiedź w pół słowa",
            exc_info=True,
        )


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Home Mind component."""
    hass.data.setdefault(DOMAIN, {})
    _przestaw_licznik_okna_nasluchu()
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
        # Koordynator sciezki rozmownej jest wspolny dla switcha i selectow,
        # wiec nie nalezy do zadnej platformy z osobna i musi zniknac tutaj.
        # Zostawiony trzymalby sesje i odpytywal serwer po przeladowaniu wpisu.
        hass.data[DOMAIN].get(KLUCZ_KOORDYNATORA, {}).pop(entry.entry_id, None)

    return unload_ok
