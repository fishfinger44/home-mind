"""Config flow for Home Mind integration."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
    SelectSelector,
    SelectSelectorConfig,
    SelectOptionDict,
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
)

from .const import (
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
    WEB_SEARCH_MODES,
    SEARCH_MODE_LABELS,
    SEARCH_MODE_BACKENDS,
    DEFAULT_API_URL,
    DEFAULT_USER_ID,
    API_HEALTH_ENDPOINT,
    API_CONFIG_LLM_ENDPOINT,
    API_SEARCH_USAGE_ENDPOINT,
    CLOUD_SIGNUP_URL,
)

# Default OpenAI-compatible endpoint for the Gemini provider.
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

# Ollama's OpenAI-compatible endpoint. Points at the container in the project's
# compose file; a Ollama on another machine needs this changed to its address.
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"

_LOGGER = logging.getLogger(__name__)

STEP_USER_DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_API_URL, default=DEFAULT_API_URL): str,
        vol.Optional(CONF_API_TOKEN): str,
        vol.Optional(CONF_USER_ID, default=DEFAULT_USER_ID): str,
    }
)

# Friendly provider labels (server uses "anthropic"/"openai" internally).
PROVIDER_OPTIONS = [
    SelectOptionDict(value="anthropic", label="Claude (Anthropic)"),
    SelectOptionDict(
        value="gemini",
        label="Gemini natywny — wyszukiwarka Google (taniej, polecane)",
    ),
    SelectOptionDict(
        value="openai", label="Gemini (OpenAI-compat) — wyszukiwanie Tavily/Brave"
    ),
    SelectOptionDict(
        value="ollama",
        label="Ollama — model lokalny na własnym GPU (bez klucza, bez internetu)",
    ),
]


def _gb(size_bytes: int) -> str:
    """Bytes as GB with one decimal, in the locale the rest of the form uses."""
    return f"{size_bytes / 1024 ** 3:.1f}".replace(".", ",")


def _vram(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def _allowance(usage: dict[str, Any]) -> str:
    """One backend's remaining monthly allowance, in words."""
    quota = int(usage.get("quota", 0) or 0)
    used = int(usage.get("used", 0) or 0)
    remaining = int(usage.get("remaining", -1))
    if usage.get("exhausted"):
        return f"used up ({used}/{quota})"
    # The server reports -1 for a backend with no configured quota.
    if remaining < 0:
        return "no monthly limit"
    return f"{remaining} of {quota} left"


