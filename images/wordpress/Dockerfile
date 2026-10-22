# WordPress + WooCommerce store image.
#
# Design: code is IMMUTABLE and baked into the image (core, WooCommerce, Storefront, wp-cli).
# Persistent state lives in MariaDB (products, orders, settings) and in the uploads PVC
# mounted at /srv/wordpress/wp-content/uploads. Upgrading WooCommerce = bump these ARGs,
# rebuild, `helm upgrade` (the setup Job runs the DB migrations).
ARG WORDPRESS_VERSION=7.1.3
ARG PHP_VERSION=8.3

FROM wordpress:${WORDPRESS_VERSION}-php${PHP_VERSION}-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WPCLI_VERSION=2.12.0

RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends unzip mariadb-client less; \
    rm -rf /var/lib/apt/lists/*; \
    # Code lives in /srv/wordpress (not /var/www/html, which the base image declares as a VOLUME).
    cp -a /usr/src/wordpress /srv/wordpress; \
    curl -fsSL -o /tmp/wc.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    unzip -q /tmp/wc.zip -d /srv/wordpress/wp-content/plugins; \
    curl -fsSL -o /tmp/sf.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    unzip -q /tmp/sf.zip -d /srv/wordpress/wp-content/themes; \
    rm -rf /tmp/*.zip /srv/wordpress/wp-content/plugins/akismet /srv/wordpress/wp-content/plugins/hello.php; \
    curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WPCLI_VERSION}/wp-cli-${WPCLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    # wp-config.php reads everything from env vars (DB creds, salts, WP_HOME, extra PHP).
    cp /srv/wordpress/wp-config-docker.php /srv/wordpress/wp-config.php; \
    mkdir -p /srv/wordpress/wp-content/uploads; \
    chown -R root:root /srv/wordpress; \
    chown www-data:www-data /srv/wordpress/wp-content/uploads

# Apache: non-root friendly (port 8080), DocumentRoot -> /srv/wordpress.
COPY apache-site.conf /etc/apache2/sites-available/000-default.conf
COPY php-store.ini /usr/local/etc/php/conf.d/zz-store.ini
RUN set -eux; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    echo 'ServerName localhost' > /etc/apache2/conf-enabled/servername.conf

# Health endpoints (do not load WordPress) and setup scripts.
COPY healthz.php ready.php /srv/wordpress/
COPY setup/ /usr/local/share/store-setup/
RUN chmod +x /usr/local/share/store-setup/*.sh

USER 33:33
EXPOSE 8080
WORKDIR /srv/wordpress
# Skip the base image's copy-to-/var/www/html entrypoint: code is already in place.
ENTRYPOINT []
CMD ["apache2-foreground"]
