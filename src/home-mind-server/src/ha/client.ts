import type { Config } from "../config.js";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HistoryEntry {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/** domena -> usługa -> czy przyjmuje `entity_id` (ma `target`). */
export type KatalogUslug = Map<string, Map<string, { przyjmujeCel: boolean }>>;

export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;

  /** Adres i token do rzeczy, których REST nie wystawia — patrz `area-aliases.ts`. */
  get adres(): string {
    return this.baseUrl;
  }
  get poswiadczenie(): string {
    return this.token;
  }
  private skipTlsVerify: boolean;

  // Cache settings
  private cacheTTL: number = 10000; // 10 seconds default
  private allStatesCache: CacheEntry<EntityState[]> | null = null;
  private entityCache: Map<string, CacheEntry<EntityState>> = new Map();

  constructor(config: Config) {
    this.baseUrl = config.haUrl.replace(/\/$/, "");
    this.token = config.haToken;
    this.skipTlsVerify = config.haSkipTlsVerify;
  }

  /**
   * Check if cache entry is still valid
   */
  private isCacheValid<T>(entry: CacheEntry<T> | null | undefined): entry is CacheEntry<T> {
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.cacheTTL;
  }

  /**
   * Invalidate all caches (call after service calls)
   */
  private invalidateCache(): void {
    this.allStatesCache = null;
    this.entityCache.clear();
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    // Handle self-signed certificates
    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async fetchText(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<string> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.text();
  }

  /**
   * Get all states (cached)
   */
  private async getAllStatesCached(): Promise<EntityState[]> {
    if (this.isCacheValid(this.allStatesCache)) {
      return this.allStatesCache.data;
    }

    const states = await this.fetch<EntityState[]>("/api/states");
    this.allStatesCache = { data: states, timestamp: Date.now() };

    // Also populate individual entity cache
    for (const state of states) {
      this.entityCache.set(state.entity_id, { data: state, timestamp: Date.now() });
    }

    return states;
  }

  /**
   * Get state of a single entity (cached)
   */
  async getState(entityId: string): Promise<EntityState> {
    // Check individual cache first
    const cached = this.entityCache.get(entityId);
    if (this.isCacheValid(cached)) {
      return cached.data;
    }

    // Check if we have a recent all-states cache
    if (this.isCacheValid(this.allStatesCache)) {
      const state = this.allStatesCache.data.find(s => s.entity_id === entityId);
      if (state) return state;
    }

    // Fetch individual entity
    const state = await this.fetch<EntityState>(`/api/states/${entityId}`);
    this.entityCache.set(entityId, { data: state, timestamp: Date.now() });
    return state;
  }

  /**
   * Get all entities, optionally filtered by domain (cached)
   */
  async getEntities(domain?: string): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();

    if (domain) {
      return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    return states;
  }

  /**
   * Search entities by name or ID substring (cached)
   */
  async searchEntities(query: string): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();
    const lowerQuery = query.toLowerCase();

    return states.filter((s) => {
      const name = (s.attributes.friendly_name as string) || "";
      return (
        s.entity_id.toLowerCase().includes(lowerQuery) ||
        name.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * Nazwy usług, jakie Home Assistant naprawdę wystawia, per domena.
   *
   * 🔑 Po co: rozstrzygnięcie, czy `service` w `data` jest NAZWĄ USŁUGI, którą
   * model wsadził o poziom za nisko, czy WŁASNYM ARGUMENTEM usługi. Obie rzeczy
   * wyglądają identycznie — `media_assistant.find_and_play` ma pole `service`
   * na nazwę aplikacji, więc "disneyplus" trafiało tam, gdzie oczekiwano
   * "find_and_play", i wywołanie szło do usługi, której nie ma.
   *
   * Lista zmienia się tylko przy dokładaniu integracji, stąd godzina cache.
   */
  private uslugiCache: { kiedy: number; mapa: KatalogUslug } | null = null;

  async getServices(): Promise<KatalogUslug> {
    const teraz = Date.now();
    if (this.uslugiCache && teraz - this.uslugiCache.kiedy < 3600_000) {
      return this.uslugiCache.mapa;
    }

    const lista = await this.fetch<
      { domain: string; services: Record<string, { target?: unknown }> }[]
    >("/api/services");

    const mapa: KatalogUslug = new Map();
    for (const wpis of lista) {
      const uslugi = new Map<string, { przyjmujeCel: boolean }>();
      for (const [nazwa, opis] of Object.entries(wpis.services ?? {})) {
        // Usługa BEZ `target` nie przyjmuje `entity_id` — Home Assistant odbija
        // takie wywołanie jako 400, a model nie ma z czego wywnioskować czemu.
        uslugi.set(nazwa, { przyjmujeCel: opis?.target != null });
      }
      mapa.set(wpis.domain, uslugi);
    }

    this.uslugiCache = { kiedy: teraz, mapa };
    return mapa;
  }

  /**
   * Call a Home Assistant service (invalidates cache)
   */
  async callService(
    domain: string,
    service: string,
    entityId?: string,
    data?: Record<string, unknown>,
    returnResponse = false
  ): Promise<unknown> {
    const payload: Record<string, unknown> = { ...data };
    if (entityId) {
      payload.entity_id = entityId;
    }

    // Services declared with SupportsResponse.ONLY (e.g. weather.get_forecasts,
    // calendar.get_events) require ?return_response=true and reply with a
    // { changed_states, service_response } body instead of a bare state array.
    //
    // O odpowiedz SKRYPTU prosimy zawsze, nawet gdy model o nia nie prosil.
    // ZMIERZONE 16.09 (HA 2026.9): wywolanie skryptu, ktory przerwal sie na
    // `stop ... error: true`, wraca jako HTTP 200 — nie do odroznienia od
    // sukcesu. Tego dnia „pusc utwor X" skonczylo sie meldunkiem „juz gram"
    // przy odtwarzaczu niedostepnym od szesciu godzin. Status HTTP tej prawdy
    // nie niesie, wiec bierzemy jedyny kanal, ktory ja niesie: odpowiedz
    // skryptu. Skrypty maja SupportsResponse.OPTIONAL, wiec pytanie o
    // odpowiedz jest bezpieczne takze dla tych, ktore nic nie zwracaja.
    //
    // `turn_on`/`turn_off`/`toggle`/`reload` to USLUGI domeny `script`, a nie
    // skrypty — one odpowiedzi nie obsluguja i HA odbilby je jako 400.
    const sterujace = new Set(["turn_on", "turn_off", "toggle", "reload"]);
    const chceOdpowiedzi =
      returnResponse || (domain === "script" && !sterujace.has(service));

    const path = chceOdpowiedzi
      ? `/api/services/${domain}/${service}?return_response=true`
      : `/api/services/${domain}/${service}`;

    const result = await this.fetch<unknown>(path, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // Invalidate cache after service call since states may have changed
    this.invalidateCache();

    return result;
  }

  /**
   * Render a Jinja2 template via the HA template API.
   * Returns the rendered plain-text result (HA returns text/plain, not JSON).
   */
  async renderTemplate(template: string): Promise<string> {
    return this.fetchText("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
  }

  /**
   * Get historical states for an entity (not cached - historical data)
   */
  async getHistory(
    entityId: string,
    startTime?: string,
    endTime?: string
  ): Promise<HistoryEntry[]> {
    const start = startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // URL-encode every interpolated value. The `+` in `+HH:MM` tz offsets is
    // otherwise decoded as a space in query strings by aiohttp (HA's HTTP
    // layer), producing "Invalid end_time" 400s for any LLM that includes
    // an explicit timezone offset in its history args.
    let endpoint = `/api/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}`;

    if (endTime) {
      endpoint += `&end_time=${encodeURIComponent(endTime)}`;
    }

    const result = await this.fetch<HistoryEntry[][]>(endpoint);
    return result[0] || [];
  }
}
