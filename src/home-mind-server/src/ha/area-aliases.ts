import { WebSocket } from "undici";

/**
 * Aliasy obszarów z rejestru Home Assistanta.
 *
 * 🔴 Po co, zapłacone w domu 20.08.2026: „zamknij rolety w salonie do połowy"
 * nie robiło NIC przez trzy tury, a „zamknij lewą i prawą" zadziałało od razu.
 * Obszar nazywa się `Living Room`, encje „Roleta lewa" i „Roleta prawa" —
 * słowa „salon" nie ma ani w nazwie obszaru, ani w nazwach encji. Model widział
 * angielską nazwę i nie miał jak skojarzyć.
 *
 * 🔑 Aliasy w Home Assistancie są ustawione i poprawne (`Living Room` →
 * `salon`, `salonie`), tylko nigdy nie docierały do promptu.
 *
 * ⛔ Nie da się ich wziąć taniej. Sprawdzone: w szablonach NIE MA `area_aliases`
 * (`UndefinedError`), a `/api/config/area_registry/list` i `/api/areas` zwracają
 * 404 — rejestr obszarów żyje wyłącznie na WebSockecie.
 *
 * ⛔ NIE opierać się na identyfikatorach obszarów, choć bywają polskie: w tym
 * domu `kuchnia` to **Dining Room** (jadalnia), a prawdziwa kuchnia ma id
 * `kitchen`. Identyfikator jest historyczny i potrafi kłamać; alias nie.
 *
 * WebSocket bierzemy z `undici`, które i tak jest w zależnościach — obraz stoi
 * na Node 20, gdzie globalnego `WebSocket` jeszcze nie ma.
 */
export async function pobierzAliasyObszarow(
  baseUrl: string,
  token: string,
  timeoutMs = 8000
): Promise<Map<string, string[]>> {
  const url = baseUrl.replace(/^http/, "ws") + "/api/websocket";

  return await new Promise<Map<string, string[]>>((resolve, reject) => {
    const ws = new WebSocket(url);
    const stoper = setTimeout(() => {
      ws.close();
      reject(new Error(`rejestr obszarów nie odpowiedział w ${timeoutMs} ms`));
    }, timeoutMs);

    const koniec = (blad: Error | null, wynik?: Map<string, string[]>) => {
      clearTimeout(stoper);
      try {
        ws.close();
      } catch {
        /* zamknięcie i tak nastąpi przy błędzie połączenia */
      }
      if (blad) reject(blad);
      else resolve(wynik!);
    };

    ws.addEventListener("error", () => koniec(new Error("błąd połączenia WebSocket z HA")));

    ws.addEventListener("message", (ev) => {
      let wiad: { type?: string; id?: number; result?: unknown };
      try {
        wiad = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (wiad.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }
      if (wiad.type === "auth_invalid") {
        koniec(new Error("HA odrzuciło token przy WebSockecie"));
        return;
      }
      if (wiad.type === "auth_ok") {
        ws.send(JSON.stringify({ id: 1, type: "config/area_registry/list" }));
        return;
      }
      if (wiad.type === "result" && wiad.id === 1) {
        const mapa = new Map<string, string[]>();
        for (const o of (wiad.result ?? []) as { area_id?: string; aliases?: string[] }[]) {
          const aliasy = (o.aliases ?? []).filter((a) => typeof a === "string" && a.trim());
          if (o.area_id && aliasy.length > 0) mapa.set(o.area_id, aliasy);
        }
        koniec(null, mapa);
      }
    });
  });
}

/**
 * Aliasy warte pokazania modelowi: bez powtórzeń różniących się tylko
 * wielkością liter i bez tych, które i tak są w nazwie obszaru. „Living Room
 * (salon, salonie)" niesie informację; „(Salon, salon)" to tylko tokeny.
 */
export function przytnijAliasy(nazwaObszaru: string, aliasy: string[]): string[] {
  const widziane = new Set<string>([nazwaObszaru.toLowerCase()]);
  const wynik: string[] = [];
  for (const a of aliasy) {
    const klucz = a.toLowerCase();
    if (widziane.has(klucz)) continue;
    widziane.add(klucz);
    wynik.push(a);
  }
  return wynik;
}
