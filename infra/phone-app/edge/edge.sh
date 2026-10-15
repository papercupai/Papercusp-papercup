#!/usr/bin/env bash
# Phone public media edge (plan phone-public-telephone-service-2026-10-01, P-002, D-024/D-025).
# Reproducible, idempotent provisioning of the cloud L4 edge and the box-side tunnel.
# Design and port map: infra/phone-app/edge/edge-config.mjs and infra/phone-app/README.md.
#
#   edge.sh provision   GCP static IP + firewall + e2-micro VM (idempotent)
#   edge.sh dns         Cloudflare A records (DNS only, never proxied) -> the static IP
#   edge.sh apply-vm    WireGuard + nftables + nginx SNI router + WSS certificate on the VM
#   edge.sh apply-box   WireGuard + policy routing + ufw + TURN certificate on this box
#   edge.sh status      tunnel, DNS and certificate facts (changes nothing)
#   edge.sh turn-hook   print the rendered TURN certificate deploy hook (changes nothing)
#
# Non-secret coordinates persist in ~/.config/papercusp-phone/edge.env. No secret is ever
# printed or written to the repository: WireGuard private keys are generated on, and never
# leave, the host that uses them; the Cloudflare token is read from its existing file.
set -euo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${PHONE_CONFIG_DIR:-$HOME/.config/papercusp-phone}"
EDGE_ENV="$CONF_DIR/edge.env"
NODE_BIN="${PHONE_NODE_BIN:-$(command -v node)}"
say() { printf '[phone-edge] %s\n' "$*" >&2; }
die() { printf '[phone-edge] ERROR: %s\n' "$*" >&2; exit 1; }

# shellcheck disable=SC1090
[[ ! -f "$EDGE_ENV" ]] || source "$EDGE_ENV"
: "${PHONE_EDGE_GCP_PROJECT:=active-alcove-504205-q3}"
: "${PHONE_EDGE_GCP_REGION:=us-east1}"
: "${PHONE_EDGE_GCP_ZONE:=us-east1-b}"
: "${PHONE_EDGE_NAME:=phone-media-edge}"
: "${PHONE_EDGE_MACHINE_TYPE:=e2-micro}"
: "${PHONE_EDGE_VOICE_HOST:=phone-voice.papercusp.com}"
: "${PHONE_EDGE_TURN_HOST:=phone-turn.papercusp.com}"
: "${PHONE_EDGE_IFACE:=phedge0}"
: "${PHONE_EDGE_CF_TOKEN_FILE:=$HOME/.cloudflared/cf-api-token}"
: "${PHONE_EDGE_CF_ZONE:=papercusp.com}"
export PHONE_EDGE_VOICE_HOST PHONE_EDGE_TURN_HOST PHONE_EDGE_IFACE
# Keep the optional port absent for media-only installations; an empty exported
# value would fail the renderer's port validation.
[[ ! ${PHONE_PRODUCER_LISTEN_PORT+x} ]] || export PHONE_PRODUCER_LISTEN_PORT
GC=(gcloud --quiet --project "$PHONE_EDGE_GCP_PROJECT")
TURN_TLS_DIR="$CONF_DIR/tls/turn"

persist() {
  umask 077; mkdir -p "$CONF_DIR"
  cat > "$EDGE_ENV" <<EOF
# Phone public media edge coordinates (non-secret). Written by infra/phone-app/edge/edge.sh.
PHONE_EDGE_GCP_PROJECT=$PHONE_EDGE_GCP_PROJECT
PHONE_EDGE_GCP_REGION=$PHONE_EDGE_GCP_REGION
PHONE_EDGE_GCP_ZONE=$PHONE_EDGE_GCP_ZONE
PHONE_EDGE_NAME=$PHONE_EDGE_NAME
PHONE_EDGE_PUBLIC_IP=${PHONE_EDGE_PUBLIC_IP:-}
PHONE_EDGE_VOICE_HOST=$PHONE_EDGE_VOICE_HOST
PHONE_EDGE_TURN_HOST=$PHONE_EDGE_TURN_HOST
PHONE_EDGE_IFACE=$PHONE_EDGE_IFACE
PHONE_EDGE_WG_PUBLIC_KEY=${PHONE_EDGE_WG_PUBLIC_KEY:-}
EOF
  if [[ ${PHONE_PRODUCER_LISTEN_PORT+x} ]]; then
    printf 'PHONE_PRODUCER_LISTEN_PORT=%q\n' "$PHONE_PRODUCER_LISTEN_PORT" >> "$EDGE_ENV"
  fi
}

