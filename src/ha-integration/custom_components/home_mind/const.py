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
WEB_SEARCH_MODES = ["grounding", "gemini_micro", "tavily", "brave"]
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

CLOUD_SIGNUP_URL = "https://homemind.veganostr.com"

API_CONFIG_LLM_ENDPOINT = "/api/config/llm"
