/**
 * Panel i API planowania tras.
 *
 * Trzymane osobno od glownego routera z tego samego powodu co reguly: te
 * koncowki obsluguja czlowieka przy panelu, a nie asystenta.
 *
 * Klucz WCHODZI, ale nigdy nie WYCHODZI - odczyt mowi tylko, czy jakis jest i
 * skad pochodzi. Panel stoi w pasku HA na otwartym LAN-ie, wiec oddawanie
 * klucza przez GET zamienialoby wygode w wyciek.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { PANEL_HTML } from "./editor.js";
import { zaplanujTrase } from "./klient.js";
import {
  ileWariantow,
  limitDzienny,
  miejsca,
  zapiszUstawienia,
  zrodloKlucza,
  zrodloMiejsc,
} from "./ustawienia.js";
import { zuzyteDzis } from "./uzycie.js";

const ZapisSchema = z.object({
  /** Pusty napis = skasuj nadpisanie i wroc do klucza z .env. */
  klucz: z.string().optional(),
  miejsca: z.record(z.string()).optional(),
  limitDzienny: z.coerce.number().int().min(0).optional(),
  ileWariantow: z.coerce.number().int().min(1).max(5).optional(),
});

const ProbaSchema = z.object({
  dokad: z.string().min(1),
  skad: z.string().optional(),
  kiedy: z.string().optional(),
  kiedy_znaczy: z.enum(["wyjazd", "przyjazd"]).optional(),
});

function stan() {
  const limit = limitDzienny();
  const zuzyte = zuzyteDzis();
  return {
    maKlucz: zrodloKlucza() !== "brak",
    zrodloKlucza: zrodloKlucza(),
    miejsca: miejsca(),
    zrodloMiejsc: zrodloMiejsc(),
    limitDzienny: limit,
    ileWariantow: ileWariantow(),
    zuzyteDzis: zuzyte,
    zostaloDzis: Math.max(0, limit - zuzyte),
    /** Bez adresu domu kazde pytanie bez "skad" konczy sie dopytaniem. */
    maDom: Boolean(miejsca()["dom"] ?? miejsca()["Dom"]),
  };
}

export function createTrasyRouter(): Router {
  const router = Router();

  router.get("/trasy", (_req: Request, res: Response) => {
    res.json(stan());
  });

  router.put("/trasy", (req: Request, res: Response) => {
    const parsed = ZapisSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
    }
    zapiszUstawienia(parsed.data);
    console.log(
      `[trasy] ustawienia zapisane - klucz: ${zrodloKlucza()}, miejsc: ${Object.keys(miejsca()).length},` +
        ` limit: ${limitDzienny()}/dobe`
    );
    res.json(stan());
  });

  /**
   * Zapytanie probne z panelu. Kosztuje DOKLADNIE TYLE SAMO co pytanie zadane
   * glosem - jedno wywolanie Routes API i jeden punkt dziennego licznika.
   * Panel mowi o tym wprost, zeby klikanie "sprawdz" nie zjadalo limitu po cichu.
   */
  router.post("/trasy/sprawdz", async (req: Request, res: Response) => {
    const parsed = ProbaSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Podaj przynajmniej 'dokad'." });
    }
    const wynik = await zaplanujTrase({
      dokad: parsed.data.dokad,
      skad: parsed.data.skad,
      kiedy: parsed.data.kiedy,
      kiedyZnaczy: parsed.data.kiedy_znaczy ?? "wyjazd",
    });
    res.json({ wynik, stan: stan() });
  });

  return router;
}

/** Sama strona, poza /api, zeby pasek HA mial pod co podstawic ramke. */
export function createTrasyPage(): Router {
  const router = Router();
  router.get("/trasy", (_req: Request, res: Response) => {
    res.type("html").send(PANEL_HTML);
  });
  return router;
}
