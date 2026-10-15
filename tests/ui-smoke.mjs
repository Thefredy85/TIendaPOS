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
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('playwright-core'); }
const { chromium } = playwright;

// La raiz del proyecto es la carpeta que contiene src-tauri (funciona aunque este archivo
// quede en la raiz o dentro de la carpeta tests).
let root = path.dirname(fileURLToPath(import.meta.url));
for (let i = 0; i < 4 && !existsSync(path.join(root, 'src-tauri')); i++) root = path.resolve(root, '..');
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

    // Falla real reportada en tiendas (v0.2.9 a v0.2.11): "agrego productos y no aparecen".
    // Pulsar Editar y salir sin guardar hacia que el siguiente producto "nuevo" pisara al editado.
    console.log('\n5) Dar de alta productos desde el formulario (sin tocar ventas ni inventario)');
    await seed([product('DUP-0001', '999', 'Galleta A', 10, 3), product('DUP-0002', '999', 'Galleta B', 11, 4)]);
    const boss = await call('login', { code: '1234' });
    for (const name of ['Bebidas', 'Botanas', 'Abarrotes']) await call('save_catalog', { kind: 'category', name }, boss.sessionToken);
    await call('open_cash_register', { openingAmount: 100 }, boss.sessionToken);
    await call('checkout', { clientId: 'S-ANTES', items: [{ sku: 'BEB-0001', qty: 2 }], payments: { Efectivo: 25 } }, boss.sessionToken);
    const snapshot = async () => {
      const d = await call('data', {}, (await call('login', { code: '1234' })).sessionToken);
      return { products: d.products || [], sales: JSON.stringify((d.sales || []).map((s) => [s.id, s.total, s.itemsJson])) };
    };
    const before = await snapshot();
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    if (await page.locator('#duplicateCodesDialog[open]').count()) await page.click('#closeDuplicateCodesBtn').catch(() => {});
    const fillProduct = async ({ barcode, name, category, price, cost, stock: qty }) => {
      await page.fill('#barcodeInput', barcode);
      await page.fill('#nameInput', name);
      await page.selectOption('#categoryInput', category);
      await page.fill('#costInput', String(cost));
      await page.fill('#priceInput', String(price));
      if (qty !== undefined && !(await page.locator('#stockInput').isDisabled())) await page.fill('#stockInput', String(qty));
      await page.evaluate(() => document.getElementById('productForm').requestSubmit());
      await page.waitForTimeout(1200);
    };
    const findByBarcode = async (bc) => (await snapshot()).products.find((p) => p.barcode === bc);
    const inProductsTable = (name) => page.locator('#productsTable', { hasText: name }).count();
    const inSaleGrid = async (p) => {
      await page.evaluate(() => show('pos'));
      await page.waitForTimeout(300);
      if (!(await page.locator(`[data-cat="${p.category}"]`).count())) return false;
      await page.click(`[data-cat="${p.category}"]`);
      await page.waitForTimeout(300);
      const n = await page.locator(`#productGrid [data-add="${p.sku}"]`).count();
      await page.keyboard.press('Escape');
      return n > 0;
    };

    // a) alta normal
    await page.evaluate(() => show('products'));
    await fillProduct({ barcode: '7501000000017', name: 'Galletas Nuevas', category: 'Botanas', price: 20, cost: 12, stock: 6 });
    let created = await findByBarcode('7501000000017');
    check(!!created && created.stock === 6, 'a) un alta normal se guarda con su existencia');
    check((await inProductsTable('Galletas Nuevas')) > 0, 'a) aparece en la tabla de Productos');
    check(created && (await inSaleGrid(created)), 'a) aparece en Venta dentro de su categoria');

    // b) categoria que aun no tenia productos
    await page.evaluate(() => show('products'));
    await fillProduct({ barcode: '7501000000024', name: 'Frijol Nuevo', category: 'Abarrotes', price: 30, cost: 20, stock: 4 });
    created = await findByBarcode('7501000000024');
    check(!!created && created.category === 'Abarrotes', 'b) se guarda en una categoria sin productos');
    check(created && (await inSaleGrid(created)), 'b) aparece en Venta dentro de la categoria nueva');

    // c) con texto en el buscador de Productos
    await page.evaluate(() => show('products'));
    await page.fill('#productSearchInput', 'galleta a');
    await page.dispatchEvent('#productSearchInput', 'input');
    await fillProduct({ barcode: '7501000000031', name: 'Jugo Nuevo', category: 'Bebidas', price: 15, cost: 9, stock: 3 });
    check(!!(await findByBarcode('7501000000031')), 'c) se guarda aunque el buscador tenga texto');
    check((await inProductsTable('Jugo Nuevo')) > 0, 'c) aparece en la tabla (el buscador se limpia)');

    // d) LA FALLA: Editar desde la alerta de duplicados, salir sin guardar y dar de alta otro
    await page.evaluate(() => editProduct('DUP-0002'));
    check(await page.locator('#editingBanner:not(.hide)').count() > 0, 'd) al editar se ve el aviso "Editando"');
    await page.evaluate(() => show('pos'));
    await page.waitForTimeout(300);
    await page.evaluate(() => show('products'));
    check(await page.evaluate(() => document.getElementById('editingSku').value === ''), 'd) salir de Productos sin guardar cancela la edicion');
    await fillProduct({ barcode: '7501000000048', name: 'Chocolate Nuevo', category: 'Botanas', price: 14, cost: 8, stock: 5 });
    created = await findByBarcode('7501000000048');
    check(!!created && created.sku !== 'DUP-0002', 'd) se crea un producto NUEVO');
    const galletaB = (await snapshot()).products.find((p) => p.sku === 'DUP-0002');
    check(galletaB && galletaB.name === 'Galleta B' && galletaB.barcode === '999' && galletaB.stock === 4, 'd) "Galleta B" queda intacta', JSON.stringify(galletaB));

    // e) Editar y luego Cancelar edicion
    await page.evaluate(() => editProduct('DUP-0001'));
    await page.click('#cancelEditBtn');
    await fillProduct({ barcode: '7501000000055', name: 'Cafe Nuevo', category: 'Abarrotes', price: 40, cost: 25, stock: 2 });
    check(!!(await findByBarcode('7501000000055')), 'e) despues de Cancelar edicion, el alta crea un producto nuevo');

    // f) una edicion que cambia nombre Y codigo pide confirmar; si se cancela no cambia nada
    await page.evaluate(() => editProduct('DUP-0001'));
    await fillProduct({ barcode: '7501000000062', name: 'Otra Cosa', category: 'Bebidas', price: 10, cost: 5 });
    check(await page.locator('#confirmDialog[open]').count() > 0, 'f) cambiar nombre y codigo a la vez pide confirmacion');
    await page.click('#cancelConfirmBtn').catch(() => {});
    await page.waitForTimeout(500);
    const galletaA = (await snapshot()).products.find((p) => p.sku === 'DUP-0001');
    check(galletaA && galletaA.name === 'Galleta A' && galletaA.barcode === '999', 'f) al cancelar, el producto no cambia');

    // g) nada de lo anterior toco ventas ni existencias de lo que ya habia
    const after = await snapshot();
    check(after.sales === before.sales, 'g) las ventas quedan intactas');
    check(before.products.every((b) => after.products.some((a) => a.sku === b.sku && a.stock === b.stock && a.name === b.name && a.barcode === b.barcode)),
      'g) los productos que ya existian (nombre, codigo y existencia) quedan intactos');
    check(after.products.length === before.products.length + 5, 'g) se crearon exactamente 5 productos nuevos', `${before.products.length} -> ${after.products.length}`);
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    // La ventana de impresion se reemplaza por una falsa para no esperar a una impresora.
    const fakePrint = () => {
      const w = { document: { open() {}, write() {}, close() {} }, focus() {}, print() {}, close() {} };
      window.open = () => w;
    };
    const dataNow = async () => call('data', {}, (await call('login', { code: '1234' })).sessionToken);
    const sellByScan = async (code) => {
      await page.fill('#scanInput', code);
      await page.press('#scanInput', 'Enter');
      await page.waitForTimeout(300);
      await pay(page);
      await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }).catch(() => {});
      await page.click('#closeReceiptBtn').catch(() => {});
      await page.waitForTimeout(300);
    };

    console.log('\n6) Caja, Corte X, cancelar una venta y Corte Z desde la pantalla');
    await seed();
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await login(page);
    await openCash(page);
    await sellByScan('111');   // Agua 12.5
    await sellByScan('222');   // Refresco 18
    let d = await dataNow();
    check((d.sales || []).length === 2, '6) se registran las dos ventas', `ventas: ${(d.sales || []).length}`);

    await page.evaluate(() => show('cashcut'));
    await page.click('#cashCutXBtn');
    await page.waitForTimeout(1200);
    d = await dataNow();
    const xs = (d.cashCuts || []).filter((c) => c.type === 'x');
    check(xs.length === 1 && xs[0].total === 30.5 && xs[0].salesCount === 2, '6) el Corte X suma las ventas del turno', JSON.stringify(xs.map((c) => [c.total, c.salesCount])));
    check(d.cashState && d.cashState.isOpen === true, '6) el Corte X no cierra la caja');

    const refrescoSale = (d.sales || []).find((s) => String(s.itemsJson || '').includes('P1759000000000ABC'));
    await page.evaluate(() => show('sales'));
    await page.waitForTimeout(400);
    await page.click(`[data-cancel-sale="${refrescoSale.id}"]`);
    await page.waitForSelector('#confirmDialog[open]', { timeout: 4000 }).catch(() => {});
    await page.click('#acceptConfirmBtn');
    await page.waitForTimeout(1200);
    check((await stock('P1759000000000ABC')) === 5, '6) cancelar la venta devuelve el Refresco al inventario (4 -> 5)');
    check((await page.locator(`[data-cancel-sale="${refrescoSale.id}"]`).count()) === 0, '6) una venta cancelada ya no se puede cancelar otra vez');
    check((await stock('P1759000000000ABC')) === 5, '6) el inventario se devuelve una sola vez');

    // con un producto en el ticket, el Corte Z no se permite
    await page.evaluate(() => show('pos'));
    await tapProduct(page, 'BEB-0001');
    await page.evaluate(() => show('cashcut'));
    await page.click('#cashCutZBtn');
    await page.waitForTimeout(500);
    check((await page.locator('#confirmZDialog[open]').count()) === 0, '6) el Corte Z se niega con un ticket sin cobrar');
    try { await toastHas(page, 'No se puede cerrar el turno'); ok('6) avisa por que no se puede hacer el Corte Z'); } catch { bad('6) avisa por que no se puede hacer el Corte Z'); }
    await page.evaluate(() => { state.cart = []; saveCartDraft(); renderCart(); });   // se vacia el ticket

    await page.click('#cashCutZBtn');
    await page.waitForSelector('#confirmZDialog[open]', { timeout: 4000 }).catch(() => {});
    await page.click('#confirmZBtn');
    await page.waitForTimeout(1500);
    d = await dataNow();
    const zs = (d.cashCuts || []).filter((c) => c.type === 'z');
    check(zs.length === 1 && zs[0].total === 12.5 && zs[0].salesCount === 1, '6) el Corte Z no cuenta la venta cancelada', JSON.stringify(zs.map((c) => [c.total, c.salesCount])));
    check(d.cashState && d.cashState.isOpen === false, '6) el Corte Z cierra la caja');
    check((await stock('BEB-0001')) === 9 && (await stock('GRA-0001')) === 7, '6) el inventario solo cambio por lo vendido');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    console.log('\n7) Un cajero abre caja, cobra y hace su corte desde la pantalla');
    await seed();
    const boss7 = await call('login', { code: '1234' });
    await call('save_user', { username: '2001', password: '2001', displayName: 'Ana', role: 'cajero' }, boss7.sessionToken);
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await page.fill('#authCode', '2001');
    await page.press('#authCode', 'Enter');
    await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 8000 });
    check(await page.evaluate(() => state.user && state.user.role === 'cajero'), '7) el cajero entra con su clave');
    await openCash(page);
    await sellByScan('111');
    check((await stock('BEB-0001')) === 9, '7) el cajero cobra y descuenta inventario');
    await page.evaluate(() => show('cashcut'));
    await page.click('#cashCutXBtn');
    await page.waitForTimeout(1200);
    d = await dataNow();
    check((d.cashCuts || []).some((c) => c.type === 'x' && c.total === 12.5), '7) el cajero hace su Corte X');
    check(await page.evaluate(() => !canManage()), '7) el cajero no puede administrar productos');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  console.log(failures ? `\n${failures} PRUEBA(S) FALLARON: NO se debe publicar.` : '\nTodas las pruebas de pantalla pasaron.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
