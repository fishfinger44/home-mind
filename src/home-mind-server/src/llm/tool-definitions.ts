import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_state",
    description:
      "Get the current state of a Home Assistant entity (sensor, light, switch, etc.)",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "The entity ID to get state for (e.g., sensor.temperature, light.living_room)",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "get_entities",
    description:
      "List all Home Assistant entities, optionally filtered by domain (light, sensor, switch, etc.)",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description:
            "Optional domain to filter by (e.g., 'light', 'sensor', 'switch')",
        },
      },
      required: [],
    },
  },
  {
    name: "search_entities",
    description:
      "Search for Home Assistant entities by name or ID substring. Returns entity IDs, states, and attributes. Use this to find the correct entity_id before calling call_service.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to match against entity IDs and names",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "call_service",
    description:
      "Call a Home Assistant service to control devices (turn on/off lights, set thermostat, etc.)",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Service domain (e.g., 'light', 'switch', 'climate')",
        },
        service: {
          type: "string",
          description:
            "Service name (e.g., 'turn_on', 'turn_off', 'toggle'). For lights: use 'turn_on' with data to set brightness/color — there is no separate 'set_color' service.",
        },
        entity_id: {
          type: "string",
          description: "Optional entity ID to target",
        },
        data: {
          type: "object",
          description:
            "Optional service data. Common fields for light.turn_on: brightness (0-255), rgb_color ([R,G,B] each 0-255), color_temp_kelvin (2000-6500, e.g. 2700=warm white, 4000=neutral, 6500=daylight), hs_color ([hue 0-360, saturation 0-100]), rgbw_color ([R,G,B,W] each 0-255, for RGBW strips). WHITE LIGHT — check supported_color_modes first: if 'rgbw' use rgbw_color [0,0,0,255]; if only 'color_temp' use color_temp_kelvin; if 'xy'/'hs'/'rgb' (RGB-only lights) use rgb_color [255,255,255]. Do NOT invent fields like 'white' or 'color'. For weather.get_forecasts: data {\"type\": \"daily\"} or {\"type\": \"hourly\"}.",
        },
        return_response: {
          type: "boolean",
          description:
            "Set true for services that RETURN data instead of just acting — e.g. weather.get_forecasts (weather forecast), calendar.get_events, todo.get_items. The returned data comes back in the tool result. Leave false/omit for normal control services (turn_on, etc.).",
        },
      },
      required: ["domain", "service"],
    },
  },
  {
    name: "get_history",
    description:
      "Get historical states for an entity over time (for trend analysis)",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity ID to get history for",
        },
        start_time: {
          type: "string",
          description:
            "Start time in ISO 8601 format with timezone (e.g., '2026-01-15T20:00:00Z'). Use the ISO Timestamp from system context for calculations. Default: 24 hours ago.",
        },
        end_time: {
          type: "string",
          description:
            "End time in ISO 8601 format with timezone (e.g., '2026-01-15T21:00:00Z'). Use the ISO Timestamp from system context for calculations. Default: now.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "web_search",
    description:
      "Perform a web search to get up-to-date information from the internet. Use this when Home Assistant data and your own knowledge are not enough.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query in natural language (e.g., 'weather in Wrocław tomorrow', 'who is the president of the USA', 'latest news about Home Assistant').",
        },
        max_results: {
          type: "number",
          description:
            "Optional maximum number of results to return (default: 3, reasonable range: 1–6). Fewer results = cheaper; ask for more only if needed.",
        },
      },
      required: ["query"],
    },
  },
  // Jedyne narzedzie opisane po polsku, i celowo: odpowiada na pytania zadawane
  // po polsku o wroclawskie linie, a nazwy przystankow i kierunkow wracaja z
  // Google po polsku. Reguly, ktore je wolaja, tez sa polskie.
  {
    name: "zaplanuj_trase",
    description:
      "Zaplanuj dojazd komunikacja miejska (autobus, tramwaj, pociag) z jednego miejsca do drugiego. " +
      "Uzyj tego ZAWSZE, gdy pytanie dotyczy dojazdu, polaczenia, przesiadki albo tego, ktora linia jechac. " +
      "Odpowiedz zawiera numer linii, KIERUNEK (pole 'kierunek' - wypowiedz go na glos, nie zgaduj strony), " +
      "przystanek wsiadania i godziny. To NIE jest tablica odjazdow: podaje polaczenie na konkretna pore, " +
      "a nie kolejne kursy jednej linii ani liste linii odjezdzajacych z przystanku - o to nie pytaj, " +
      "tylko powiedz wprost, ze tego nie umiesz. Zawsze potrzebuje CELU podrozy: gdy uzytkownik nazwal " +
      "sama linie albo sam przystanek, dopytaj, dokad chce dojechac. " +
      "Rozklad jest planowy - nie zawiera opoznien na zywo.",
    parameters: {
      type: "object",
      properties: {
        dokad: {
          type: "string",
          description:
            "Cel podrozy: adres albo znany skrot (np. 'centrum', 'praca'). Nieznana nazwa idzie do Google jako adres. " +
            "NIGDY numer linii ani nazwa przystanku, z ktorego sie wsiada - to nie sa cele podrozy.",
        },
        skad: {
          type: "string",
          description:
            "Punkt poczatkowy. Pominiety = dom. Tu wlasnie wpisz przystanek, jesli uzytkownik go wskazal.",
        },
        kiedy: {
          type: "string",
          description:
            "POMIN, gdy pytanie brzmi 'teraz', 'najblizszy', 'kiedy jedzie' - brak tego pola znaczy 'teraz' " +
            "i jest to jedyna godzina, ktorej nie da sie pomylic. Podawaj wylacznie wtedy, gdy uzytkownik " +
            "nazwal konkretna pore ('na dziewiata', 'jutro o 7'), i pisz ja jako CZAS LOKALNY bez strefy: " +
            "'2026-08-13T09:00:00' - bez 'Z' i bez przesuniecia.",
        },
        kiedy_znaczy: {
          type: "string",
          description:
            "'wyjazd' (domyslnie) = o tej godzinie wyruszam; 'przyjazd' = o tej godzinie mam byc na miejscu.",
        },
      },
      required: ["dokad"],
    },
  },
  // Tablica odjazdow - drugie z dwoch pytan o komunikacje. Rozdzielone od
  // planowania trasy, bo Routes API wymaga CELU, a "o ktorej jedzie 111" celu
  // nie ma. Godziny czytamy wprost ze strony miasta.
  {
    name: "odjazdy",
    description:
      "Godziny odjazdow KONKRETNEJ LINII z przystanku - tablica odjazdow. " +
      "Uzyj, gdy pytanie brzmi 'o ktorej jedzie 111', 'kiedy najblizszy autobus 142', " +
      "'kiedy odjazd tramwaju 7 z Baltyckiej'. Bez podanego przystanku bierze ten pod domem. " +
      "Oddaje najblizsze kursy w OBIE strony, kazda z kierunkiem - wypowiedz kierunek, nie zgaduj strony. " +
      "Do pytania 'jak dojade do X' uzyj zamiast tego zaplanuj_trase.",
    parameters: {
      type: "object",
      properties: {
        linia: {
          type: "string",
          description: "Sam numer linii, np. '111', '7', '142'.",
        },
        przystanek: {
          type: "string",
          description: "Nazwa przystanku. Pominiety = przystanek pod domem.",
        },
        kierunek: {
          type: "string",
          description:
            "Kierunek, jesli uzytkownik go nazwal (np. 'Osiedle Sobieskiego'). Pominiety = obie strony.",
        },
      },
      required: ["linia"],
    },
  },
  // Po polsku z tego samego powodu co zaplanuj_trase: fakty w tej bazie sa
  // zapisywane po polsku (ekstraktor pisze po polsku), wiec i zapytanie, ktore
  // model tu ulozy, ma byc polskie — trafnosc liczy sie miedzy zapytaniem a
  // trescia faktu, a nie miedzy jezykami.
  {
    name: "sprawdz_pamiec",
    description:
      "Poszukaj w pamieci tego, co wiadomo o domownikach i domu, gdy potrzebujesz czegos, czego nie masz przed soba. " +
      "Fakty najbardziej zwiazane z rozmowa dostajesz automatycznie — to narzedzie jest na sytuacje, " +
      "gdy zwiazek jest niebezposredni i moglo go zabraknac. " +
      "Przyklad: pytanie 'zrob mi kawe' o 22:00 nie przyniesie samo z siebie faktu o niepiciu kawy wieczorem — " +
      "jesli masz zrobic cos, co moze sie klocic z czyimis przyzwyczajeniami, sprawdz najpierw. " +
      "Pusta odpowiedz znaczy 'nie wiem', a NIE 'nie ma takiego zwyczaju' — nie zmyslaj wtedy faktu i nie zakladaj, ze czegos nie ma.",
    parameters: {
      type: "object",
      properties: {
        czego_szukasz: {
          type: "string",
          description:
            "Czego szukasz, wlasnymi slowami po polsku — np. 'kawa wieczorem', 'ulubione swiatlo w salonie', " +
            "'imiona dzieci'. To jest wyszukiwanie po znaczeniu, wiec opisz TEMAT, a nie powtarzaj calego pytania uzytkownika.",
        },
      },
      required: ["czego_szukasz"],
    },
  },
];

export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  }));
}

export function toOpenAITools(
  tools: ToolDefinition[]
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Native Gemini function-declaration shape (used by GeminiChatEngine). */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * Convert to a native Gemini `{ functionDeclarations: [...] }` tool block.
 * Gemini accepts object-typed parameters with no `properties` (a free-form
 * object like call_service's `data`) and fills them from the description — so
 * we pass the parameter schema through untouched. (An earlier version injected
 * a placeholder property, which mislead the model into using that fake key
 * instead of the real fields — do NOT reintroduce it.)
 */
export function toGeminiTools(
  tools: ToolDefinition[]
): { functionDeclarations: GeminiFunctionDeclaration[] } {
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}
