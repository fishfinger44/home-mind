# Satelita głosowy — ReSpeaker XVF3800

Kopia konfiguracji ESPHome, która **na żywo mieszka na HAOS** w
`/config/esphome/respeaker-xvf3800-assistant.yaml`. Tutaj jest po to, żeby
miała historię — plik zebrał sporo decyzji, których nie widać z samego kodu,
a obok niego na HAOS leży kilkanaście plików `.bak_*` bez żadnej kolejności.

**To nie jest źródło prawdy.** Edytuje się wersję na HAOS (przez dodatek
ESPHome), a tutaj wrzuca się kopię. Przed edycją warto sprawdzić `diff` —
gdyby ktoś zmienił coś w dodatku z pominięciem repozytorium.

## Wgranie zmiany

Kontener dodatku to `app_5c53de3b_esphome` (nie `addon_…`), a ścieżka wewnątrz
niego to `/config/esphome/…`:

```bash
docker exec app_5c53de3b_esphome esphome config  /config/esphome/respeaker-xvf3800-assistant.yaml
docker exec app_5c53de3b_esphome esphome compile /config/esphome/respeaker-xvf3800-assistant.yaml
docker exec app_5c53de3b_esphome esphome upload  --device respeaker-xvf3800-assistant.local \
    /config/esphome/respeaker-xvf3800-assistant.yaml
```

`--device` jest obowiązkowe — bez niego `upload` pyta interaktywnie i przewraca
się na `EOFError`.

Zły YAML zatrzymuje się na kompilacji i **nie dotyka urządzenia**, więc
sprawdzanie na żywo jest bezpieczne; ryzykowny jest dopiero `upload`.

Dodatek SSH **nie ma SFTP** — `scp` przewraca się na „subsystem request failed".
Pliki przenosi się przez `ssh root@… 'cat > /sciezka' < plik`.

## `components/` — własna kopia komponentu

Od 2026-08-07 `respeaker_xvf3800` i `aic3104` nie są już ciągnięte z
`formatBCE/Respeaker-XVF3800-ESPHome-integration` przez `ref: main`, tylko z
lokalnego katalogu `components/` (na HAOS: `/config/esphome/components/`).
Powód: `relock_beam()` jest naszym dodatkiem, a upstream go nie ma.

**Cena tej decyzji: aktualizacje od formatBCE nie przyjdą już same.** Przy
odświeżaniu trzeba pobrać nowy komponent i ręcznie przenieść do niego jedną
metodę — `relock_beam()` w `.cpp` plus deklarację i pole
`beam_azimuth_captured_` w `.h`.

### Po co `relock_beam()`

`lock_beam()` przypina wiązkę do kierunku, z którego padło słowo budzące, ale
jest wołany **tylko** przy słowie budzącym. Po każdej turze `on_end` uruchamia
`zwolnij_beam_po_rozmowie` (odliczanie 3 s), a `on_listening` następnej tury
robi `script.stop` — co anuluje odliczanie tylko wtedy, gdy jeszcze trwa.
Pomiar z 2026-08-07: między `on_end` a `on_listening` mija **4–7 s**, więc
odliczanie wygrywało zawsze i przypięta była wyłącznie pierwsza tura. Cała
reszta rozmowy szła mikrofonem dookólnym — stąd wchodzące w rozmowę obce głosy.

`relock_beam()` włącza z powrotem same stałe wiązki (`AEC_FIXEDBEAMS_ONOFF`=1)
na azymucie **już zapisanym w DSP**: `unlock_beam()` czyści wyłącznie flagę
on/off i zostawia rejestr 81 nietknięty. Dlatego kierunek z chwili słowa
budzącego wraca bez czytania bieżącego — a czytanie bieżącego jest tu właśnie
błędem, bo tuż po TTS wskazuje najgłośniejsze źródło, czyli potencjalnie *od*
rozmówcy. Z tego samego powodu w `on_listening` **nie wolno** wołać
`lock_beam()`.

Podgląd tylko z logów urządzenia — sensor kierunku (`led_beam_sensor`) jest
`internal: true`, więc w HA go nie ma. API satelity (192.168.88.127:6053) jest
bez szyfrowania, więc wystarczy `aioesphomeapi` i `subscribe_logs`; szukać
`Beam locked at …`, `Beam re-locked …`, `Beam lock released`.
