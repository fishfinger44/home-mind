# Shim rozmowny — Claude z abonamentu dla Home Minda

Most między Home Mindem a `claude -p`. Obsługuje **tylko rozmowę** — żarty,
zagadki, pogawędkę, wiedzę ogólną. Komendy domowe zostają na Gemini i 1,2 s.

## Dlaczego to stoi na hoście, a nie w kontenerze

Poświadczenia abonamentu (`~/.claude.json`, login OAuth) leżą na hoście i **nie
mają czego szukać w kontenerze**. `home-mind-server` ma `network_mode: host`,
więc sięga po `127.0.0.1:8765` bez montowania czegokolwiek.

## Uruchamianie

Chodzi jako usługa użytkownika:

```sh
systemctl --user status rozmowa-shim
systemctl --user restart rozmowa-shim
journalctl --user -u rozmowa-shim -f
```

🔴 **Jedno polecenie z rootem, bez którego NIE wstanie po restarcie maszyny:**

```sh
sudo loginctl enable-linger lech
```

Bez lingera usługi użytkownika startują dopiero przy pierwszym zalogowaniu.
Sprawdzenie: `loginctl show-user lech | grep Linger` ma pokazać `Linger=yes`.

## Panel w Home Assistant

Wszystko, co się przestawia na co dzień, siedzi na urządzeniu **Home Mind**:

| encja | co robi |
|---|---|
| `switch.home_mind_rozmowa_przez_abonament` | czy tury w ogóle idą na tę ścieżkę |
| `select.home_mind_model_rozmowy` | który model odpowiada |
| `select.home_mind_wysilek_rozmowy` | `--effort` |

Wszystkie trzy działają **bez restartu** — od następnej tury.

🔴 **Encje mają `entity_category: CONFIG`, więc HA NIE pokazuje ich na
automatycznym pulpicie Przegląd.** Szukać w Ustawienia → Urządzenia i usługi →
Home Mind → urządzenie „Home Mind". Do własnego pulpitu dodają się normalnie;
ukrywanie dotyczy wyłącznie auto-Przeglądu. (Ta pozycja jest tu dlatego, że
przełącznik raz już „zniknął" i szukaliśmy go w kodzie zamiast w UI.)

Rozdział ról jest celowy:
* `ROZMOWA_URL` w `.env` — **infrastruktura** (gdzie stoi shim). Zmiana wymaga
  restartu kontenera serwera.
* encje w HA — **preferencje**, zapisywane w `/data/llm-override.json`.

Bez `ROZMOWA_URL` wszystkie trzy pokazują się jako **niedostępne**, zamiast
udawać, że coś robią.

## Lista modeli — jedno źródło, ten plik

🔑 **`MODELE` w `shim.py` jest ŹRÓDŁEM PRAWDY.** Shim wystawia je przez
`GET /modele`, serwer podaje dalej w `GET /api/config/rozmowa`, a HA tylko
wypełnia listę wyboru. **Dodanie modelu to jedna linijka tutaj i nic więcej.**

Powód, dla którego nie ma tej listy w trzech miejscach: tylko shim wie, co
`claude` na tym hoście przyjmie. Przy kopii w HA dałoby się wybrać model, który
padnie dopiero przy pierwszym pytaniu — czyli objaw daleko od przyczyny.

`effort` w tej mapie mówi, czy model zna flagę `--effort`. ⛔ Haiku 4.5 jej nie
ma. Shim **zdejmuje flagę sam**, a lista wysiłku pokazuje się wtedy w HA jako
niedostępna — bo przy dwóch osobnych gałkach kombinacja „Haiku + medium" jest
nieunikniona i ma być brakiem ustawienia, a nie awarią rozmowy.

## Nastawy (zmienne środowiskowe)

⚠️ `ROZMOWA_MODEL` i `ROZMOWA_EFFORT` to już tylko **domyślne**, używane dopóki
nikt nie wybrał modelu w HA. Wybór z panelu jedzie **w żądaniu** i je przykrywa.
⛔ Wpisanie ich do `.env` **Home Minda** nic nie da — to zmienne shima, czyli
usługi użytkownika na hoście; serwer celowo ich nie czyta.

| zmienna | domyślnie | uwaga |
|---|---|---|
| `ROZMOWA_MODEL` | `claude-sonnet-5` | ⛔ Haiku 4.5 wypadł gorzej: 6–14 s i słabsza polszczyzna |
| `ROZMOWA_EFFORT` | `low` | dla modeli bez `--effort` zdejmowane automatycznie |
| `ROZMOWA_TIMEOUT` | `20` | zmierzone odpowiedzi: 4,5–8,2 s |
| `ROZMOWA_PORT` | `8765` | |

🔬 Zmierzone przez HA 14.08 (poza Sonnetem pojedyncze próby): Sonnet 5 **5,8 s**
· Opus 5 6,8 s · Fable 5 9,9 s · Haiku 4.5 10,3 s.

## Pułapki, każda zmierzona

* 🔴 **`claude -p` wciąga kontekst z katalogu roboczego.** Shim odpalony
  w `~/home-mind/rozmowa-shim` doklejał do każdej domowej pogawędki
  `~/home-mind/CLAUDE.md` — **25 687 bajtów** dokumentacji. Dlatego podprocesowi
  ustawiamy katalog neutralny **poza drzewem projektu** (`CLAUDE.md` szuka się
  też w katalogach nadrzędnych, więc podkatalog projektu nic by nie dał).
* 🔴 **`--disallowed-tools` jest wariadyczne** i połyka pozycyjny prompt
  („Input must be provided…"). Pytanie idzie przez **stdin**.
* 🔴 **`Restart=always`, nie `on-failure`** — przy `on-failure` czyste zabicie
  procesu jest dla systemd poprawnym zakończeniem i usługa zostaje `inactive`,
  a przełącznik w HA dalej pokazuje „włączony". Cicha awaria.
* 🔴 **`PATH` w jednostce systemd musi zawierać `~/.local/bin`** — tam leży
  `claude`. Bez tego shim wstaje, `/zdrowie` odpowiada, a dopiero pierwsze
  pytanie zwraca „nie znaleziono polecenia `claude`".
* ⚠️ **Myślenia nie wyłączamy.** Przy `thinking: disabled` model potrafi wypisać
  wywołanie narzędzia jako zwykły tekst. `effort: low` daje szybkość bez tego.
* ⚠️ Szukając procesu **nie używać `pkill -f shim.py`** — wzorzec łapie własną
  powłokę. Po PID, i sprawdzić, czy to na pewno `python3 shim.py`, a nie
  otoczka `nohup`.
