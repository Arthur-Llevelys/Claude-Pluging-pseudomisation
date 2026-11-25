#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Installation / mise à jour de l'Anonymiseur sur Ubuntu (22.04 / 24.04)
#
#   sudo ./install.sh                     # port 8765, modèle fr_core_news_lg
#   sudo PORT=8800 ./install.sh           # autre port
#   sudo MODELE=fr_core_news_md ./install.sh   # modèle plus léger (~45 Mo)
#   sudo RESEAU=192.168.1.0/24 ./install.sh    # sous-réseau autorisé (pare-feu)
#
# Relancer le script met à jour le code sans toucher aux clés ni aux données.
# ---------------------------------------------------------------------------
set -euo pipefail

PORT="${PORT:-8765}"
MODELE="${MODELE:-fr_core_news_lg}"
RESEAU="${RESEAU:-192.168.1.0/24}"
APP=/opt/anonymiseur
CONF=/etc/anonymiseur
DATA=/var/lib/anonymiseur
UTIL=anonymiseur
SRC="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script avec sudo."; exit 1; }

echo "==> Paquets système"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip curl >/dev/null
echo "==> OCR des PDF scannés (ocrmypdf + tesseract, français)"
apt-get install -y -qq ocrmypdf tesseract-ocr-fra >/dev/null || echo "!! OCR non installé : les PDF scannés ne seront pas lus (sudo apt install ocrmypdf tesseract-ocr-fra)."

echo "==> Utilisateur de service"
id -u "$UTIL" >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin "$UTIL"

BASE="$(grep '^ANON_DB=' "$CONF/anonymiseur.env" 2>/dev/null | cut -d= -f2- || true)"
BASE="${BASE:-$DATA/correspondances.db}"
if [ -f "$BASE" ]; then
  echo "==> Copie de sécurité de la table de correspondance (chiffrée) avant mise à jour"
  rm -f "$BASE.avant-mise-a-jour"
  python3 - "$BASE" "$BASE.avant-mise-a-jour" <<'PY'
import sqlite3, sys
source, copie = sqlite3.connect(sys.argv[1]), sqlite3.connect(sys.argv[2])
with copie:
    source.backup(copie)
copie.close(); source.close()
PY
  chown "$UTIL":"$UTIL" "$BASE.avant-mise-a-jour"; chmod 600 "$BASE.avant-mise-a-jour"
  echo "   $BASE.avant-mise-a-jour (supprimée automatiquement à l'issue de la durée de conservation)"
fi

echo "==> Code dans $APP"
mkdir -p "$APP"
rm -rf "$APP/app"
cp -r "$SRC/app" "$APP/app"
cp "$SRC/requirements.txt" "$APP/"
mkdir -p "$APP/tests" && cp -r "$SRC/tests/." "$APP/tests/" 2>/dev/null || true

echo "==> Environnement Python (quelques minutes la première fois)"
[ -d "$APP/venv" ] || python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"

echo "==> Modèle spaCy $MODELE"
if ! "$APP/venv/bin/python" -c "import spacy,sys; spacy.load('$MODELE')" 2>/dev/null; then
  "$APP/venv/bin/python" -m spacy download "$MODELE" -q || {
    echo "!! Échec du téléchargement de $MODELE. Le service fonctionnera avec les règles seules."
    echo "   Réessayez plus tard : sudo $APP/venv/bin/python -m spacy download $MODELE"
  }
fi

echo "==> Configuration dans $CONF"
mkdir -p "$CONF"
for f in ne_jamais_masquer.txt toujours_masquer.txt mots_courants.txt villes.txt; do
  [ -f "$CONF/$f" ] || cp "$SRC/config/$f" "$CONF/$f"
done
if [ ! -f "$CONF/anonymiseur.env" ]; then
  CLE_API="$("$APP/venv/bin/python" -c 'import secrets;print(secrets.token_urlsafe(24))')"
  CLE_CHIFFREMENT="$("$APP/venv/bin/python" -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())')"
  cat > "$CONF/anonymiseur.env" <<EOF
# Clé à saisir dans l'interface web et dans l'extension Claude Desktop
ANON_API_KEY=$CLE_API
# Clé de chiffrement des correspondances — À SAUVEGARDER : sans elle, les dossiers sont illisibles
ANON_SECRET_KEY=$CLE_CHIFFREMENT
ANON_DB=$DATA/correspondances.db
ANON_CONFIG_DIR=$CONF
ANON_SPACY_MODEL=$MODELE
# Suppression automatique des dossiers inactifs depuis N jours
ANON_RETENTION_DAYS=30
ANON_MAX_UPLOAD_MB=25
EOF
  NOUVELLE_CLE=1
else
  sed -i "s/^ANON_SPACY_MODEL=.*/ANON_SPACY_MODEL=$MODELE/" "$CONF/anonymiseur.env"
fi
chown -R root:"$UTIL" "$CONF"
chmod 750 "$CONF"; chmod 640 "$CONF"/*

mkdir -p "$DATA"
chown "$UTIL":"$UTIL" "$DATA"; chmod 700 "$DATA"
chown -R root:root "$APP"; chmod -R go-w "$APP"

echo "==> Service systemd"
cat > /etc/systemd/system/anonymiseur.service <<EOF
[Unit]
Description=Anonymiseur - pseudonymisation avant envoi a une IA
After=network-online.target
Wants=network-online.target

[Service]
User=$UTIL
Group=$UTIL
WorkingDirectory=$APP
EnvironmentFile=$CONF/anonymiseur.env
ExecStart=$APP/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1 --no-server-header
Restart=on-failure
RestartSec=3
# Durcissement
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable anonymiseur >/dev/null 2>&1
systemctl restart anonymiseur

echo "==> Pare-feu"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$RESEAU" to any port "$PORT" proto tcp >/dev/null
  echo "   ufw : port $PORT ouvert pour $RESEAU uniquement."
else
  echo "   ufw inactif : pensez à limiter l'accès au port $PORT à votre réseau local."
fi

echo "==> Vérification"
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/sante" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/api/sante" | "$APP/venv/bin/python" -c \
  'import json,sys; s=json.load(sys.stdin); print("   version", s["version"], "- spaCy:", "actif ("+str(s["spacy"]["modele"])+")" if s["spacy"]["actif"] else "INACTIF ("+str(s["spacy"]["erreur"])+")")' \
  || { echo "!! Le service ne répond pas : journalctl -u anonymiseur -n 50"; exit 1; }

IP="$(hostname -I | awk '{print $1}')"
echo
echo "================================================================"
echo " Anonymiseur installé : http://$IP:$PORT"
if [ "${NOUVELLE_CLE:-0}" = 1 ]; then
  echo " Clé d'API : $(grep ^ANON_API_KEY= "$CONF/anonymiseur.env" | cut -d= -f2-)"
  echo
  echo " IMPORTANT : sauvegardez $CONF/anonymiseur.env (clé de chiffrement)."
else
  echo " Clé d'API inchangée : sudo grep ANON_API_KEY $CONF/anonymiseur.env"
fi
echo "================================================================"
