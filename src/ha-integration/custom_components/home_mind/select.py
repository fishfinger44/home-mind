"""Wybor modelu i poziomu wysilku dla sciezki rozmownej.

Dwie listy obok przelacznika z `switch.py`, na tym samym urzadzeniu "Home Mind".

🔑 OPCJI NIE MA W TYM PLIKU. Przychodza z serwera, ktory bierze je ze shima —
jedynego miejsca, ktore wie, co `claude` na hoscie przyjmie. Dzieki temu nie da
sie wybrac z HA modelu, ktory padlby dopiero przy pierwszym pytaniu, a dodanie
modelu to jedna linijka w `shim.py`, nie trzy w trzech projektach.

⚠️ Lista pokazuje NAZWY, a do serwera idzie identyfikator. Rozdzial jest po to,
zeby w panelu stalo "Opus 5", a nie "claude-opus-5" — ale mapowanie liczy sie
z danych, nie ze slownika tutaj, wiec nie ma czego rozjechac.
"""

from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
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
    """Dwie listy na wpis konfiguracyjny: model i poziom wysilku."""
    coordinator = await pobierz_koordynator(hass, config_entry)
    async_add_entities(
        [
            WyborModelu(coordinator, config_entry),
            WyborWysilku(coordinator, config_entry),
        ]
    )


class _BazaRozmowy(CoordinatorEntity[RozmowaCoordinator], SelectEntity):
    """Wspolne dla obu list: urzadzenie, kategoria i dostepnosc."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: RozmowaCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Home Mind",
            manufacturer="Home Mind",
            model="AI Assistant",
        )

    @property
    def _dane(self) -> dict:
        return self.coordinator.data or {}

    @property
    def available(self) -> bool:
        """Bez shima nie ma czego wybierac.

        Pusta lista modeli tez znaczy niedostepny: shim lezy albo jest starszy
        niz `GET /modele`, a lista z jedna zmyslona pozycja bylaby gorsza niz
        jej brak.
        """
        return (
            super().available
            and bool(self._dane.get("dostepna"))
            and bool(self._dane.get("modele"))
        )


class WyborModelu(_BazaRozmowy):
    """Ktory model Claude odpowiada na zarty, zagadki i pogawedke."""

    _attr_icon = "mdi:brain"

    def __init__(self, coordinator: RozmowaCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_name = "Model rozmowy"
        self._attr_unique_id = f"{entry.entry_id}_rozmowa_model"

    @property
    def _nazwy(self) -> dict[str, str]:
        """id modelu → nazwa do pokazania."""
        return {m["id"]: m.get("nazwa") or m["id"] for m in self._dane.get("modele", [])}

    @property
    def options(self) -> list[str]:
        nazwy = self._nazwy
        opcje = list(nazwy.values())
        # Model ustawiony w jednostce systemd moze nie byc na liscie shima.
        # Dopisujemy go, bo inaczej `current_option` wskazywaloby poza zbior
        # i HA zglosiloby to jako blad encji — zamiast po prostu pokazac, co
        # jest naprawde ustawione.
        biezacy = self._dane.get("model")
        if biezacy and biezacy not in nazwy:
            opcje.append(biezacy)
        return opcje

    @property
    def current_option(self) -> str | None:
        biezacy = self._dane.get("model")
        if not biezacy:
            return None
        return self._nazwy.get(biezacy, biezacy)

    async def async_select_option(self, option: str) -> None:
        # Z nazwy z powrotem na identyfikator. Gdy nazwy nie ma w mapie, to
        # dopisany wyzej model spoza listy — leci jak stoi.
        do_wyslania = next(
            (mid for mid, nazwa in self._nazwy.items() if nazwa == option), option
        )
        await self.coordinator.ustaw(model=do_wyslania)


class WyborWysilku(_BazaRozmowy):
    """Ile model ma sie namyslac (`--effort`).

    ⚠️ Ta lista jest NIEDOSTEPNA przy modelach, ktore flagi `--effort` nie maja
    (Haiku 4.5). To nie jest ukrywanie problemu, tylko jego pokazanie: gdyby
    dalo sie ja przekrecic, ustawienie wygladaloby na dzialajace, a shim i tak
    by je zdjal.
    """

    _attr_icon = "mdi:speedometer"

    def __init__(self, coordinator: RozmowaCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_name = "Wysilek rozmowy"
        self._attr_unique_id = f"{entry.entry_id}_rozmowa_effort"

    @property
    def _model_ma_wysilek(self) -> bool:
        biezacy = self._dane.get("model")
        for m in self._dane.get("modele", []):
            if m["id"] == biezacy:
                return bool(m.get("effort"))
        # Model spoza listy shima — zakladamy, ze flage zna, tak samo jak shim.
        return True

    @property
    def available(self) -> bool:
        return super().available and self._model_ma_wysilek

    @property
    def options(self) -> list[str]:
        return list(self._dane.get("wysilki", []))

    @property
    def current_option(self) -> str | None:
        return self._dane.get("effort") or None

    async def async_select_option(self, option: str) -> None:
        await self.coordinator.ustaw(effort=option)