render() { PHONE_EDGE_PUBLIC_IP="$PHONE_EDGE_PUBLIC_IP" "$NODE_BIN" "$HERE/edge-config.mjs" "$@"; }
need_ip() { [[ -n "${PHONE_EDGE_PUBLIC_IP:-}" ]] || die "no PHONE_EDGE_PUBLIC_IP; run 'edge.sh provision' first"; }

cmd_provision() {
  local name="$PHONE_EDGE_NAME" addr="$PHONE_EDGE_NAME-ip" fw="$PHONE_EDGE_NAME-public"
  if ! "${GC[@]}" compute addresses describe "$addr" --region "$PHONE_EDGE_GCP_REGION" >/dev/null 2>&1; then
    say "creating static IPv4 $addr in $PHONE_EDGE_GCP_REGION"
    "${GC[@]}" compute addresses create "$addr" --region "$PHONE_EDGE_GCP_REGION" \
      --description "Phone public media edge (plan phone-public-telephone-service-2026-10-01 P-002, D-025)"
  fi
  PHONE_EDGE_PUBLIC_IP="$("${GC[@]}" compute addresses describe "$addr" --region "$PHONE_EDGE_GCP_REGION" --format='value(address)')"
  [[ -n "$PHONE_EDGE_PUBLIC_IP" ]] || die "static address has no IPv4"
  # SIP/RTP are deliberately absent: P-004 adds them restricted to the carrier's source ranges.
  # No udp:7893: TURN is TLS-only, through tcp:443 (WI-10006616).
  local allow="tcp:80,tcp:443,tcp:7891,udp:7892,udp:51820"
  if "${GC[@]}" compute firewall-rules describe "$fw" >/dev/null 2>&1; then
    "${GC[@]}" compute firewall-rules update "$fw" --allow "$allow" --target-tags "$name" --source-ranges 0.0.0.0/0
  else
    say "creating firewall rule $fw ($allow)"
    "${GC[@]}" compute firewall-rules create "$fw" --network default --direction INGRESS \
      --allow "$allow" --target-tags "$name" --source-ranges 0.0.0.0/0 \
      --description "Phone public media edge: ACME, WSS/TURN-TLS, RTC, TURN/UDP, WireGuard"
  fi
  if ! "${GC[@]}" compute instances describe "$name" --zone "$PHONE_EDGE_GCP_ZONE" >/dev/null 2>&1; then
    say "creating $PHONE_EDGE_MACHINE_TYPE VM $name in $PHONE_EDGE_GCP_ZONE"
    "${GC[@]}" compute instances create "$name" --zone "$PHONE_EDGE_GCP_ZONE" \
      --machine-type "$PHONE_EDGE_MACHINE_TYPE" --address "$PHONE_EDGE_PUBLIC_IP" --tags "$name" \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
      --boot-disk-size 10GB --boot-disk-type pd-standard \
      --labels plan=phone-public-telephone-service,item=p-002,role=phone-media-edge
  fi
  persist
  say "edge VM $name at $PHONE_EDGE_PUBLIC_IP"
}

cf_api() {
  local method="$1" path="$2" body="${3:-}" token
  token="$(tr -d '[:space:]' < "$PHONE_EDGE_CF_TOKEN_FILE")"
  curl -fsS -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "https://api.cloudflare.com/client/v4$path"
}

