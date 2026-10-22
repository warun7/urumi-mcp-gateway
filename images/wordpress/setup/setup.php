<?php
/**
 * WooCommerce configuration, executed inside WordPress via `wp eval-file`.
 * Every step is idempotent so the Job can run on every install/upgrade/retry.
 */
if (!class_exists('WooCommerce')) {
    WP_CLI::error('WooCommerce is not active');
}

$env = static function (string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v === false || $v === '') ? $default : $v;
};

// Make sure WooCommerce tables + pages exist (install() is safe to re-run).
if (!get_option('woocommerce_db_version')) {
    WC_Install::install();
}
WC_Install::create_pages(); // only creates missing shop/cart/checkout/my-account pages

// --- Store basics -------------------------------------------------------------
update_option('woocommerce_currency', $env('STORE_CURRENCY', 'INR'));
update_option('woocommerce_default_country', $env('STORE_COUNTRY', 'IN:KA'));
update_option('woocommerce_store_address', $env('STORE_ADDRESS', '1 MG Road'));
update_option('woocommerce_store_city', $env('STORE_CITY', 'Bengaluru'));
update_option('woocommerce_store_postcode', $env('STORE_POSTCODE', '560001'));
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_allow_tracking', 'no');
update_option('woocommerce_show_marketplace_suggestions', 'no');
// New stores start in "coming soon" mode which hides the storefront from visitors.
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_pages_only', 'no');
// Skip the onboarding wizard in wp-admin.
update_option('woocommerce_onboarding_profile', ['skipped' => true]);
update_option('woocommerce_task_list_hidden', 'yes');

// --- Payments: Cash on delivery (test-friendly) ---------------------------------
$cod = get_option('woocommerce_cod_settings', []);
$cod = array_merge(is_array($cod) ? $cod : [], [
    'enabled'            => 'yes',
    'title'              => 'Cash on delivery',
    'description'        => 'Pay with cash upon delivery.',
    'instructions'       => 'Pay with cash upon delivery.',
    'enable_for_methods' => [],
    'enable_for_virtual' => 'yes',
]);
update_option('woocommerce_cod_settings', $cod);

// --- Shipping: without any method, physical products cannot be checked out -------
$zone = new WC_Shipping_Zone(0); // "Locations not covered by your other zones"
$hasFree = false;
foreach ($zone->get_shipping_methods() as $m) {
    if ($m->id === 'free_shipping') { $hasFree = true; }
}
if (!$hasFree) {
    $zone->add_shipping_method('free_shipping');
    WP_CLI::log('added free shipping to the default zone');
}

// --- REST API key for woo-mcp ---------------------------------------------------
// The Kubernetes Secret is the source of truth: we insert the key WooCommerce-style
// (consumer_key stored as HMAC-SHA256 via wc_api_hash, secret stored as-is).
$ck = $env('WOO_CONSUMER_KEY');
$cs = $env('WOO_CONSUMER_SECRET');
if ($ck !== '' && $cs !== '') {
    global $wpdb;
    $table = $wpdb->prefix . 'woocommerce_api_keys';
    $description = 'woo-mcp (managed by Kubernetes)';
    $admin = get_user_by('login', $env('WORDPRESS_ADMIN_USER', 'admin'));
    if (!$admin) {
        WP_CLI::error('admin user not found');
    }
    $wpdb->delete($table, ['description' => $description]);
    $ok = $wpdb->insert($table, [
        'user_id'         => $admin->ID,
        'description'     => $description,
        'permissions'     => 'read_write',
        'consumer_key'    => wc_api_hash($ck),
        'consumer_secret' => $cs,
        'truncated_key'   => substr($ck, -7),
    ]);
    if (!$ok) {
        WP_CLI::error('failed to upsert API key: ' . $wpdb->last_error);
    }
    WP_CLI::log('REST API key for woo-mcp is in place (…' . substr($ck, -7) . ')');
} else {
    WP_CLI::warning('WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET not set; skipping API key');
}

// --- Seed products (idempotent by SKU) ------------------------------------------
$seed = [
    ['sku' => 'URU-TEE-001', 'name' => 'Urumi Logo T-Shirt', 'price' => '799', 'desc' => 'Soft cotton tee with the Urumi logo.'],
    ['sku' => 'URU-MUG-001', 'name' => 'Kubernetes Coffee Mug', 'price' => '449', 'desc' => 'A 350ml ceramic mug for long debugging sessions.'],
    ['sku' => 'URU-STK-001', 'name' => 'MCP Sticker Pack', 'price' => '199', 'desc' => 'Ten vinyl stickers for your laptop.'],
    ['sku' => 'URU-HOD-001', 'name' => 'Helm Hoodie', 'price' => '1999', 'desc' => 'Warm hoodie for cold server rooms.'],
];
if (filter_var($env('SEED_PRODUCTS', 'true'), FILTER_VALIDATE_BOOLEAN)) {
    foreach ($seed as $p) {
        if (wc_get_product_id_by_sku($p['sku'])) {
            continue;
        }
        $product = new WC_Product_Simple();
        $product->set_name($p['name']);
        $product->set_sku($p['sku']);
        $product->set_regular_price($p['price']);
        $product->set_description($p['desc']);
        $product->set_status('publish');
        $product->set_manage_stock(true);
        $product->set_stock_quantity(100);
        $product->save();
        WP_CLI::log('seeded product ' . $p['sku']);
    }
}

WP_CLI::success('WooCommerce configured');
