"""Sensors showing how much web-search allowance is left this month.

The server silently moves to the next search backend when one runs out of its
monthly allowance, which is the right behaviour mid-conversation but leaves the
household with no idea that it happened. These sensors make the remaining
allowance visible before the switch, so a free tier running dry is something you
see coming rather than discover in a log.
"""

from __future__ import annotations

from datetime import timedelta
import logging

import aiohttp

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import (
    CoordinatorEntity,
    DataUpdateCoordinator,
    UpdateFailed,
)

from .const import (
    API_SEARCH_USAGE_ENDPOINT,
    CONF_API_TOKEN,
    CONF_API_URL,
    DOMAIN,
    SEARCH_BACKEND_LABELS,
)

_LOGGER = logging.getLogger(__name__)

# Counters only move when someone asks the assistant something, so polling more
# often than this would just be traffic.
SCAN_INTERVAL = timedelta(minutes=15)

# Reading a counter should not hang the update loop the way a chat request can.
REQUEST_TIMEOUT = 10


class SearchUsageCoordinator(DataUpdateCoordinator[dict]):
    """Polls GET /api/search/usage and hands the snapshot to the sensors."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name="Home Mind search usage",
            update_interval=SCAN_INTERVAL,
        )
        self._url = f"{entry.data[CONF_API_URL].rstrip('/')}{API_SEARCH_USAGE_ENDPOINT}"
        self._token = entry.data.get(CONF_API_TOKEN, "").strip() or None
        self._session = async_get_clientsession(hass)

    async def _async_update_data(self) -> dict:
        """Fetch the usage snapshot, keyed by backend."""
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        try:
            async with self._session.get(
                self._url,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as response:
                if response.status != 200:
                    # A server older than this integration has no such endpoint.
                    raise UpdateFailed(
                        f"Search usage endpoint returned {response.status}"
                    )
                data = await response.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Could not reach Home Mind: {err}") from err

        return {
            "month": data.get("month"),
            "backends": {
                entry["backend"]: entry for entry in data.get("backends", [])
            },
        }


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up one sensor per search backend."""
    coordinator = SearchUsageCoordinator(hass, config_entry)
    # Deliberately not async_config_entry_first_refresh(): that raises
    # ConfigEntryNotReady on failure, which would take the conversation agent
    # down with it whenever the server is briefly unreachable or too old to know
    # this endpoint. A counter is worth less than the assistant — so the sensors
    # just start out unavailable and recover on the next poll.
    await coordinator.async_refresh()

    async_add_entities(
        SearchQuotaSensor(coordinator, config_entry, backend)
        for backend in SEARCH_BACKEND_LABELS
    )


class SearchQuotaSensor(CoordinatorEntity[SearchUsageCoordinator], SensorEntity):
    """Searches left this month on one backend."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_native_unit_of_measurement = "searches"
    _attr_icon = "mdi:web"

    def __init__(
        self,
        coordinator: SearchUsageCoordinator,
        entry: ConfigEntry,
        backend: str,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self._backend = backend
        self._attr_name = f"{SEARCH_BACKEND_LABELS[backend]} searches left"
        self._attr_unique_id = f"{entry.entry_id}_search_quota_{backend}"
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Home Mind",
            manufacturer="Home Mind",
            model="AI Assistant",
        )

    @property
    def _data(self) -> dict | None:
        """This backend's slice of the last snapshot."""
        if not self.coordinator.data:
            return None
        return self.coordinator.data["backends"].get(self._backend)

    @property
    def available(self) -> bool:
        """Unavailable when the server did not report this backend at all."""
        return super().available and self._data is not None

    @property
    def native_value(self) -> int | None:
        """Searches left, or None when the backend is not metered."""
        data = self._data
        if data is None:
            return None
        # The server reports -1 for a backend with no configured quota, which is
        # "unmetered", not "minus one search left".
        remaining = data.get("remaining", -1)
        return None if remaining < 0 else remaining

    @property
    def extra_state_attributes(self) -> dict:
        """Counters behind the value, plus why a backend was taken out."""
        data = self._data
        if data is None:
            return {}
        quota = data.get("quota", 0)
        used = data.get("used", 0)
        attributes = {
            "backend": self._backend,
            "used": used,
            "quota": quota,
            "exhausted": data.get("exhausted", False),
            "month": self.coordinator.data.get("month"),
        }
        if quota > 0:
            attributes["used_percent"] = round(used / quota * 100)
        if exhausted_at := data.get("exhaustedAt"):
            attributes["exhausted_at"] = exhausted_at
        return attributes
