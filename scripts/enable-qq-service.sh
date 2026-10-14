#!/usr/bin/env bash
# Enable this machine's existing website service with the private LLBot config.
set -euo pipefail

wl_private_dir="${XDG_DATA_HOME:-$HOME/.local/share}/wavelength"
wl_config="$wl_private_dir/config.json"
if [[ ! -f "$wl_config" ]]; then
  printf 'Missing LLBot website config: %s\n' "$wl_config" >&2
  exit 1
fi
if ! systemctl cat wavelength.service >/dev/null 2>&1; then
  printf 'The existing wavelength.service was not found.\n' >&2
  exit 1
fi

# Escape values for systemd's quoted Environment= syntax; reject line breaks.
wl_override=$(mktemp)
trap 'rm -f "$wl_override"' EXIT
python3 - "$wl_private_dir" > "$wl_override" <<'PY'
import sys
root = sys.argv[1]
if '\n' in root or '\r' in root:
    raise SystemExit('The private directory must not contain line breaks.')
def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
print('[Service]')
print('Environment=' + quote('WL_CONFIG=' + root + '/config.json'))
print('Environment=' + quote('WL_QQ_RESULTS=' + root + '/qq-rounds.jsonl'))
print('UMask=0077')
PY

printf 'Enabling QQ guesses and restarting wavelength.service (current game resets).\n'
sudo install -d -m 755 /etc/systemd/system/wavelength.service.d
sudo install -m 644 "$wl_override" /etc/systemd/system/wavelength.service.d/50-qq.conf
sudo systemctl daemon-reload
sudo systemctl restart wavelength.service
systemctl is-active wavelength.service
printf 'Website: http://localhost:3100\nLLBot login: http://localhost:3080\n'
