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
