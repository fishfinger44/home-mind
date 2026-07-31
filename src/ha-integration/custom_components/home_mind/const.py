"""Constants for Home Mind integration."""

DOMAIN = "home_mind"
CONF_API_URL = "api_url"
CONF_API_TOKEN = "api_token"
CONF_USER_ID = "user_id"
CONF_CUSTOM_PROMPT = "custom_prompt"
CONF_PREFER_LOCAL = "prefer_local"
CONF_WEB_SEARCH_LIMIT = "web_search_limit"
DEFAULT_WEB_SEARCH_LIMIT = 1  # 0 = no internet; higher = more searches per query
CONF_WEB_SEARCH_MODE = "web_search_mode"
# How the assistant reaches the internet:
#   grounding    - the model searches inside its own request (Gemini only,
#                  needs a BILLED Google project; the free tier rejects it)
#   gemini_micro - our web_search tool answered by a small grounded request
#                  on a SECOND, billed key (free chat + paid search)
#   tavily/brave - our web_search tool backed by a third-party search API
#   searxng      - our web_search tool answered by a SearXNG instance we host
#                  ourselves: no key, no account, no monthly allowance
WEB_SEARCH_MODES = ["grounding", "gemini_micro", "tavily", "searxng", "brave"]

# Names for those modes in the options flow. They live here rather than in the
# translations because the flow appends each backend's remaining allowance to
# them, and a translation key replaces the whole label — taking the number with
# it.
SEARCH_MODE_LABELS = {
    "grounding": "Integrated Google Search (paid Gemini key, cheapest)",
    "gemini_micro": "Micro-call to Google Search (second, billed key)",
    "tavily": "Tavily",
    "searxng": "Own server (SearXNG, free, no key)",
    "brave": "Brave Search",
}

# The backend /api/search/usage reports for each mode. None means there is no
# monthly allowance to show: `grounding` is billed inside the chat request and
# never passes through the metered web_search tool, and `searxng` is hosted
# here, so it cannot run out.
SEARCH_MODE_BACKENDS = {
    "grounding": None,
    "gemini_micro": "gemini_micro",
    "tavily": "tavily",
    "searxng": None,
    "brave": "brave",
}
CONF_MEMORY_TOKEN_LIMIT = "memory_token_limit"
# Token budget for facts recalled from memory and attached to every request.
# 0 = send no memory at all (the server also skips the memory lookup).
DEFAULT_MEMORY_TOKEN_LIMIT = 1500

# Built-in Home Assistant default (local) conversation agent — used for the
# "try locally first" (0-token) path before falling back to the Home Mind server.
HOME_ASSISTANT_AGENT = "conversation.home_assistant"

DEFAULT_API_URL = "http://localhost:3100"
DEFAULT_USER_ID = "default"
DEFAULT_TIMEOUT = 120  # Claude with tool use can take 60+ seconds

API_CHAT_ENDPOINT = "/api/chat"
API_HEALTH_ENDPOINT = "/api/health"
API_SEARCH_USAGE_ENDPOINT = "/api/search/usage"

# Search backends the server reports usage for, with the names shown in HA.
SEARCH_BACKEND_LABELS = {
    "gemini_micro": "Google Search",
    "tavily": "Tavily",
    "brave": "Brave",
}

CLOUD_SIGNUP_URL = "https://homemind.veganostr.com"

API_CONFIG_LLM_ENDPOINT = "/api/config/llm"
