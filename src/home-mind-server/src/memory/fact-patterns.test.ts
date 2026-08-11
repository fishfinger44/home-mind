import { describe, it, expect } from "vitest";

import { filterFacts, matchesGarbagePattern, SERVICE_PROCEDURE_REASON } from "./fact-patterns.js";

/**
 * Ekstraktor pisze po polsku od 11.08.2026, a filtry były angielskie.
 *
 * Ten plik istnieje głównie po to, żeby ta ślepota nie wróciła po cichu:
 * regexy, które przestały cokolwiek łapać, nie rzucają błędu — po prostu
 * wpuszczają śmieci, a to widać dopiero po tygodniu, po zawartości pamięci.
 */
describe("filtr smieci — po polsku", () => {
  it("odrzuca stan chwilowy", () => {
    for (const tresc of [
      "Światło w kuchni świeci teraz na czerwono",
      "Czujnik pokazuje obecnie 22 stopnie",
      "Roleta w salonie jest aktualnie zamknięta",
      "Klimatyzacja chwilowo nie działa",
      "W tej chwili w domu jest 19 stopni",
    ]) {
      expect(matchesGarbagePattern(tresc), tresc).toBe("transient state pattern");
    }
  });

  it("odrzuca zrzut moznosci urzadzenia", () => {
    for (const tresc of [
      "light.led_strip obsługuje tryby RGBW i color_temp",
      "Lampa w jadalni wspiera tryb color_temp",
      "Lista efektów tej taśmy ma 60 pozycji",
    ]) {
      expect(matchesGarbagePattern(tresc), tresc).toBe("device spec/capability dump");
    }
  });

  it("odrzuca echo wykonanego polecenia", () => {
    for (const tresc of [
      "Ustawiono jasność światła w salonie na 30 procent",
      "Roleta została zamknięta do końca",
      "Włączono klimatyzację na 27 stopni",
      "Światło w kuchni zostało zgaszone",
    ]) {
      expect(matchesGarbagePattern(tresc), tresc).toBe("command echo (restating action)");
    }
  });

  it("odrzuca procedure wywolania uslugi", () => {
    expect(matchesGarbagePattern("Muzykę graj przez wywołaj media_player.play_media")).toBe(
      SERVICE_PROCEDURE_REASON
    );
  });

  /**
   * Druga połowa roboty: filtr, który zjada dobre fakty, jest gorszy od
   * żadnego, bo strata jest cicha. To są prawdziwe fakty z tego domu.
   */
  it("przepuszcza prawdziwe polskie fakty", () => {
    for (const tresc of [
      "Użytkownik ma na imię Lech",
      "Lech nie pije kawy po godzinie 18:00",
      "Lech woli ciepłe światło w salonie",
      "Lech woli, żeby muzyka grała cicho",
      "Lech lubi pierogi z soczewicą",
      "Pies Chojrak urodził się w 2011 roku",
      "Pies Chojrak nie jest psem myśliwskim",
      "Syn Władek urodził się 19 listopada 2021",
      "Syn Tadeusz urodził się 9 marca 2026",
      "Partnerka Lecha nazywa się Zuza",
      "Najbliższe przystanki linii 111 to Waniliowa lub Cynamonowa",
      "Cisy w ogrodzie sąsiada mierzyły 30 cm w sierpniu 2026",
      "Główne światło w kuchni to light.wled_kitchen",
    ]) {
      expect(matchesGarbagePattern(tresc), tresc).toBeNull();
    }
  });

  it("nie myli czynnosci czlowieka z echem asystenta", () => {
    // „ustawil"/„wlaczyl" same w sobie opisuja czlowieka, nie asystenta.
    expect(matchesGarbagePattern("Lech włączył ogrzewanie podłogowe w 2024 roku")).toBeNull();
  });

  it("lapie te same wzorce bez polskich znakow — STT je gubi", () => {
    expect(matchesGarbagePattern("Swiatlo w kuchni swieci teraz na czerwono")).toBe(
      "transient state pattern"
    );
    expect(matchesGarbagePattern("Roleta zostala zamknieta do konca")).toBe(
      "command echo (restating action)"
    );
  });

  it("nadal rozumie angielskie zaszlosci", () => {
    expect(matchesGarbagePattern("Kitchen light is currently displaying red")).toBe(
      "transient state pattern"
    );
    expect(matchesGarbagePattern("User does not drink coffee after 18:00")).toBeNull();
  });

  it("dzieli fakty na przyjete i odrzucone z powodem", () => {
    const { kept, skipped } = filterFacts([
      { content: "Lech woli ciepłe światło w salonie" },
      { content: "Ustawiono jasność na 30 procent" },
    ]);
    expect(kept).toHaveLength(1);
    expect(skipped[0].reason).toBe("command echo (restating action)");
  });
});