async def validate_input(hass: HomeAssistant, data: dict[str, Any]) -> dict[str, Any]:
    """Validate the user input allows us to connect."""
    session = async_get_clientsession(hass)
    api_url = data[CONF_API_URL].rstrip("/")
    api_token = data.get(CONF_API_TOKEN, "").strip() or None

    headers = {}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    try:
        async with session.get(
            f"{api_url}{API_HEALTH_ENDPOINT}",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status != 200:
                raise CannotConnect(f"API returned status {response.status}")
            result = await response.json()
            if result.get("status") != "ok":
                raise CannotConnect("API health check failed")

        if api_token:
            user_id = data.get(CONF_USER_ID, DEFAULT_USER_ID)
            async with session.get(
                f"{api_url}/api/memory/{user_id}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                if response.status in (401, 403):
                    raise InvalidAuth("Invalid API token")
                if response.status != 200:
                    raise CannotConnect(
                        f"Token verification returned status {response.status}"
                    )
    except aiohttp.ClientError as err:
        _LOGGER.error("Error connecting to Home Mind API: %s", err)
        raise CannotConnect from err

    return {"title": "Home Mind"}


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Home Mind."""

    VERSION = 1

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> OptionsFlow:
        """Get the options flow for this handler."""
        return OptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                info = await validate_input(self.hass, user_input)
            except InvalidAuth:
                errors["base"] = "invalid_auth"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except Exception:  # pylint: disable=broad-except
                _LOGGER.exception("Unexpected exception")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(title=info["title"], data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_DATA_SCHEMA,
            description_placeholders={"cloud_url": CLOUD_SIGNUP_URL},
            errors=errors,
        )


class OptionsFlow(config_entries.OptionsFlow):
    """Options: LLM provider/model switching + custom prompt."""

    _provider: str | None = None
    _custom_prompt: str = ""
    _prefer_local: bool = False
    _web_search_limit: int = DEFAULT_WEB_SEARCH_LIMIT
    _memory_token_limit: int = DEFAULT_MEMORY_TOKEN_LIMIT
    _web_search_mode: str | None = None
    _models: dict[str, list[str]] = {}
    _current: dict[str, Any] = {}
    _usage: dict[str, dict[str, Any]] = {}
    _ollama: dict[str, Any] = {}

    def _endpoints(self) -> tuple[str, dict[str, str]]:
        api_url = self.config_entry.data[CONF_API_URL].rstrip("/")
        token = (self.config_entry.data.get(CONF_API_TOKEN) or "").strip() or None
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return api_url, headers

    async def _fetch_llm(self) -> None:
        api_url, headers = self._endpoints()
        session = async_get_clientsession(self.hass)
        async with session.get(
            f"{api_url}{API_CONFIG_LLM_ENDPOINT}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            data = await resp.json()
            self._models = data.get("models", {}) or {}
            self._current = data.get("current", {}) or {}
            # Absent on servers older than the local-model support.
            self._ollama = data.get("ollama", {}) or {}

    async def _fetch_search_usage(self) -> None:
        """Read how much monthly allowance each search backend has left.

        Best-effort: the numbers only annotate the mode picker, so a server that
        is unreachable or too old to know this endpoint must still leave the
        options flow usable — just without them.
        """
        api_url, headers = self._endpoints()
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{api_url}{API_SEARCH_USAGE_ENDPOINT}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    return
                data = await resp.json()
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            _LOGGER.debug("Could not read search usage for the options form: %s", err)
            return

        self._usage = {
            entry["backend"]: entry for entry in data.get("backends", [])
        }

    def _web_search_mode_options(self) -> list[SelectOptionDict]:
        """The search modes, each showing what is left on it this month."""
        options: list[SelectOptionDict] = []
        for mode in WEB_SEARCH_MODES:
            label = SEARCH_MODE_LABELS.get(mode, mode)
            backend = SEARCH_MODE_BACKENDS.get(mode)
            if backend is None:
                # Nothing meters this one. Say so for grounding, which is billed
                # and would otherwise look like a backend we failed to read.
                if mode == "grounding":
                    label += " — not metered here"
            elif (usage := self._usage.get(backend)) is not None:
                label += f" — {_allowance(usage)}"
            options.append(SelectOptionDict(value=mode, label=label))
        return options

    def _ollama_model_options(self) -> list[SelectOptionDict]:
        """Local models, labelled with what they cost in VRAM.

        Installed models come first: only those can actually be selected without
        a `ollama pull`. Suggestions follow, so the picker also answers "what
        should I download", with each one's requirement attached — the choice
        that matters for a local model is whether it fits the card, and a model
        that does not fit still runs, just partly on the CPU and far slower.
        """
        options: list[SelectOptionDict] = []
        installed = {m["name"] for m in self._ollama.get("models", [])}

        for model in self._ollama.get("models", []):
            parts = [f"{_gb(model.get('sizeBytes', 0))} GB"]
            if model.get("parameterSize"):
                parts.append(model["parameterSize"])
            if model.get("quantization"):
                parts.append(model["quantization"])
            label = f"{model['name']} — {', '.join(parts)}"
            if (required := model.get("requiredVramGb")) is not None:
                label += f" · potrzeba ~{_vram(required)} GB VRAM"
            fits = model.get("fitsVram")
            if fits is True:
                label += " ✓ zmieści się"
            elif fits is False:
                label += " ⚠ NIE zmieści się — pójdzie częściowo na CPU"
            # Hard requirement, not a nicety: Home Mind steers the house through
            # tool calls, so a model without them cannot do the job at all.
            if model.get("supportsTools") is False:
                label += " ⛔ BEZ obsługi narzędzi — nie zsteruje domem"
            options.append(SelectOptionDict(value=model["name"], label=label))

        for suggestion in self._ollama.get("suggestions", []):
            if suggestion["name"] in installed:
                continue
            options.append(
                SelectOptionDict(
                    value=suggestion["name"],
                    label=(
                        f"{suggestion['name']} — DO POBRANIA "
                        f"(~{_vram(suggestion['vramGb'])} GB VRAM): {suggestion['note']}"
                    ),
                )
            )
        return options

    def _ollama_hint(self) -> str:
        """One line about the local backend, shown above the model picker."""
        if not self._ollama:
            return (
                "Serwer Home Mind nie zna jeszcze modeli lokalnych — "
                "zaktualizuj go, żeby zobaczyć, co jest zainstalowane."
            )
        if not self._ollama.get("reachable"):
            return (
                f"⚠ Ollama nieosiągalna pod {self._ollama.get('baseUrl', '?')} "
                f"({self._ollama.get('error', 'brak odpowiedzi')}). "
                "Model z listy „DO POBRANIA\" nie zadziała, dopóki jej nie uruchomisz."
            )

        count = len(self._ollama.get("models", []))
        hint = f"Ollama działa pod {self._ollama['baseUrl']}, zainstalowanych modeli: {count}."
        if count == 0:
            hint += " Pobierz któryś: `docker exec home-mind-ollama ollama pull qwen3:4b`."
        if (vram := self._ollama.get("vramTotalGb")) is not None:
            usable = self._ollama.get("usableVramGb", vram)
            hint += (
                f" Karta ma {_vram(vram)} GB VRAM, dla modelu zostaje "
                f"~{_vram(usable)} GB (resztę bierze sterownik)."
            )
        else:
            hint += (
                " Ustaw OLLAMA_VRAM_GB na serwerze, żeby lista mówiła też, "
                "czy model się zmieści."
            )
        # What actually fit beats any estimate, so say it when we know it.
        for loaded in self._ollama.get("loaded", []):
            if loaded.get("onGpuPercent", 100) < 100:
                hint += (
                    f" ⚠ Załadowany {loaded['name']} siedzi na GPU tylko w "
                    f"{loaded['onGpuPercent']}% — reszta liczy się na CPU."
                )
        return hint

    async def _post_llm(
        self,
        provider: str,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        search_api_key: str | None = None,
        thinking: bool | None = None,
    ) -> None:
        api_url, headers = self._endpoints()
        session = async_get_clientsession(self.hass)
        payload: dict[str, Any] = {"provider": provider, "model": model}
        if api_key:
            payload["apiKey"] = api_key
        if base_url:
            payload["baseUrl"] = base_url
        if search_api_key:
            payload["searchApiKey"] = search_api_key
        # Sent only when the form actually offered the switch (Ollama). Omitting
        # it leaves the stored setting alone, which is what an older server —
        # one that does not know the field — needs too.
        if thinking is not None:
            payload["thinking"] = thinking
        async with session.post(
            f"{api_url}{API_CONFIG_LLM_ENDPOINT}",
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status != 200:
                raise CannotConnect(f"Server returned {resp.status}")

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Step 1: choose provider + custom prompt."""
        errors: dict[str, str] = {}
        try:
            await self._fetch_llm()
        except Exception:  # pylint: disable=broad-except
            errors["base"] = "cannot_connect"

        if user_input is not None and not errors:
            self._provider = user_input["provider"]
            self._custom_prompt = user_input.get(CONF_CUSTOM_PROMPT, "") or ""
            self._prefer_local = bool(user_input.get(CONF_PREFER_LOCAL, False))
            self._web_search_limit = int(
                user_input.get(CONF_WEB_SEARCH_LIMIT, DEFAULT_WEB_SEARCH_LIMIT)
            )
            self._memory_token_limit = int(
                user_input.get(CONF_MEMORY_TOKEN_LIMIT, DEFAULT_MEMORY_TOKEN_LIMIT)
            )
            self._web_search_mode = user_input.get(CONF_WEB_SEARCH_MODE)
            return await self.async_step_model()

        # Only needed for the form itself, so it is not paid for on submit.
        await self._fetch_search_usage()

        schema = vol.Schema(
            {
                vol.Required(
                    "provider",
                    default=self._current.get("provider", "openai"),
                ): SelectSelector(SelectSelectorConfig(options=PROVIDER_OPTIONS)),
                vol.Optional(
                    CONF_PREFER_LOCAL,
                    default=self.config_entry.options.get(CONF_PREFER_LOCAL, False),
                ): BooleanSelector(),
                vol.Optional(
                    CONF_WEB_SEARCH_LIMIT,
                    default=self.config_entry.options.get(
                        CONF_WEB_SEARCH_LIMIT, DEFAULT_WEB_SEARCH_LIMIT
                    ),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=0, max=5, step=1, mode=NumberSelectorMode.SLIDER
                    )
                ),
                vol.Optional(
                    CONF_MEMORY_TOKEN_LIMIT,
                    default=self.config_entry.options.get(
                        CONF_MEMORY_TOKEN_LIMIT, DEFAULT_MEMORY_TOKEN_LIMIT
                    ),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=0, max=8000, step=250, mode=NumberSelectorMode.SLIDER
                    )
                ),
                vol.Optional(
                    CONF_WEB_SEARCH_MODE,
                    default=self.config_entry.options.get(
                        CONF_WEB_SEARCH_MODE, "grounding"
                    ),
                ): SelectSelector(
                    # No translation_key: a translated label would replace the
                    # whole string, including the allowance appended to it.
                    SelectSelectorConfig(options=self._web_search_mode_options())
                ),
                vol.Optional(
                    CONF_CUSTOM_PROMPT,
                    description={
                        "suggested_value": self.config_entry.options.get(
                            CONF_CUSTOM_PROMPT, ""
                        )
                    },
                ): TextSelector(
                    TextSelectorConfig(multiline=True, type=TextSelectorType.TEXT)
                ),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)

    async def async_step_model(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Step 2: choose the model for the selected provider."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await self._post_llm(
                    self._provider,
                    user_input["model"],
                    api_key=(user_input.get("api_key") or "").strip() or None,
                    base_url=(user_input.get("base_url") or "").strip() or None,
                    search_api_key=(user_input.get("search_api_key") or "").strip()
                    or None,
                    thinking=user_input.get("thinking"),
                )
            except Exception:  # pylint: disable=broad-except
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_CUSTOM_PROMPT: self._custom_prompt,
                        CONF_PREFER_LOCAL: self._prefer_local,
                        CONF_WEB_SEARCH_LIMIT: self._web_search_limit,
                        CONF_MEMORY_TOKEN_LIMIT: self._memory_token_limit,
                        **(
                            {CONF_WEB_SEARCH_MODE: self._web_search_mode}
                            if self._web_search_mode
                            else {}
                        ),
                    },
                )

        is_ollama = self._provider == "ollama"
        models = self._models.get(self._provider, [])
        if is_ollama:
            options = self._ollama_model_options()
            # Prefer what is installed as the default — a suggestion would name
            # a model the server cannot load yet.
            models = [m["name"] for m in self._ollama.get("models", [])] or models
        else:
            options = [SelectOptionDict(value=m, label=m) for m in models]
        if self._current.get("provider") == self._provider and self._current.get("model"):
            default_model = self._current["model"]
        else:
            default_model = models[0] if models else ""

        # Prefill the base URL: keep the server's current one when re-editing the
        # same provider, otherwise suggest the Gemini endpoint for openai.
        if self._current.get("provider") == self._provider and self._current.get("baseUrl"):
            base_url_default = self._current["baseUrl"]
        elif self._provider == "openai":
            base_url_default = DEFAULT_GEMINI_BASE_URL
        elif is_ollama:
            base_url_default = DEFAULT_OLLAMA_BASE_URL
        else:
            base_url_default = ""

        # Whether a key is already stored server-side (so we can hint "leave blank
        # to keep current"). The key value itself is never returned by the server.
        has_key = bool(self._current.get("hasApiKey")) and (
            self._current.get("provider") == self._provider
        )

        schema_dict: dict[Any, Any] = {
            vol.Required("model", default=default_model): SelectSelector(
                SelectSelectorConfig(options=options, custom_value=True)
            ),
        }
        # A local model has no account behind it, so asking for a key would be
        # asking for something that does not exist.
        if not is_ollama:
            schema_dict[vol.Optional("api_key")] = TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            )
        # Deep thinking: offered for local models only. A reasoning model left to
        # think can spend its entire output budget on an internal monologue and
        # return nothing at all — measured on qwen3.5, 1200 of 1200 tokens with
        # no answer. The hosted providers are deliberately not offered it: the
        # parameter that carries the setting is rejected by Gemini with a 400.
        if is_ollama:
            thinking_default = self._current.get("thinking")
            schema_dict[
                vol.Optional(
                    "thinking",
                    default=True if thinking_default is None else bool(thinking_default),
                )
            ] = BooleanSelector()
        # The search key belongs to the web-search backend, not to the chat
        # provider — a local model still searches through it.
        schema_dict[vol.Optional("search_api_key")] = TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        )
        if self._provider == "openai" or is_ollama:
            schema_dict[
                vol.Optional("base_url", default=base_url_default)
            ] = TextSelector(TextSelectorConfig(type=TextSelectorType.URL))

        return self.async_show_form(
            step_id="model",
            data_schema=vol.Schema(schema_dict),
            errors=errors,
            description_placeholders={
                "provider": self._provider or "",
                "key_hint": (
                    ""
                    if is_ollama
                    else (
                        "A key is already stored — leave blank to keep it."
                        if has_key
                        else "Enter the API key for the selected provider."
                    )
                ),
                "ollama_hint": self._ollama_hint() if is_ollama else "",
            },
        )


class CannotConnect(HomeAssistantError):
    """Error to indicate we cannot connect."""


class InvalidAuth(HomeAssistantError):
    """Error to indicate invalid authentication."""
