FILExt
desde 2000

// Prueba de pantalla de Tienda POS.
//
// Abre el src/index.html REAL en Chromium, conectado a la logica REAL del programa
// (la que compila src-tauri, servida por `cargo test ui_bridge`). Toca productos,
// escanea, cobra y revisa que el inventario baje. Se ejecuta antes de publicar cada
// version; si algo falla, la version NO se publica.
//
// Uso:  node tests/ui-smoke.mjs
// Opcionales: PW_CHANNEL=chrome (usar Chrome instalado), PW_CHROME=/ruta/chromium,
//             CARGO_OFFLINE=1, TEST_BRIDGE_PORT=8765

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('playwright-core'); }
const { chromium } = playwright;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexUrl = pathToFileURL(path.join(root, 'src', 'index.html')).href;
const PORT = process.env.TEST_BRIDGE_PORT || '8765';
const BRIDGE = `http://127.0.0.1:${PORT}/call`;

let failures = 0;
const ok = (name) => console.log(`  OK    ${name}`);
const bad = (name, extra = '') => { failures++; console.log(`  FALLA ${name} ${extra}`); };
const check = (cond, name, extra = '') => (cond ? ok(name) : bad(name, extra));

async function call(op, payload = {}, token = '') {
  const r = await fetch(BRIDGE, { method: 'POST', body: JSON.stringify({ op, payload, sessionToken: token }) });
  return r.json();
}

