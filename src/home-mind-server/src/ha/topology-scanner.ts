import type { HomeAssistantClient } from "./client.js";
import { pobierzAliasyObszarow, przytnijAliasy } from "./area-aliases.js";

/**
 * Single Jinja2 template that returns the full home layout as JSON in one call.
 * Uses HA template functions: floors(), floor_name(), floor_areas(),
 * area_name(), area_entities(), areas(), area_floor_id().
 * All available since HA 2024.4.
 */
const LAYOUT_TEMPLATE = `
{%- set ns = namespace(floors=[], assigned=[]) -%}
{%- for fid in floors() -%}
  {%- set ans = namespace(areas=[]) -%}
  {%- for aid in floor_areas(fid) -%}
    {%- set ens = namespace(items=[]) -%}
    {%- for e in area_entities(aid) -%}
      {%- set ens.items = ens.items + [{"id": e, "name": state_attr(e, "friendly_name")}] -%}
    {%- endfor -%}
    {%- set ans.areas = ans.areas + [{"id": aid, "name": area_name(aid), "entities": ens.items}] -%}
    {%- set ns.assigned = ns.assigned + [aid] -%}
  {%- endfor -%}
  {%- set ns.floors = ns.floors + [{"id": fid, "name": floor_name(fid), "areas": ans.areas}] -%}
{%- endfor -%}
{%- set orphans = namespace(areas=[]) -%}
{%- for aid in areas() -%}
  {%- if aid not in ns.assigned -%}
    {%- set ens = namespace(items=[]) -%}
    {%- for e in area_entities(aid) -%}
      {%- set ens.items = ens.items + [{"id": e, "name": state_attr(e, "friendly_name")}] -%}
    {%- endfor -%}
    {%- set orphans.areas = orphans.areas + [{"id": aid, "name": area_name(aid), "entities": ens.items}] -%}
  {%- endif -%}
{%- endfor -%}
{{ {"floors": ns.floors, "unassigned": orphans.areas} | tojson }}
`.trim();

/**
 * Nazwa encji, nie tylko jej identyfikator.
 *
 * 🔴 Powód z 18.08.2026, zapłacony w domu: model dostawał WYŁĄCZNIE
 * identyfikatory, więc widząc `media_player.denon`, `media_player.denon_2`
 * i `media_player.denon_avr_x2400h` nie miał jak zgadnąć, że muzyka gra na
 * trzeciej. Przez kilka tur zatrzymywał martwą encję HEOS i uczciwie meldował,
 * że nic z tego nie wyszło. Nazwy („Denon radio", „Denon wejścia",
 * „Denon muzyka") są w Home Assistancie od dawna — po prostu nigdy nie
 * docierały do promptu.
 */
interface EntityRef {
  id: string;
  /** `friendly_name`; `null`, gdy encja nie istnieje albo go nie ma. */
  name: string | null;
}

interface AreaData {
  id: string;
  name: string;
  entities: EntityRef[];
  /** Jak ten pokój nazywa domownik — dopisywane po skanie, patrz `area-aliases.ts`. */
  aliases?: string[];
}

interface FloorData {
  id: string;
  name: string;
  areas: AreaData[];
}

interface LayoutData {
  floors: FloorData[];
  unassigned: AreaData[];
}

/**
 * Scans the Home Assistant home layout (floors → rooms → entities) via the
 * template API and injects it into every system prompt. This gives the LLM
 * spatial awareness without tool calls — it knows which floor/room a device
 * belongs to before reasoning begins.
 *
 * Uses POST /api/template with a single Jinja2 query (no registry REST
 * endpoints needed, works on all HA versions with template support).
 *
 * Runs at startup and refreshes every scanIntervalMs.
 */
export class TopologyScanner {
  private ha: HomeAssistantClient;
  private lastScanTime: number = 0;
  private readonly scanIntervalMs: number;
  private layoutData: LayoutData | null = null;

  constructor(ha: HomeAssistantClient, scanIntervalMs = 30 * 60 * 1000) {
    this.ha = ha;
    this.scanIntervalMs = scanIntervalMs;
  }