cmd_dns() {
  need_ip
  local zone host id body
  zone="$(cf_api GET "/zones?name=$PHONE_EDGE_CF_ZONE" | jq -r '.result[0].id // empty')"
  [[ -n "$zone" ]] || die "Cloudflare zone $PHONE_EDGE_CF_ZONE not visible to the token"
  for host in "$PHONE_EDGE_VOICE_HOST" "$PHONE_EDGE_TURN_HOST"; do
    # proxied MUST stay false: Cloudflare's proxy carries neither TURN/TLS passthrough nor UDP.
    body="$(jq -nc --arg n "$host" --arg ip "$PHONE_EDGE_PUBLIC_IP" \
      '{type:"A",name:$n,content:$ip,ttl:300,proxied:false,comment:"Phone public media edge (P-002, D-025)"}')"
    id="$(cf_api GET "/zones/$zone/dns_records?type=A&name=$host" | jq -r '.result[0].id // empty')"
    if [[ -n "$id" ]]; then cf_api PUT "/zones/$zone/dns_records/$id" "$body" >/dev/null
    else cf_api POST "/zones/$zone/dns_records" "$body" >/dev/null; fi
    say "DNS $host -> $PHONE_EDGE_PUBLIC_IP (DNS only)"
  done
}

box_public_key() {
  sudo -n install -d -m 700 /etc/wireguard
  sudo -n test -s "/etc/wireguard/$PHONE_EDGE_IFACE.key" \
    || sudo -n sh -c "umask 077; wg genkey > /etc/wireguard/$PHONE_EDGE_IFACE.key"
  sudo -n cat "/etc/wireguard/$PHONE_EDGE_IFACE.key" | wg pubkey
}

# Rendered output always ends in a newline (edge-config.mjs guarantees it), so the heredoc
# terminator lands on its own line. Never route it through $(...): that strips the newline.
emit_file() {
  local dest="$1"; shift
  printf "cat > %s <<'PHONE_EDGE_EOF'\n" "$dest"
  render "$@"
  printf 'PHONE_EDGE_EOF\n'
}

# Emit a self-contained root install script for the VM. Only rendered, non-secret config is
# embedded; the VM generates its own WireGuard key and prints only the public half.
vm_install_script() {
  local box_pub="$1"
  cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard-tools nftables nginx libnginx-mod-stream certbot >/dev/null
install -d -m 700 /etc/wireguard
[ -s /etc/wireguard/wg-phone.key ] || (umask 077; wg genkey > /etc/wireguard/wg-phone.key)
install -d -m 755 /var/www/phone-edge-acme /etc/nginx/phone-edge
EOF
  emit_file /etc/wireguard/wg-phone.conf vm-wireguard "$box_pub"
  emit_file /etc/phone-edge.nft vm-nftables
  emit_file /etc/nginx/phone-edge/stream.conf nginx-stream
  emit_file /etc/nginx/phone-edge/site-bootstrap.conf nginx-site-bootstrap
  emit_file /etc/nginx/phone-edge/site.conf nginx-site
  printf 'VOICE_HOST=%q\n' "$PHONE_EDGE_VOICE_HOST"
  cat <<'EOF'
chmod 600 /etc/wireguard/wg-phone.conf
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/90-phone-edge.conf
sysctl -q --system
cat > /etc/systemd/system/phone-edge-nft.service <<'UNIT'
[Unit]
Description=Phone media edge forwarding rules
After=network-pre.target
Before=wg-quick@wg-phone.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/phone-edge.nft
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable phone-edge-nft.service >/dev/null
systemctl restart phone-edge-nft.service
systemctl enable wg-quick@wg-phone >/dev/null
systemctl restart wg-quick@wg-phone
grep -q 'phone-edge/stream.conf' /etc/nginx/nginx.conf || echo 'include /etc/nginx/phone-edge/stream.conf;' >> /etc/nginx/nginx.conf
rm -f /etc/nginx/sites-enabled/default
if [ -s "/etc/letsencrypt/live/$VOICE_HOST/fullchain.pem" ]; then site=site.conf; else site=site-bootstrap.conf; fi
ln -sfn "/etc/nginx/phone-edge/$site" /etc/nginx/sites-enabled/phone-edge
nginx -t -q && systemctl reload-or-restart nginx
certbot certonly --webroot -w /var/www/phone-edge-acme -d "$VOICE_HOST" --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring -q
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/phone-edge-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/phone-edge-nginx.sh
ln -sfn /etc/nginx/phone-edge/site.conf /etc/nginx/sites-enabled/phone-edge
nginx -t -q && systemctl reload nginx
systemctl is-enabled certbot.timer >/dev/null
echo "EDGE_WG_PUBLIC_KEY=$(wg pubkey < /etc/wireguard/wg-phone.key)"
EOF
}

