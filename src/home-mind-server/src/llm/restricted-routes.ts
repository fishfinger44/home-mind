/**
 * Reading and changing which devices need a recognised voice.
 *
 * Served by the assistant because it is the assistant that enforces them, but
 * edited from the voice panel: enrolling someone and deciding what enrolment is
 * worth are one decision, and separating them would leave a voiceprint with no
 * visible purpose.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import {
  GRUPY_URZADZEN,
  wczytajOgraniczenia,
  zapiszOgraniczenia,
} from "./restricted.js";

const ZapisSchema = z.object({
  grupy: z.array(z.string()),
  wolnoZatrzymywac: z.boolean().optional().default(true),
  /** Per person, the groups taken away from them. Absent = nothing taken away. */
  osoby: z.record(z.string(), z.array(z.string())).optional().default({}),
});

/** The catalogue plus the current choice, so the panel needs no copy of either. */
function widok() {
  const ustawienia = wczytajOgraniczenia();
  return {
    grupy: GRUPY_URZADZEN.map((g) => ({
      id: g.id,
      nazwa: g.nazwa,
      opis: g.opis,
      ograniczona: ustawienia.grupy.includes(g.id),
      // The panel draws a per-person tick box for every group, not only the
      // restricted ones: taking the music away from a child is a reasonable
      // thing to want, and it has nothing to do with what a stranger may do.
      bezUlgi: !!g.bezUlgi,
    })),
    wolnoZatrzymywac: ustawienia.wolnoZatrzymywac,
    osoby: ustawienia.osoby,
  };
}

export function createRestrictionsRouter(): Router {
  const router = Router();

  router.get("/ograniczenia", (_req: Request, res: Response) => {
    res.json(widok());
  });

  router.put("/ograniczenia", (req: Request, res: Response) => {
    const parsed = ZapisSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
    }
    zapiszOgraniczenia(parsed.data);
    res.json(widok());
  });

  return router;
}