  async scan(): Promise<void> {
    try {
      const raw = await this.ha.renderTemplate(LAYOUT_TEMPLATE);
      const data = JSON.parse(raw.trim()) as LayoutData;
      // Aliasy dokładamy PO ułożeniu topologii i osobnym kanałem, bo rejestr
      // obszarów żyje tylko na WebSockecie. Gdy się nie uda — layout zostaje
      // bez nich, czyli dokładnie tak, jak działał do 20.08.
      try {
        const aliasy = await pobierzAliasyObszarow(this.ha.adres, this.ha.poswiadczenie);
        let opisane = 0;
        for (const area of [...data.floors.flatMap((f) => f.areas), ...data.unassigned]) {
          const dla = aliasy.get(area.id);
          if (!dla) continue;
          const przyciete = przytnijAliasy(area.name, dla);
          if (przyciete.length > 0) {
            area.aliases = przyciete;
            opisane++;
          }
        }
        console.log(`[topology] Aliasy obszarow: ${opisane} pokoi opisanych po polsku`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[topology] Aliasy obszarow niedostepne (${msg}) — layout bez nich`);
      }

      this.layoutData = data;
      this.lastScanTime = Date.now();

      const floorCount = data.floors.length;
      const areaCount = data.floors.reduce((n, f) => n + f.areas.length, 0) + data.unassigned.length;
      console.log(`[topology] Scanned home layout: ${floorCount} floors, ${areaCount} areas`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[topology] Scan failed — home layout unavailable: ${msg}`);
      // Keep previous layout if scan fails
    }
  }

  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastScanTime > this.scanIntervalMs) {
      await this.scan();
    }
  }

  hasLayout(): boolean {
    return this.layoutData !== null;
  }

  /**
   * Render the layout. When *exposed* is given, only entities in that set are
   * shown — so the LLM prompt carries only the entities the user exposed to
   * Assist in Home Assistant, not every entity in the home.
   */
  formatSection(exposed?: Set<string>): string {
    return this.layoutData ? this.buildLayout(this.layoutData, exposed) : "";
  }

  private buildLayout(data: LayoutData, exposed?: Set<string>): string {
    const entitiesOf = (area: AreaData): EntityRef[] =>
      exposed ? area.entities.filter((e) => exposed.has(e.id)) : area.entities;
    // Check if there's anything useful to show
    const hasFloors = data.floors.some((f) => f.areas.length > 0);
    const hasOrphans = data.unassigned.length > 0;
    if (!hasFloors && !hasOrphans) return "";

    const lines: string[] = [
      "## Home Layout (auto-detected from Home Assistant)",
      "",
      "Use this to know which floor/room a device belongs to — never assume locations.",
      "",
    ];

    for (const floor of data.floors) {
      if (floor.areas.length === 0) continue;
      lines.push(`**${floor.name}**`);
      for (const area of floor.areas.sort((a, b) => a.name.localeCompare(b.name))) {
        const ents = entitiesOf(area);
        if (ents.length === 0) continue;
        lines.push(`- ${nazwaObszaru(area)}: ${formatEntities(ents)}`);
      }
      lines.push("");
    }

    if (data.unassigned.length > 0) {
      lines.push("**Other rooms (no floor assigned)**");
      for (const area of data.unassigned.sort((a, b) => a.name.localeCompare(b.name))) {
        const ents = entitiesOf(area);
        if (ents.length === 0) continue;
        lines.push(`- ${nazwaObszaru(area)}: ${formatEntities(ents)}`);
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }
}

/**
 * Nazwę dokładamy tylko wtedy, gdy NIE wynika z identyfikatora.
 *
 * `light.lampa_w_kuchni` „Lampa w kuchni" nie wnosi nic i kosztowałoby miejsce
 * w prompcie przy każdej turze; `media_player.denon_avr_x2400h` „Denon muzyka"
 * jest różnicą między zatrzymaniem muzyki a zatrzymaniem niczego.
 */
/**
 * „Living Room (salon, salonie)" — nazwa systemowa plus to, jak pokój nazywa
 * domownik. Bez tego model dostaje samą angielską nazwę i polecenie „w salonie"
 * nie ma się o co zaczepić.
 */
function nazwaObszaru(area: AreaData): string {
  return area.aliases?.length ? `${area.name} (${area.aliases.join(", ")})` : area.name;
}

function formatEntities(ents: EntityRef[]): string {
  return ents
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => (e.name && !nazwaWynikaZId(e.id, e.name) ? `${e.id} "${e.name}"` : e.id))
    .join(", ");
}

function nazwaWynikaZId(id: string, nazwa: string): boolean {
  const uprosc = (t: string) =>
    t
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\u0142/g, "l")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  return uprosc(id.split(".").slice(1).join(".")) === uprosc(nazwa);
}