cmd_apply_vm() {
  need_ip
  local box_pub script out key
  box_pub="$(box_public_key)"
  # Render the whole script BEFORE connecting: a render failure must never ship a partial script.
  script="$(vm_install_script "$box_pub")" || die "VM install script failed to render"
  out="$(printf '%s\n' "$script" | "${GC[@]}" compute ssh "$PHONE_EDGE_NAME" --zone "$PHONE_EDGE_GCP_ZONE" \
    --command 'sudo bash -s')" || die "VM install failed"
  key="$(printf '%s\n' "$out" | sed -n 's/^EDGE_WG_PUBLIC_KEY=//p' | tail -1)"
  [[ -n "$key" ]] || die "VM did not report its WireGuard public key"
  PHONE_EDGE_WG_PUBLIC_KEY="$key"; persist
  say "VM converged; edge WireGuard key recorded"
}

turn_hook() {
  cat <<EOF
#!/bin/sh
# Rendered by infra/phone-app/edge/edge.sh: hand the renewed TURN certificate to LiveKit.
set -eu
case " \${RENEWED_DOMAINS:-} " in *" $PHONE_EDGE_TURN_HOST "*) ;; *) exit 0 ;; esac
install -d -m 700 -o $(id -un) -g $(id -gn) "$TURN_TLS_DIR"
# Same certificate and key already handed over: restarting LiveKit would only drop live calls
# and the public WSS (WI-10006623), so an unchanged lineage is a no-op.
if cmp -s "\$RENEWED_LINEAGE/fullchain.pem" "$TURN_TLS_DIR/fullchain.pem" && cmp -s "\$RENEWED_LINEAGE/privkey.pem" "$TURN_TLS_DIR/privkey.pem"; then exit 0; fi
install -m 600 -o $(id -un) -g $(id -gn) "\$RENEWED_LINEAGE/fullchain.pem" "$TURN_TLS_DIR/fullchain.pem"
install -m 600 -o $(id -un) -g $(id -gn) "\$RENEWED_LINEAGE/privkey.pem" "$TURN_TLS_DIR/privkey.pem"
systemctl --user -M $(id -un)@ try-restart papercusp-phone-livekit.service || true
EOF
}

