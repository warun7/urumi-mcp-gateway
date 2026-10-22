/**
 * The storefront, driven the way a shopper's browser drives it: WooCommerce's Store API is what the block
 * cart and checkout pages call (a Cart-Token identifies the cart, a Nonce protects writes). Cash on delivery
 * is the test-friendly payment method the store is set up with.
 */
export interface PlacedOrder {
  id: number;
  status: string;
  total: string;
}

const BILLING = {
  first_name: 'Dee',
  last_name: 'Oh',
  company: '',
  address_1: '1 MG Road',
  address_2: '',
  city: 'Bengaluru',
  state: 'KA',
  postcode: '560001',
  country: 'IN',
  phone: '9876543210',
};

export async function storeProducts(shop: string): Promise<{ id: number; name: string; permalink: string; prices: { price: string } }[]> {
  const r = await fetch(`${shop}/wp-json/wc/store/v1/products?per_page=20&orderby=date&order=desc`);
  if (!r.ok) throw new Error(`storefront products: HTTP ${r.status}`);
  return (await r.json()) as any;
}

export async function placeOrder(shop: string, productId: number, email: string, quantity = 1): Promise<PlacedOrder> {
  const api = `${shop}/wp-json/wc/store/v1`;
  const cart = await fetch(`${api}/cart`);
  if (!cart.ok) throw new Error(`cart: HTTP ${cart.status}`);
  const headers = {
    'content-type': 'application/json',
    nonce: cart.headers.get('nonce') ?? '',
    'cart-token': cart.headers.get('cart-token') ?? '',
  };
  const add = await fetch(`${api}/cart/add-item`, { method: 'POST', headers, body: JSON.stringify({ id: productId, quantity }) });
  if (!add.ok) throw new Error(`add to cart: HTTP ${add.status} ${await add.text()}`);
  const co = await fetch(`${api}/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ billing_address: { ...BILLING, email }, shipping_address: BILLING, payment_method: 'cod' }),
  });
  const body = (await co.json()) as any;
  if (!co.ok) throw new Error(`checkout: HTTP ${co.status} ${JSON.stringify(body).slice(0, 300)}`);
  const totals = (await (await fetch(`${api}/order/${body.order_id}?key=${body.order_key}&billing_email=${encodeURIComponent(email)}`)).json().catch(() => ({}))) as any;
  return { id: body.order_id, status: body.status, total: totals?.totals?.total_price ?? '' };
}

/** Log in to wp-admin and open the order's edit screen: "the order is visible in WooCommerce admin". */
export async function adminSeesOrder(shop: string, user: string, password: string, orderId: number): Promise<boolean> {
  const jar = new Map<string, string>([['wordpress_test_cookie', 'WP%20Cookie%20check']]);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (r: Response) => {
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
  };
  const login = await fetch(`${shop}/wp-login.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ log: user, pwd: password, 'wp-submit': 'Log In', testcookie: '1', redirect_to: `${shop}/wp-admin/` }),
  });
  keep(login);
  if (login.status !== 302) return false;
  // The orders screen's edit URL; with posts-table order storage WooCommerce redirects it to post.php.
  const page = await fetch(`${shop}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`, { headers: { cookie: cookie() } });
  const html = await page.text();
  return page.ok && new RegExp(`woocommerce-order-data__heading">\\s*Order #${orderId}\\s*<`).test(html);
}
