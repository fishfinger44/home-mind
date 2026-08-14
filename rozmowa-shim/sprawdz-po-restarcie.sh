#!/usr/bin/env bash
# Kontrola po restarcie maszyny — czy wszystko, co ma wstać samo, wstało.
#
# Po co osobny skrypt: kazda z tych rzeczy potrafi nie wrocic po cichu.
# Kontener bez polityki restartu, usluga uzytkownika bez lingera, maszyna
# wirtualna bez autostartu — w kazdym z tych przypadkow dom dziala "prawie",
# a usterke widac dopiero, gdy sie o cos zapyta.
#
#     ~/home-mind/rozmowa-shim/sprawdz-po-restarcie.sh

set -uo pipefail
BLEDY=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
zle()  { printf '  \033[31m✗\033[0m %s\n' "$1"; BLEDY=$((BLEDY+1)); }

echo "=== 1. Shim rozmowny (usluga uzytkownika) ==="
[ "$(systemctl --user is-active rozmowa-shim 2>/dev/null)" = "active" ] \
  && ok "usluga dziala" || zle "usluga NIE dziala — systemctl --user status rozmowa-shim"
loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes" \
  && ok "linger wlaczony (przezyje kolejny reboot)" \
  || zle "Linger=no — po nastepnym restarcie usluga NIE wstanie: sudo loginctl enable-linger $USER"
# Port musi trzymac proces zarzadzany przez systemd, a nie sierota po recznym
# uruchomieniu — to juz raz mylilo diagnoze.
PID_USLUGI=$(systemctl --user show -p MainPID --value rozmowa-shim 2>/dev/null)
# ⚠️ Filtrowac NAJPIERW po porcie. Pierwsza wersja brala pierwszy pid z calego
# `ss`, wiec zglaszala "obcy proces", pokazujac PID zupelnie innej uslugi.
PID_PORTU=$(ss -ltnp 2>/dev/null | grep -E '127\.0\.0\.1:8765 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
if [ -n "$PID_USLUGI" ] && [ "$PID_USLUGI" = "${PID_PORTU:-}" ]; then
  ok "port 8765 trzyma proces uslugi (PID $PID_USLUGI)"
else
  ss -ltnp 2>/dev/null | grep -q 8765 \
    && zle "port 8765 trzyma OBCY proces (usluga: ${PID_USLUGI:-brak}, port: ${PID_PORTU:-?})" \
    || zle "nikt nie nasluchuje na 8765"
fi
curl -sf --max-time 8 http://127.0.0.1:8765/zdrowie >/dev/null \
  && ok "shim odpowiada na /zdrowie" || zle "shim nie odpowiada na /zdrowie"

echo "=== 2. Home Mind (kontener) ==="
[ "$(docker inspect -f '{{.State.Running}}' home-mind-server 2>/dev/null)" = "true" ] \
  && ok "kontener dziala" || zle "kontener NIE dziala"
ROZ=$(curl -sf --max-time 8 http://127.0.0.1:3100/api/config/rozmowa 2>/dev/null)
case "$ROZ" in
  *'"dostepna":true'*) ok "serwer widzi shim (rozmowa dostepna)";;
  "")                  zle "serwer nie odpowiada na /api/config/rozmowa";;
  *)                   zle "serwer NIE widzi shima: $ROZ";;
esac

echo "=== 3. Home Assistant (maszyna wirtualna) ==="
[ "$(virsh domstate homeassistant 2>/dev/null)" = "running" ] \
  && ok "VM dziala" || zle "VM NIE dziala — virsh start homeassistant"

echo
if [ "$BLEDY" -eq 0 ]; then
  printf '\033[32mWszystko wstalo.\033[0m Zostaje odslauch: zapytaj asystenta o zart.\n'
else
  printf '\033[31m%d problem(ow).\033[0m Szczegoly wyzej.\n' "$BLEDY"
fi
exit "$BLEDY"
