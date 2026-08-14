import { describe, expect, it } from "vitest";
import { zdecyduj, znormalizuj } from "./router-rozmowy.js";

const BEZ_KONTEKSTU = { poprzedniaNaRozmowie: false, asystentPytal: false };

describe("router rozmowy", () => {
  describe("🔴 komenda NIGDY nie moze trafic na sciezke bez narzedzi", () => {
    // To jest jedyna awaria, ktora ten router moze spowodowac: polecenie
    // wyslane na sciezke rozmowna sie NIE WYKONA, a czlowiek uslyszy gladka
    // odpowiedz i nie dowie sie, ze nic sie nie stalo.
    it.each([
      "zgas swiatlo w salonie",
      "Zgaś światło w salonie",
      "otworz rolety",
      "ustaw temperature na 21 stopni",
      "wlacz muzyke",
      "jaka jest temperatura w sypialni",
      "przypomnij mi o spotkaniu",
      "kiedy jedzie najblizszy autobus",
    ])("%s → stara droga", (wypowiedz) => {
      expect(zdecyduj(wypowiedz, BEZ_KONTEKSTU).naRozmowe).toBe(false);
    });

    it("weto podnosi flage odbierajaca modelowi narzedzie rozmowne", () => {
      // Sam opis narzedzia okazal sie prosba, nie bariera: 14.08 model mimo
      // niego skierowal na rozmowe „opowiedz zart i sprawdz czy okno w salonie
      // jest zamkniete" i okno nie zostalo sprawdzone. Ta flaga zdejmuje
      // narzedzie z tury, wiec nie ma czym zlamac zasady.
      expect(
        zdecyduj("opowiedz zart i sprawdz czy okno w salonie jest zamkniete", BEZ_KONTEKSTU)
          .wetoDomowe
      ).toBe(true);
    });

    it("czysta rozmowa NIE odbiera narzedzia", () => {
      expect(zdecyduj("opowiedz zart", BEZ_KONTEKSTU).wetoDomowe).toBe(false);
      expect(zdecyduj("a tak w ogole to co myslisz", BEZ_KONTEKSTU).wetoDomowe).toBe(false);
    });

    it("weto bije wzorzec rozmowy w wypowiedzi mieszanej", () => {
      // Ta zasada jest juz w opisie narzedzia `odpowiedz_rozmowa` ("dom jest
      // wazniejszy niz zart") i router nie ma prawa jej obchodzic.
      const d = zdecyduj("opowiedz zart i zgas swiatlo", BEZ_KONTEKSTU);
      expect(d.naRozmowe).toBe(false);
      expect(d.powod).toContain("weto");
    });
  });

  describe("skraca to, co w zmierzonej rozmowie przepalalo 4-6 s", () => {
    it.each([
      "Powiedz jakis fajny zart",
      "A powiedz mi jakis zart o ramce",
      "zadaj mi zagadke",
      "opowiedz ciekawostke",
      "powiedz cos smiesznego",
    ])("%s → wprost na rozmowe", (wypowiedz) => {
      expect(zdecyduj(wypowiedz, BEZ_KONTEKSTU).naRozmowe).toBe(true);
    });

    it("dziala mimo braku ogonkow w transkrypcji", () => {
      // STT bywa bez polskich znakow; lista wzorcow dzialajaca tylko dla
      // poprawnej polszczyzny cicho przestalaby lapac wlasnie te wypowiedzi.
      expect(zdecyduj("opowiedz zart", BEZ_KONTEKSTU).naRozmowe).toBe(true);
      expect(zdecyduj("opowiedz żart", BEZ_KONTEKSTU).naRozmowe).toBe(true);
    });
  });

  describe("tura zanieczyszczona obcym glosem", () => {
    it("NIE jest ratowana przez router — i tak ma byc", () => {
      // Prawdziwa wypowiedz z testu 14.08: ogon „kup buty z nimi" pochodzil
      // z tla. Router go nie odsiewa, bo nie umie odroznic sladu obcego glosu
      // od prawdziwej prosby o zakupy — a zgadywanie tutaj znaczyloby
      // polykanie poleceń. Od wykrywania takich tur jest biometria.
      const d = zdecyduj(
        "Dobra dzieki. Powiedz moze jakis zart dla niego Radziu i kup buty z nimi",
        BEZ_KONTEKSTU
      );
      expect(d.naRozmowe).toBe(false);
      expect(d.powod).toContain("kup");
    });
  });

  describe("kontynuacja rozmowy", () => {
    const PO_ZAGADCE = { poprzedniaNaRozmowie: true, asystentPytal: true };

    it("krotka odpowiedz po pytaniu asystenta zostaje na rozmowie", () => {
      expect(zdecyduj("nie wiem", PO_ZAGADCE).naRozmowe).toBe(true);
    });

    it("🔴 NIE dziala, gdy poprzednia tura NIE byla rozmowna", () => {
      // Bez tego warunku „tak" po pytaniu „czy zgasic swiatlo w salonie?"
      // poszloby na sciezke bez narzedzi i swiatlo nigdy by nie zgaslo.
      expect(
        zdecyduj("tak", { poprzedniaNaRozmowie: false, asystentPytal: true }).naRozmowe
      ).toBe(false);
    });

    it("nie dziala, gdy asystent nie zadal pytania", () => {
      expect(
        zdecyduj("nie wiem", { poprzedniaNaRozmowie: true, asystentPytal: false }).naRozmowe
      ).toBe(false);
    });

    it("weto obowiazuje takze w kontynuacji", () => {
      expect(zdecyduj("tak, zgas swiatlo", PO_ZAGADCE).naRozmowe).toBe(false);
    });

    it("dluga wypowiedz nie jest juz odpowiedzia na pytanie", () => {
      expect(
        zdecyduj(
          "a wiesz co jeszcze mnie zastanawia od dluzszego czasu w tej sprawie",
          PO_ZAGADCE
        ).naRozmowe
      ).toBe(false);
    });
  });

  it("pusta wypowiedz idzie stara droga", () => {
    expect(zdecyduj("   ", BEZ_KONTEKSTU).naRozmowe).toBe(false);
  });

  it("znormalizuj zdejmuje ogonki i wielkosc liter", () => {
    expect(znormalizuj("ZGAŚ Światło  W Salonie")).toBe("zgas swiatlo w salonie");
    expect(znormalizuj("żółć łódź")).toBe("zolc lodz");
  });
});