async function waitForBridge() {
  for (let i = 0; i < 600; i++) {
    try { await call('bootstrap'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('No arranco el servidor de pruebas (cargo test ui_bridge)');
}

const product = (sku, barcode, name, price, stock) => ({
  sku, barcode, name, category: 'Bebidas', presentation: 'Pieza', unit: 'pieza',
  stock, minStock: 1, price, cost: price / 2, active: true,
});

async function seed(extra = []) {
  await call('__test_reset');
  const list = [
    product('BEB-0001', '111', 'Agua', 12.5, 10),
    product('P1759000000000ABC', '222', 'Refresco', 18, 5),
    product('GRA-0001', '', 'Granel', 9, 7), // producto viejo SIN codigo de barras
    ...extra,
  ];
  for (const p of list) await call('__test_put_product', p);
}

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.route((url) => !url.toString().startsWith('file:'), (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.exposeFunction('__bridge', (op, payload, token) => call(op, payload, token));
  await page.addInitScript(() => {
    window.__TAURI__ = {
      tauri: {
        invoke: async (cmd, args) => {
          if (cmd === 'backend_call') return await window.__bridge(args.op, args.payload || {}, args.sessionToken || '');
          if (cmd === 'check_license') return { licenseKey: 'TEST', status: 'activo', ok: true };
          if (cmd === 'check_for_update') return { available: false };
          return { ok: true };
        },
      },
    };
  });
  await page.goto(indexUrl);
  return { page, errors, context };
}

const toastHas = (page, text, timeout = 6000) =>
  page.waitForFunction((t) => (document.getElementById('toast')?.textContent || '').includes(t), text, { timeout });

async function login(page) {
  await page.fill('#authCode', '1234');
  await page.press('#authCode', 'Enter');
  await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 8000 });
}

async function openCash(page) {
  await page.waitForSelector('#openCashDialog[open]', { timeout: 8000 });
  await page.fill('#openCashAmountInput', '100');
  await page.click('#openCashForm button');
  await page.waitForFunction(() => !document.getElementById('openCashDialog').open, null, { timeout: 8000 });
}

async function tapProduct(page, sku) {
  await page.click('[data-cat="Bebidas"]');
  await page.waitForSelector('#productDialog[open]');
  await page.click(`#productGrid [data-add="${sku}"]`);
  await page.waitForFunction(() => !document.getElementById('productDialog').open, null, { timeout: 4000 }).catch(() => {});
}

const cartRows = (page) => page.locator('#cartList .cart-row').count();
const stock = async (sku) => (await call('__test_get_product', { sku })).stock;

async function pay(page) {
  await page.click('#checkoutBtn');
  await page.waitForSelector('#autoFillPaymentBtn', { state: 'visible' });
  await page.click('#autoFillPaymentBtn');
  await page.click('#addPaymentBtn');
  await page.click('#confirmPayBtn');
}

async function main() {
  const cargoArgs = ['test', ...(process.env.CARGO_OFFLINE ? ['--offline'] : []), 'ui_bridge', '--', '--ignored', '--nocapture'];
  const server = spawn('cargo', cargoArgs, {
    cwd: path.join(root, 'src-tauri'),
    env: { ...process.env, TEST_BRIDGE_PORT: PORT },
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  const launch = { headless: true };
  if (process.env.PW_CHANNEL) launch.channel = process.env.PW_CHANNEL;
  if (process.env.PW_CHROME) launch.executablePath = process.env.PW_CHROME;
  let browser;
  try {
    await waitForBridge();
    browser = await chromium.launch(launch);

    console.log('\n1) Vender tocando productos, escaneando y cobrando');
    await seed();
    let { page, errors, context } = await newPage(browser);
    await login(page);
    await openCash(page);
    await tapProduct(page, 'BEB-0001');
    check((await cartRows(page)) === 1, 'tocar un producto lo agrega al ticket');
    await page.fill('#scanInput', '222');
    await page.press('#scanInput', 'Enter');
    await page.waitForTimeout(300);
    check((await cartRows(page)) === 2, 'escanear un codigo de barras agrega el producto');
    await tapProduct(page, 'GRA-0001');
    check((await cartRows(page)) === 3, 'un producto viejo SIN codigo de barras tambien se puede tocar');
    await page.click('#cartList [data-inc="BEB-0001"]');
    await page.waitForTimeout(300);
    const qtyText = await page.locator('#cartList .cart-row').first().innerText();
    check(/2/.test(qtyText), 'el boton + del ticket suma una pieza');
    await pay(page);
    try {
      await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 });
      ok('el cobro se completa y sale el ticket');
    } catch { bad('el cobro se completa y sale el ticket'); }
    check((await stock('BEB-0001')) === 8, 'inventario: Agua 10 -> 8', `(quedo ${await stock('BEB-0001')})`);
    check((await stock('P1759000000000ABC')) === 4, 'inventario: Refresco 5 -> 4');
    check((await stock('GRA-0001')) === 6, 'inventario: Granel 7 -> 6');
    check(errors.length === 0, 'sin errores de JavaScript en pantalla', errors.join(' | '));
    await context.close();

    console.log('\n2) Un precio cambia mientras el ticket esta abierto');
    await seed();
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    await openCash(page);
    await tapProduct(page, 'BEB-0001');
    const admin = await call('login', { code: '1234' });
    await call('save_product', { editingSku: 'BEB-0001', record: { ...product('BEB-0001', '111', 'Agua', 13.5, 10) } }, admin.sessionToken);
    await page.evaluate(() => loadData()); // la pantalla se actualiza (como al sincronizar)
    try { await toastHas(page, 'Se actualizaron precios'); ok('avisa que cambio el precio del producto en el ticket'); } catch { bad('avisa que cambio el precio del producto en el ticket'); }
    const total = await page.locator('#cartList').innerText();
    check(total.includes('13.50'), 'el ticket ya muestra el precio nuevo', total.replace(/\s+/g, ' '));
    await pay(page);
    try { await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }); ok('el cobro con el precio nuevo funciona'); } catch { bad('el cobro con el precio nuevo funciona'); }
    check((await stock('BEB-0001')) === 9, 'inventario: Agua 10 -> 9');
    await context.close();

    console.log('\n3) El servidor rechaza un total que no coincide (recuperacion)');
    await seed();
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    await openCash(page);
    await tapProduct(page, 'BEB-0001');
    const admin2 = await call('login', { code: '1234' });
    await call('save_product', { editingSku: 'BEB-0001', record: { ...product('BEB-0001', '111', 'Agua', 14.5, 10) } }, admin2.sessionToken);
    // simula que la pantalla no se dio cuenta del cambio (solo la primera vez)
    await page.evaluate(() => { const orig = window.syncCartPrices; let first = true; window.syncCartPrices = function () { if (first) { first = false; return []; } return orig(); }; });
    await pay(page);
    try { await toastHas(page, 'El total cambió'); ok('se recupera y avisa en lugar de dejar la caja trabada'); } catch { bad('se recupera y avisa en lugar de dejar la caja trabada'); }
    check((await stock('BEB-0001')) === 10, 'no se descuento inventario en el intento fallido');
    await page.click('#autoFillPaymentBtn');
    await page.click('#addPaymentBtn');
    await page.click('#confirmPayBtn');
    try { await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }); ok('despues de recuperarse se puede cobrar'); } catch { bad('despues de recuperarse se puede cobrar'); }
    check((await stock('BEB-0001')) === 9, 'inventario: Agua 10 -> 9');
    await context.close();

    console.log('\n4) Alerta de codigos de barras duplicados al iniciar sesion');
    await seed([product('DUP-0001', '999', 'Galleta A', 10, 3), product('DUP-0002', '999', 'Galleta B', 11, 4)]);
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    try { await page.waitForSelector('#duplicateCodesDialog[open]', { timeout: 6000 }); ok('sale la ventana de duplicados'); } catch { bad('sale la ventana de duplicados'); }
    const dupText = await page.locator('#duplicateCodesList').innerText().catch(() => '');
    check(dupText.includes('Galleta A') && dupText.includes('Galleta B'), 'lista los dos productos repetidos', dupText);
    await page.click('[data-edit-dup="DUP-0002"]');
    try {
      await page.waitForFunction(() => document.getElementById('nameInput')?.value === 'Galleta B', null, { timeout: 5000 });
      ok('el boton Editar abre el producto correcto');
    } catch { bad('el boton Editar abre el producto correcto'); }
    check((await page.locator('#productForm label', { hasText: /^SKU/ }).count()) === 0, 'el formulario de producto ya no pide SKU');
    check((await stock('DUP-0002')) === 4 && (await stock('DUP-0001')) === 3, 'abrir la alerta no cambia inventarios');
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log(failures ? `\n${failures} PRUEBA(S) FALLARON: NO se debe publicar.` : '\nTodas las pruebas de pantalla pasaron.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
