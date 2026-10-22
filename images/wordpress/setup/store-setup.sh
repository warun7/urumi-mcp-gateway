#!/usr/bin/env bash
# Idempotent store bootstrap. Runs as a Helm hook Job (post-install, post-upgrade)
# using this same image, so WordPress code is already present; only the DB is touched.
set -euo pipefail

export HOME=/tmp WP_CLI_CACHE_DIR=/tmp/wp-cli-cache
WP="wp --path=/srv/wordpress"

: "${WP_HOME:?WP_HOME is required}"
: "${WORDPRESS_ADMIN_USER:=admin}"
: "${WORDPRESS_ADMIN_PASSWORD:?WORDPRESS_ADMIN_PASSWORD is required}"
: "${WORDPRESS_ADMIN_EMAIL:=admin@example.com}"
: "${STORE_TITLE:=Urumi Demo Store}"
: "${STORE_TIMEZONE:=UTC}"

echo "==> waiting for database ${WORDPRESS_DB_HOST}"
for i in $(seq 1 60); do
  if php -r '$h=getenv("WORDPRESS_DB_HOST"); $p=3306; if(strpos($h,":")!==false){[$h,$p]=explode(":",$h,2);} mysqli_report(MYSQLI_REPORT_OFF); exit(@mysqli_connect($h,getenv("WORDPRESS_DB_USER"),getenv("WORDPRESS_DB_PASSWORD"),getenv("WORDPRESS_DB_NAME"),(int)$p)?0:1);'; then
    echo "database is up"; break
  fi
  [ "$i" = 60 ] && { echo "database never became reachable" >&2; exit 1; }
  sleep 3
done

if ! $WP core is-installed 2>/dev/null; then
  echo "==> installing WordPress core tables"
  $WP core install --url="$WP_HOME" --title="$STORE_TITLE" \
    --admin_user="$WORDPRESS_ADMIN_USER" --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
    --admin_email="$WORDPRESS_ADMIN_EMAIL" --skip-email
else
  echo "==> WordPress already installed; running core DB migrations"
  $WP core update-db
fi

# Keep URLs in sync with Helm values (domain can change between local and prod).
$WP option update home "$WP_HOME" >/dev/null
$WP option update siteurl "$WP_HOME" >/dev/null
$WP option update blogname "$STORE_TITLE" >/dev/null
$WP option update timezone_string "$STORE_TIMEZONE" >/dev/null
$WP option update users_can_register 0 >/dev/null

echo "==> activating WooCommerce + Storefront"
$WP plugin is-active woocommerce || $WP plugin activate woocommerce
$WP theme activate storefront >/dev/null

# Pretty permalinks are required for /wp-json/ (the .htaccess ships in the image).
$WP rewrite structure '/%postname%/' >/dev/null

echo "==> configuring WooCommerce (currency, COD, shipping, API key, seed products)"
$WP eval-file /usr/local/share/store-setup/setup.php

echo "==> running WooCommerce DB updates (no-op when current)"
$WP wc update || true

echo "==> store setup complete: $WP_HOME"