cmd_apply_box() {
  need_ip
  [[ -n "${PHONE_EDGE_WG_PUBLIC_KEY:-}" ]] || die "no edge WireGuard key; run 'edge.sh apply-vm' first"
  local conf tmp creds hook
  box_public_key >/dev/null
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  render box-wireguard "$PHONE_EDGE_WG_PUBLIC_KEY" > "$tmp"
  conf="/etc/wireguard/$PHONE_EDGE_IFACE.conf"
  if ! sudo -n cmp -s "$tmp" "$conf" 2>/dev/null; then
    sudo -n install -m 600 "$tmp" "$conf"
    sudo -n systemctl enable "wg-quick@$PHONE_EDGE_IFACE" >/dev/null 2>&1
    sudo -n systemctl restart "wg-quick@$PHONE_EDGE_IFACE"
  else
    sudo -n systemctl enable --now "wg-quick@$PHONE_EDGE_IFACE" >/dev/null 2>&1
  fi
  sudo -n ufw allow in on "$PHONE_EDGE_IFACE" to any port 7890,7891,7894 proto tcp comment 'phone media edge' >/dev/null
  sudo -n ufw allow in on "$PHONE_EDGE_IFACE" to any port 7892 proto udp comment 'phone media edge' >/dev/null
  # Older deploys also opened TURN/UDP 7893; TURN is TLS-only now (WI-10006616).
  sudo -n ufw delete allow in on "$PHONE_EDGE_IFACE" to any port 7892,7893 proto udp >/dev/null 2>&1 || true
  # TURN/TLS certificate lives on the box (LiveKit terminates it); DNS-01 needs no inbound port.
  dpkg -s certbot python3-certbot-dns-cloudflare >/dev/null 2>&1 \
    || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-dns-cloudflare >/dev/null
  creds=/etc/letsencrypt/phone-edge-cloudflare.ini
  sudo -n install -d -m 755 /etc/letsencrypt /etc/letsencrypt/renewal-hooks/deploy
  printf 'dns_cloudflare_api_token = %s\n' "$(tr -d '[:space:]' < "$PHONE_EDGE_CF_TOKEN_FILE")" \
    | sudo -n sh -c "umask 077; cat > $creds"
  hook=/etc/letsencrypt/renewal-hooks/deploy/phone-turn-livekit.sh
  turn_hook > "$tmp"; sudo -n install -m 755 "$tmp" "$hook"
  sudo -n certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$creds" \
    --dns-cloudflare-propagation-seconds 30 -d "$PHONE_EDGE_TURN_HOST" --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring -q
  # Directory deploy hooks only run on renewal; run it once for the current lineage. The hook
  # is a no-op when the lineage already matches LiveKit's copy, so a re-run keeps calls up.
  sudo -n env RENEWED_DOMAINS="$PHONE_EDGE_TURN_HOST" RENEWED_LINEAGE="/etc/letsencrypt/live/$PHONE_EDGE_TURN_HOST" "$hook"
  say "box tunnel up; TURN certificate at $TURN_TLS_DIR"
}

cmd_status() {
  need_ip
  printf 'edge %s (%s / %s)\n' "$PHONE_EDGE_PUBLIC_IP" "$PHONE_EDGE_VOICE_HOST" "$PHONE_EDGE_TURN_HOST"
  local hs
  hs="$(sudo -n wg show "$PHONE_EDGE_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}')"
  if [[ -n "$hs" && "$hs" != 0 ]]; then echo "tunnel handshake age s: $(( $(date +%s) - hs ))"; else echo "tunnel: no handshake"; fi
  ping -c1 -W2 10.77.0.1 >/dev/null 2>&1 && echo "tunnel ping ok" || echo "tunnel ping FAILED"
  for h in "$PHONE_EDGE_VOICE_HOST" "$PHONE_EDGE_TURN_HOST"; do printf '%s -> %s\n' "$h" "$(getent ahostsv4 "$h" | awk 'NR==1{print $1}')"; done
  [[ -f "$TURN_TLS_DIR/fullchain.pem" ]] && openssl x509 -noout -enddate -in "$TURN_TLS_DIR/fullchain.pem" || echo "no TURN certificate"
}

case "${1:-}" in
  provision) cmd_provision ;;
  dns) cmd_dns ;;
  apply-vm) cmd_apply_vm ;;
  apply-box) cmd_apply_box ;;
  status) cmd_status ;;
  turn-hook) turn_hook ;;
  *) sed -n '3,15p' "$0"; exit 2 ;;
esac
