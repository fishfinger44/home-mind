"""Przelacznik sciezki rozmownej — zarty, zagadki i pogawedka przez Claude.

Po co osobna encja, skoro to jedno ustawienie serwera: zeby dalo sie je
przelaczyc z pulpitu w HA, bez wchodzenia na hosta i bez restartu kontenera.
Serwer odtwarza silnik przy zmianie, wiec dziala od nastepnej tury.

🔑 Co ten przelacznik ROBI, a czego NIE: wlacza kierowanie POJEDYNCZYCH TUR,
ktore nie potrzebuja niczego z domu, na mocniejszy model. Komendy zostaja tam,
gdzie byly — to nie jest "tryb rozmowy", w ktory sie wchodzi. Gdy jest
wylaczony, model nie dostaje nawet definicji tego narzedzia.

⚠️ `available` odbija pole `dostepna` z serwera, ktore mowi, czy shim jest
w ogole skonfigurowany (ROZMOWA_URL). Bez tego przelacznik pokazywalby sie jako
sprawny i nie robil nic — a cicho nieskuteczny wlacznik jest gorszy niz jego
brak.

Wspolny koordynator z listami wyboru modelu siedzi w `rozmowa.py`.
"""

from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .rozmowa import RozmowaCoordinator, pobierz_koordynator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Jeden przelacznik na wpis konfiguracyjny."""
    coordinator = await pobierz_koordynator(hass, config_entry)
    async_add_entities([PrzelacznikRozmowy(coordinator, config_entry)])


class PrzelacznikRozmowy(CoordinatorEntity[RozmowaCoordinator], SwitchEntity):
    """Czy zarty, zagadki i pogawedka maja isc na mocniejszy model."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.CONFIG
    _attr_icon = "mdi:chat-processing-outline"

    def __init__(self, coordinator: RozmowaCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_name = "Rozmowa przez abonament"
        self._attr_unique_id = f"{entry.entry_id}_rozmowa"
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Home Mind",
            manufacturer="Home Mind",
            model="AI Assistant",
        )

    @property
    def available(self) -> bool:
        """Niedostepny, gdy serwer nie ma skonfigurowanego shima."""
        dane = self.coordinator.data
        return super().available and bool(dane) and bool(dane.get("dostepna"))

    @property
    def is_on(self) -> bool | None:
        dane = self.coordinator.data
        return None if not dane else bool(dane.get("wlaczona"))

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.ustaw(wlaczona=True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.ustaw(wlaczona=False)
