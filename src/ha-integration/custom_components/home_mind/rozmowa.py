"""Wspolny koordynator sciezki rozmownej — dla przelacznika i list wyboru.

Po co osobny modul: przelacznik (`switch.py`) i wybor modelu/wysilku
(`select.py`) czytaja DOKLADNIE ten sam endpoint `/api/config/rozmowa`. Gdyby
kazda platforma zakladala wlasny koordynator, ten sam stan bylby odpytywany
trzy razy i — co gorsza — trzy encje pokazywalyby chwilami rozne wersje tego
samego ustawienia, bo ich cykle odswiezania sie rozjezdzaja.

🔑 Jeden koordynator na wpis konfiguracyjny, trzymany w `hass.data`. Kto
pierwszy go potrzebuje, ten go zaklada.
"""

from __future__ import annotations

from datetime import timedelta
import logging

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    API_CONFIG_ROZMOWA_ENDPOINT,
    CONF_API_TOKEN,
    CONF_API_URL,
    DOMAIN,
    KLUCZ_KOORDYNATORA,
)

_LOGGER = logging.getLogger(__name__)

# Ustawienie zmienia sie tylko wtedy, gdy ktos je przelaczy — czesciej pytac
# nie ma po co. Po wlasnym przelaczeniu i tak odswiezamy od razu.
SCAN_INTERVAL = timedelta(minutes=10)
REQUEST_TIMEOUT = 10


class RozmowaCoordinator(DataUpdateCoordinator[dict]):
    """Odpytuje GET /api/config/rozmowa i podaje stan encjom.

    Zwracany slownik: `dostepna`, `wlaczona`, `model`, `effort`, `modele`
    (lista `{id, nazwa, effort}`) i `wysilki`.
    """

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="Home Mind rozmowa",
            update_interval=SCAN_INTERVAL,
        )
        self._url = f"{entry.data[CONF_API_URL].rstrip('/')}{API_CONFIG_ROZMOWA_ENDPOINT}"
        self._token = entry.data.get(CONF_API_TOKEN, "").strip() or None
        self._session = async_get_clientsession(hass)

    def _naglowki(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    async def _async_update_data(self) -> dict:
        try:
            async with self._session.get(
                self._url,
                headers=self._naglowki(),
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as response:
                if response.status != 200:
                    # Serwer starszy niz ta integracja nie zna tego endpointu.
                    raise UpdateFailed(f"/config/rozmowa zwrocilo {response.status}")
                return await response.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Home Mind nieosiagalny: {err}") from err

    async def ustaw(self, **pola) -> None:
        """Wysyla WYBRANE pola i od razu odswieza.

        ⚠️ Wysylamy tylko to, co sie zmienia (`wlaczona`, `model` albo
        `effort`) — serwer traktuje brak pola jako "nie ruszaj". Odsylanie
        calosci znaczyloby, ze przelaczenie wlacznika zapisuje przy okazji
        model odczytany chwile wczesniej, a to cicho cofaloby zmiane zrobiona
        w miedzyczasie skadinad.
        """
        async with self._session.post(
            self._url,
            headers={**self._naglowki(), "Content-Type": "application/json"},
            json=pola,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as response:
            if response.status != 200:
                tresc = await response.text()
                raise RuntimeError(f"HTTP {response.status}: {tresc[:200]}")
        await self.async_request_refresh()


async def pobierz_koordynator(
    hass: HomeAssistant, entry: ConfigEntry
) -> RozmowaCoordinator:
    """Zwraca koordynator wpisu — zakladajac go przy pierwszym wywolaniu."""
    schowek = hass.data.setdefault(DOMAIN, {}).setdefault(KLUCZ_KOORDYNATORA, {})
    koordynator = schowek.get(entry.entry_id)
    if koordynator is None:
        koordynator = RozmowaCoordinator(hass, entry)
        schowek[entry.entry_id] = koordynator
        # Swiadomie NIE async_config_entry_first_refresh(): ono rzuca
        # ConfigEntryNotReady, co pociagneloby za soba agenta konwersacji,
        # gdyby serwer byl chwilowo nieosiagalny albo za stary. Ustawienia sa
        # warte mniej niz asystent — niech startuja jako niedostepne i wroca
        # przy nastepnym odpytaniu. (Ta sama zasada co przy czujnikach
        # wyszukiwania.)
        await koordynator.async_refresh()
    return koordynator
