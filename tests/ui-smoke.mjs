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
          if (cmd === 'check_license') return await window.__bridge('license_status', {}, '');
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

    // Falla reportada: "a veces no se descuentan los productos" y "toma mal los códigos".
    console.log('\n8) Método de descuento: ceros a la izquierda, códigos repetidos y productos sin existencia');
    // NEG-001 viene de una versión vieja (ya estaba en negativo): el diagnóstico lo sigue mostrando
    await seed([product('DUP-0001', '0750100', 'Galleta A', 10, 3), product('DUP-0002', '750100', 'Galleta B', 11, 4), product('CERO-001', '555', 'Chicle', 5, 0), product('NEG-001', '556', 'Mazapán', 4, -2)]);
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await login(page);
    try { await page.waitForSelector('#duplicateCodesDialog[open]', { timeout: 4000 }); ok('8) al entrar avisa que 0750100 y 750100 son el mismo código'); } catch { bad('8) al entrar avisa que 0750100 y 750100 son el mismo código'); }
    await page.click('#closeDuplicateCodesBtn').catch(() => {});
    await openCash(page);
    const scan = async (code) => { await page.fill('#scanInput', code); await page.press('#scanInput', 'Enter'); await page.waitForTimeout(300); };
    await scan('0111');
    check(await page.evaluate(() => state.cart.some((l) => l.sku === 'BEB-0001')), '8) un código con un cero de más se reconoce (0111 = 111)');
    await scan('750100');
    check((await page.locator('#dupScanDialog[open]').count()) > 0, '8) un código repetido abre la ventana "¿cuál producto es?"');
    check((await page.locator('#dupScanList [data-dup-fix]').count()) === 2, '8) la ventana ofrece Corregir para cada producto');
    await page.click('[data-dup-sell="DUP-0002"]');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => state.cart.some((l) => l.sku === 'DUP-0002') && !state.cart.some((l) => l.sku === 'DUP-0001')), '8) se vende el producto elegido, no el primero de la lista');
    // v0.2.18: lo que no hay NO se vende (antes se vendía y quedaba en negativo)
    await scan('555');
    check((await page.locator('#noStockDialog[open]').count()) > 0, '8) un producto sin existencia abre la ventana "Sin existencia"');
    check(await page.evaluate(() => !state.cart.some((l) => l.sku === 'CERO-001')), '8) un producto sin existencia NO entra al ticket');
    await page.click('#cancelNoStockBtn');
    await scan('556');
    check(await page.evaluate(() => !state.cart.some((l) => l.sku === 'NEG-001')), '8) un producto en negativo tampoco se vende');
    await page.click('#cancelNoStockBtn').catch(() => {});
    await pay(page);
    await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }).catch(() => {});
    await page.click('#closeReceiptBtn').catch(() => {});
    await page.waitForTimeout(800);
    const s8 = [await stock('BEB-0001'), await stock('DUP-0002'), await stock('CERO-001')];
    check(JSON.stringify(s8) === JSON.stringify([9, 3, 0]), '8) cada producto se descuenta exacto en la base (Agua 9, Galleta B 3, Chicle sigue en 0)', JSON.stringify(s8));
    check((await stock('DUP-0001')) === 3, '8) el otro producto con el código repetido no se toca');
    const shown8 = await page.evaluate(() => ['BEB-0001', 'DUP-0002', 'CERO-001'].map((s) => state.products.find((p) => p.sku === s)?.stock));
    check(JSON.stringify(shown8) === JSON.stringify([9, 3, 0]), '8) la pantalla muestra las existencias ya descontadas', JSON.stringify(shown8));
    await page.evaluate(() => openDiagnostics());
    await page.waitForSelector('#diagDialog[open]', { timeout: 5000 }).catch(() => {});
    const diagText = await page.locator('#diagBody').innerText().catch(() => '');
    check(/Códigos repetidos \(1\)/.test(diagText) && /Existencia negativa \(1\)/.test(diagText), '8) el diagnóstico muestra el código repetido y la existencia negativa que ya había', diagText.slice(0, 160));
    check((await stock('DUP-0001')) === 3 && (await stock('DUP-0002')) === 3 && (await stock('NEG-001')) === -2, '8) el diagnóstico no corrige nada solo');
    await page.click('#closeDiagBtn').catch(() => {});

    // 8b) Llegó mercancía: se registra la entrada desde la misma ventana y se vende
    await scan('555');
    await page.waitForSelector('#noStockDialog[open]', { timeout: 4000 });
    await page.fill('#noStockQty', '4');
    await page.click('#noStockForm button[type="submit"]');
    await page.waitForFunction(() => state.cart.some((l) => l.sku === 'CERO-001'), null, { timeout: 6000 }).catch(() => {});
    check((await stock('CERO-001')) === 4, '8b) "Registrar entrada" suma lo que llegó en la base', String(await stock('CERO-001')));
    check(await page.evaluate(() => state.cart.some((l) => l.sku === 'CERO-001' && l.qty === 1)), '8b) y el producto entra al ticket');
    const ent8 = (await call('history', { kind: 'moves', from: '2000-01-01T00:00:00Z', to: '' }, (await call('login', { code: '1234' })).sessionToken)).rows.filter((m) => m.sku === 'CERO-001');
    check(ent8.length === 1 && ent8[0].type === 'entrada_compra' && ent8[0].quantity === 4 && ent8[0].stockBefore === 0 && ent8[0].stockAfter === 4, '8b) queda su movimiento de entrada (0 -> 4)', JSON.stringify(ent8.map((m) => [m.type, m.quantity])));
    // 8c) Mientras el ticket esperaba alguien sacó la mercancía: al cobrar se rechaza todo
    const chicle = await call('__test_get_product', { sku: 'CERO-001' });
    await call('__test_put_product', { ...chicle, stock: 0 });
    const sales8 = await page.evaluate(() => state.sales.length);
    await pay(page);
    await page.waitForSelector('#noStockDialog[open]', { timeout: 6000 }).catch(() => {});
    check((await page.locator('#noStockDialog[open]').count()) > 0, '8c) al cobrar sin existencia avisa y ofrece registrar la entrada');
    check((await stock('CERO-001')) === 0, '8c) la base no descuenta nada');
    check(await page.evaluate((n) => state.sales.length === n && state.cart.length > 0, sales8), '8c) no se guarda la venta y el ticket sigue ahí');
    await page.click('#cancelNoStockBtn').catch(() => {});
    await page.evaluate(() => { state.cart = []; clearCartDraft(); renderCart(); show('pos'); });
    await page.click('#closeDiagBtn').catch(() => {});
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    console.log('\n9) Historial: 30 días en pantalla y cualquier fecha con el filtro');
    await seed();
    const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
    await call('__test_put_item', { store: 'sales', id: 'S-HACE-60', data: { id: 'S-HACE-60', timestamp: daysAgo(60), itemsJson: '[]', total: 77, paymentMethod: 'Efectivo', user: 'Admin' } });
    await call('__test_put_item', { store: 'sales', id: 'S-AYER', data: { id: 'S-AYER', timestamp: daysAgo(1), itemsJson: '[]', total: 5, paymentMethod: 'Efectivo', user: 'Admin' } });
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    await page.evaluate(() => show('sales'));
    await page.waitForTimeout(400);
    check((await page.locator('#salesTable', { hasText: 'S-AYER' }).count()) > 0, '9) la venta de ayer se ve sin filtrar');
    check((await page.locator('#salesTable', { hasText: 'S-HACE-60' }).count()) === 0, '9) por defecto se muestran los últimos 30 días');
    const d70 = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 70); return localDay(d); });
    await page.fill('.history-range[data-kind="sales"] [data-range-from]', d70);
    await page.dispatchEvent('.history-range[data-kind="sales"] [data-range-from]', 'change');
    await page.waitForTimeout(1200);
    check((await page.locator('#salesTable', { hasText: 'S-HACE-60' }).count()) > 0, '9) con el filtro aparece la venta de hace 60 días (no se borró)');
    check((await page.locator('#salesTable', { hasText: 'S-AYER' }).count()) > 0, '9) y también las recientes');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    console.log('\n11) Tickets: venta, Corte X y Corte Z con el mismo formato y las mismas opciones (57 mm)');
    await seed();
    await call('__test_put_item', { store: 'cash_cuts', id: 'CORTEZ-VIEJO', data: { id: 'CORTEZ-VIEJO', type: 'z', timestamp: daysAgo(3), periodStart: daysAgo(3.5), periodEnd: daysAgo(3), openingAmount: 300, total: 0, salesCount: 0, payments: {}, user: 'Luis Viejo' } });
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    await openCash(page);
    await page.evaluate(() => show('personalization'));
    await page.click('[data-design-tab="print"]');
    await page.waitForTimeout(300);
    const flagsPerDoc = await page.evaluate(() => ['sale', 'cutX', 'cutZ'].map((d) => PRINT_FLAGS.filter(([k]) => document.getElementById(`print_${d}${k}`)).length));
    check(JSON.stringify(flagsPerDoc) === JSON.stringify([10, 10, 10]), '11) los tres tickets tienen las mismas 10 opciones', JSON.stringify(flagsPerDoc));
    await page.selectOption('#print_printPaperWidth', '57');
    await page.check('#print_printCompact');
    await page.check('#print_cutZShowIva');
    await page.dispatchEvent('#print_cutZShowIva', 'change');
    const shots = process.env.TICKET_SHOTS;
    for (const d of ['sale', 'cutX', 'cutZ']) {
      await page.click(`[data-print-preview="${d}"]`);
      await page.waitForTimeout(200);
      const txt = await page.locator('#printPreview').innerText();
      check(txt.length > 20, `11) vista previa de ${d} se genera`);
      if (d === 'cutZ') check(/IVA/.test(txt), '11) una opción marcada solo para el Corte Z aparece en el Corte Z');
      if (d === 'cutX') check(!/IVA/.test(txt), '11) y no aparece en el Corte X');
      if (shots) await page.locator('#printPreview').screenshot({ path: `${shots}/ticket-${d}.png` }).catch(() => {});
    }
    await page.evaluate(() => document.getElementById('designForm').requestSubmit());
    await page.waitForTimeout(1200);
    const saved11 = (await dataNow()).settings || {};
    check(saved11.printPaperWidth === '57' && saved11.printCompact === true && saved11.cutZShowIva === true && saved11.cutXShowIva === false, '11) las opciones se guardan', JSON.stringify({ p: saved11.printPaperWidth, c: saved11.printCompact, z: saved11.cutZShowIva, x: saved11.cutXShowIva }));
    await page.evaluate(() => viewCashCut('CORTEZ-VIEJO'));
    await page.waitForSelector('#viewCutDialog[open]', { timeout: 5000 }).catch(() => {});
    const cutTxt = await page.locator('#viewCutBody').innerText().catch(() => '');
    check(/Luis Viejo/.test(cutTxt), '11) un corte viejo se muestra con SU usuario (no el de hoy)', cutTxt.slice(0, 120));
    check(/Fondo inicial/.test(cutTxt) && /Efectivo esperado/.test(cutTxt), '11) el corte muestra fondo inicial y efectivo esperado');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    console.log('\n12) Licencia: aviso de 3 días, bloqueo (con corte permitido) y código por teléfono');
    await seed();
    await call('__test_license', { days: 2, enforce: true });
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await login(page);
    await openCash(page);
    await page.evaluate(() => refreshLicense());
    await page.waitForTimeout(400);
    const banner12 = await page.locator('#licenseBanner').innerText().catch(() => '');
    check(/vence el/.test(banner12) && /55 4297 3399/.test(banner12) && /Monto/.test(banner12), '12) aviso: el encargado ve fecha, monto y contacto', banner12);
    await call('__test_license', { days: 0, enforce: true });
    await page.evaluate(() => refreshLicense());
    await page.waitForTimeout(400);
    check(await page.locator('#licenseOverlay').isVisible(), '12) con el bloqueo encendido y vencida, sale la pantalla de suspensión');
    const before12 = await stock('BEB-0001');
    const r12 = await call('checkout', { clientId: 'S-BLOQ', items: [{ sku: 'BEB-0001', qty: 1 }], payments: { Efectivo: 12.5 } }, (await call('login', { code: '1234' })).sessionToken);
    check(r12.ok === false && /BLOQUEO/.test(r12.error || ''), '12) suspendido: no se puede cobrar', JSON.stringify(r12));
    check((await stock('BEB-0001')) === before12, '12) suspendido: el inventario no cambia');
    await page.click('#licenseCutBtn');
    await page.waitForTimeout(400);
    check(!(await page.locator('#licenseOverlay').isVisible()) && (await page.locator('#licenseBanner').isVisible()), '12) se puede ir al corte (queda solo la barra roja)');
    await page.click('#cashCutXBtn');
    await page.waitForTimeout(1200);
    check(((await dataNow()).cashCuts || []).some((c) => c.type === 'x'), '12) suspendido: el Corte X sí se puede hacer');
    await page.evaluate(() => show('pos'));
    await page.waitForTimeout(300);
    await page.evaluate(() => refreshLicense());
    await page.waitForTimeout(300);
    await page.fill('#licenseCodeInput', 'ABCD1234');
    await page.click('#licenseCodeBtn');
    await page.waitForTimeout(500);
    check(await page.locator('#licenseOverlay').isVisible(), '12) un código equivocado no desbloquea');
    const code12 = (await call('__test_unlock_code')).code;
    await page.fill('#licenseCodeInput', code12);
    await page.click('#licenseCodeBtn');
    await page.waitForTimeout(600);
    check(!(await page.locator('#licenseOverlay').isVisible()), '12) el código por teléfono desbloquea');
    await sellByScan('111');
    check((await stock('BEB-0001')) === before12 - 1, '12) después del código se vuelve a cobrar y descuenta');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();
    // el cajero ve un aviso simple
    await seed();
    await call('__test_license', { days: 1, enforce: true });
    const boss12 = await call('login', { code: '1234' });
    await call('save_user', { username: '2001', password: '2001', displayName: 'Ana', role: 'cajero' }, boss12.sessionToken);
    ({ page, errors, context } = await newPage(browser));
    await page.fill('#authCode', '2001');
    await page.press('#authCode', 'Enter');
    await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 8000 });
    await page.evaluate(() => refreshLicense());
    await page.waitForTimeout(400);
    const bannerC = await page.locator('#licenseBanner').innerText().catch(() => '');
    check(/Avísale al encargado/.test(bannerC) && !/Monto/.test(bannerC), '12) el cajero ve "Avísale al encargado" (sin montos)', bannerC);
    await context.close();

    // v0.2.17: usuarios de la caja desde el panel. El PIN llega dentro de la orden y se aplica en la caja.
    console.log('\n13) Usuarios desde el panel: PIN nuevo, rol y desactivar; cobro y corte siguen igual');
    await seed();
    const boss13 = await call('login', { code: '1234' });
    await call('save_user', { username: '2001', password: '2001', displayName: 'Ana', role: 'cajero' }, boss13.sessionToken);
    const ana = (await call('__test_user_uid', { username: '2001' })).uid;
    check(/^U-/.test(ana), '13) cada usuario tiene su identificador interno (no es el PIN)', ana);
    const prods13 = JSON.stringify([await call('__test_get_product', { sku: 'BEB-0001' }), await call('__test_get_product', { sku: 'P1759000000000ABC' })]);
    const pinCmd = { id: '77777777-aaaa-4bbb-8ccc-000000000001', type: 'user_save', payload: { uid: ana, old: { display_name: 'Ana', role: 'cajero', active: true }, display_name: 'Ana López', role: 'encargado', has_pin: true, pin: '2468' } };
    check((await call('__test_apply_command', pinCmd)).status === 'aplicado', '13) la caja aplica el PIN nuevo y el rol');
    check((await call('__test_apply_command', pinCmd)).status === 'aplicado', '13) la misma orden repetida no hace nada dos veces');
    check((await call('__test_user_uid', { username: '2468' })).uid === ana, '13) es el mismo usuario con otro PIN');
    check(!(await call('login', { code: '2001' })).sessionToken, '13) el PIN viejo ya no entra');
    const stale13 = await call('__test_apply_command', { id: '77777777-aaaa-4bbb-8ccc-000000000002', type: 'user_save', payload: { uid: ana, old: { display_name: 'Ana', role: 'cajero', active: true }, display_name: 'Otra', role: 'cajero' } });
    check(stale13.status === 'rechazado', '13) un cambio con datos viejos se rechaza', JSON.stringify(stale13));
    const dupPin = await call('__test_apply_command', { id: '77777777-aaaa-4bbb-8ccc-000000000003', type: 'user_save', payload: { display_name: 'Beto', role: 'cajero', has_pin: true, pin: '1234' } });
    check(dupPin.status === 'rechazado', '13) un PIN que ya usa otro usuario se rechaza', JSON.stringify(dupPin));
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await page.fill('#authCode', '2468');
    await page.press('#authCode', 'Enter');
    await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 8000 });
    check(await page.evaluate(() => state.user && state.user.role === 'encargado' && state.user.displayName === 'Ana López'), '13) entra con el PIN nuevo, con su nombre y rol nuevos');
    await openCash(page);
    await sellByScan('111');
    check((await stock('BEB-0001')) === 9, '13) cobra y descuenta exacto');
    await page.evaluate(() => show('cashcut'));
    await page.click('#cashCutXBtn');
    await page.waitForTimeout(1200);
    d = await dataNow();
    check((d.cashCuts || []).some((c) => c.type === 'x' && c.total === 12.5), '13) hace su Corte X');
    const off13 = await call('__test_apply_command', { id: '77777777-aaaa-4bbb-8ccc-000000000004', type: 'user_save', payload: { uid: ana, old: { display_name: 'Ana López', role: 'encargado', active: true }, display_name: 'Ana López', role: 'encargado', active: false } });
    check(off13.status === 'aplicado', '13) la caja desactiva al usuario');
    check(!(await call('login', { code: '2468' })).sessionToken, '13) un usuario desactivado ya no entra');
    const lastAdmin = await call('__test_apply_command', { id: '77777777-aaaa-4bbb-8ccc-000000000005', type: 'user_save', payload: { uid: (await call('__test_user_uid', { username: '1234' })).uid, old: { role: 'admin', active: true }, display_name: 'Jefe', role: 'admin', active: false } });
    check(lastAdmin.status === 'rechazado', '13) no deja la caja sin administrador activo', JSON.stringify(lastAdmin));
    const after13 = JSON.parse(prods13); after13[0].stock -= 1;
    const now13 = [await call('__test_get_product', { sku: 'BEB-0001' }), await call('__test_get_product', { sku: 'P1759000000000ABC' })];
    check(JSON.stringify(now13.map((p) => [p.name, p.barcode, p.stock])) === JSON.stringify(after13.map((p) => [p.name, p.barcode, p.stock])), '13) productos, códigos y existencias intactos (solo bajó lo vendido)');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    // Falla encontrada: con ~2 meses de historial la copia del navegador llenaba su límite y la app dejaba de abrir.
    console.log('\n10) Volumen: 7,000 ventas (~2 meses) y una copia vieja casi llena en el navegador');
    await seed();
    await call('__test_bulk_sales', { n: 7000 });
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await page.evaluate(() => { try { localStorage.setItem('tiendaInventarioCacheV2', 'x'.repeat(4500000)); } catch (_) {} });
    const t10 = Date.now();
    await page.fill('#authCode', '1234');
    await page.press('#authCode', 'Enter');
    const in10 = await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 30000 }).then(() => true).catch(() => false);
    check(in10, `10) la app abre con 7,000 ventas acumuladas (${Math.round((Date.now() - t10) / 100) / 10} s)`);
    if (in10) {
      await openCash(page);
      await sellByScan('111');
      check((await stock('BEB-0001')) === 9, '10) la base descuenta');
      check(await page.evaluate(() => state.products.find((p) => p.sku === 'BEB-0001')?.stock) === 9, '10) la pantalla muestra lo descontado');
      const chars = await page.evaluate(() => Object.keys(localStorage).reduce((a, k) => a + (localStorage.getItem(k) || '').length, 0));
      check(chars < 1000000, '10) la copia del navegador quedó pequeña (se borró la vieja)', `${chars} caracteres`);
    }
    // 11) Orden del panel web (Fase 4): cambia datos, la pantalla se entera y la existencia no se mueve
    if (in10) {
      await page.evaluate(() => pollRemoteChanges()); // linea base
      await tapProduct(page, 'BEB-0001');
      const before = await call('__test_get_product', { sku: 'BEB-0001' });
      const other = await call('__test_get_product', { sku: 'P1759000000000ABC' });
      const sales = await page.evaluate(() => state.sales.length);
      const next = Number(before.price) + 5;
      const order = (after, was) => ({ id: 'c1', type: 'product_edit', payload: { internal_id: 'BEB-0001', before: was, after } });
      const applied = await call('__test_apply_command', order({ price: next, cost: 3 }, { price: before.price, cost: before.cost }));
      check(applied.status === 'aplicado', '11) la caja aplica la orden del panel', JSON.stringify(applied));
      const rejected = await call('__test_apply_command', order({ stock: 500 }, { stock: before.stock }));
      check(rejected.status === 'rechazado', '11) una orden que pide cambiar la existencia se rechaza');
      await page.evaluate(() => pollRemoteChanges());
      const after = await call('__test_get_product', { sku: 'BEB-0001' });
      check(Number(after.price) === next && Number(after.cost) === 3, '11) precio y costo nuevos en la base');
      check(after.stock === before.stock, '11) la existencia no cambia con la orden', `${before.stock} -> ${after.stock}`);
      check(after.name === before.name && after.barcode === before.barcode && after.sku === before.sku, '11) nombre, código e identificador intactos');
      check(JSON.stringify(await call('__test_get_product', { sku: 'P1759000000000ABC' })) === JSON.stringify(other), '11) los demás productos quedan intactos');
      check(await page.evaluate((n) => state.products.find((p) => p.sku === 'BEB-0001')?.price === n, next), '11) la pantalla toma el precio nuevo');
      check(await page.evaluate((n) => state.cart.find((l) => l.sku === 'BEB-0001')?.price === n, next), '11) el ticket en curso se actualiza');
      check(await page.evaluate((n) => state.sales.length === n, sales), '11) las ventas quedan intactas');

      // 11b) Entrada desde el panel: suma sobre la existencia de HOY y no cuenta doble
      const base = await call('__test_get_product', { sku: 'BEB-0001' });
      const move = { id: '44444444-aaaa-4bbb-8ccc-000000000001', type: 'stock_move', payload: { internal_id: 'BEB-0001', type: 'entrada_compra', quantity: 6, reason: 'Compra', by: 'dueno@correo.com' } };
      check((await call('__test_apply_command', move)).status === 'aplicado', '11b) la caja aplica la entrada del panel');
      await call('__test_apply_command', move);
      await page.evaluate(() => pollRemoteChanges());
      const moved = await call('__test_get_product', { sku: 'BEB-0001' });
      check(moved.stock === base.stock + 6, '11b) la entrada suma una sola vez en la base', `${base.stock} -> ${moved.stock}`);
      check(await page.evaluate((n) => state.products.find((p) => p.sku === 'BEB-0001')?.stock === n, base.stock + 6), '11b) la pantalla muestra la existencia nueva');
      check(moved.name === base.name && moved.barcode === base.barcode && moved.price === base.price, '11b) nombre, código y precio intactos');
      const out = { ...move, id: '44444444-aaaa-4bbb-8ccc-000000000002', payload: { ...move.payload, type: 'merma', quantity: 2 } };
      await call('__test_apply_command', out);
      check((await call('__test_get_product', { sku: 'BEB-0001' })).stock === base.stock + 4, '11b) la merma resta');

      // 11c) Desactivar desde el panel: sale de la venta sin borrarse
      const off = (active) => ({ id: 'x', type: 'product_active', payload: { internal_id: 'P1759000000000ABC', active } });
      check((await call('__test_apply_command', off(false))).status === 'aplicado', '11c) la caja desactiva el producto');
      await page.evaluate(() => pollRemoteChanges());
      check(await page.evaluate(() => !productsInCategory('Bebidas').some((p) => p.sku === 'P1759000000000ABC')), '11c) ya no aparece en la venta');
      const offP = await call('__test_get_product', { sku: 'P1759000000000ABC' });
      check(offP.stock === other.stock && offP.name === other.name, '11c) conserva existencia y nombre');
      await call('__test_apply_command', off(true));
      await page.evaluate(() => pollRemoteChanges());
      check(await page.evaluate(() => productsInCategory('Bebidas').some((p) => p.sku === 'P1759000000000ABC')), '11c) al activarlo vuelve a la venta');

      // 11d) Alta desde el panel: nace con existencia 0 y respeta los códigos únicos
      await call('__test_put_item', { store: 'categories', id: 'CAT-BOT', data: { id: 'CAT-BOT', name: 'Botanas', active: true } });
      const count0 = await page.evaluate(() => state.products.length);
      const alta = (id, barcode) => ({ id, type: 'product_create', payload: { barcode, name: 'Papas 45 g', category: 'Botanas', cost: 10, price: 18, min_stock: 2 } });
      check((await call('__test_apply_command', alta('55555555-aaaa-4bbb-8ccc-000000000001', '7501234'))).status === 'aplicado', '11d) la caja da de alta el producto del panel');
      const dupe = await call('__test_apply_command', alta('55555555-aaaa-4bbb-8ccc-000000000002', '0111'));
      check(dupe.status === 'rechazado' && dupe.result.includes('Agua'), '11d) un código que ya existe (con ceros) se rechaza', JSON.stringify(dupe));
      await page.evaluate(() => pollRemoteChanges());
      const nuevo = await page.evaluate(() => state.products.find((p) => p.barcode === '7501234'));
      check(nuevo && nuevo.stock === 0 && nuevo.price === 18, '11d) aparece en la pantalla con existencia 0', JSON.stringify(nuevo));
      check(await page.evaluate((n) => state.products.length === n + 1, count0), '11d) solo se agrega uno');
      check((await call('__test_get_product', { sku: 'BEB-0001' })).stock === base.stock + 4, '11d) los demás productos quedan intactos');
      check(await page.evaluate((n) => state.sales.length === n, sales), '11d) las ventas quedan intactas');

      // 11e) Renombrar una categoría desde el panel (v0.2.16): cambia SOLO la categoría de sus productos
      await page.evaluate(() => { state.cart = []; clearCartDraft(); renderCart(); }); // el ticket del caso 11 no se cobra
      const catId = await page.evaluate(() => state.categories.find((c) => c.name === 'Bebidas')?.id || '');
      if (!catId) await call('__test_put_item', { store: 'categories', id: 'CAT-BEB', data: { id: 'CAT-BEB', name: 'Bebidas', active: true } });
      const bebId = catId || 'CAT-BEB';
      const prods0 = await page.evaluate(() => state.products.map((p) => ({ ...p })));
      const bebidas0 = await Promise.all(prods0.filter((p) => p.category === 'Bebidas').map((p) => call('__test_get_product', { sku: p.sku })));
      const others0 = await Promise.all(prods0.filter((p) => p.category !== 'Bebidas').map((p) => call('__test_get_product', { sku: p.sku })));
      const ren = (id, from, to) => ({ id, type: 'catalog_save', payload: { kind: 'category', id: bebId, old_name: from, name: to, by: 'dueno@correo.com' } });
      const r1 = await call('__test_apply_command', ren('66666666-aaaa-4bbb-8ccc-000000000001', 'Bebidas', 'Bebidas frías'));
      check(r1.status === 'aplicado', '11e) la caja aplica el cambio de nombre de la categoría', JSON.stringify(r1));
      const dupCat = await call('__test_apply_command', { id: '66666666-aaaa-4bbb-8ccc-000000000002', type: 'catalog_save', payload: { kind: 'category', name: 'botanas' } });
      check(dupCat.status === 'rechazado' && dupCat.result.includes('Ya existe'), '11e) un nombre repetido se rechaza', JSON.stringify(dupCat));
      await page.evaluate(() => pollRemoteChanges());
      let renOk = bebidas0.length > 0;
      for (const b of bebidas0) {
        const a = await call('__test_get_product', { sku: b.sku });
        if (a.category !== 'Bebidas frías' || a.stock !== b.stock || a.price !== b.price || a.cost !== b.cost || a.name !== b.name || a.barcode !== b.barcode || a.active !== b.active) renOk = false;
      }
      check(renOk, '11e) sus productos cambian de categoría con precio, código, nombre y existencia intactos', `${bebidas0.length} productos`);
      let othersOk = true;
      for (const b of others0) if (JSON.stringify(await call('__test_get_product', { sku: b.sku })) !== JSON.stringify(b)) othersOk = false;
      check(othersOk, '11e) los productos de otras categorías quedan idénticos');
      check(await page.evaluate(() => state.categories.some((c) => c.name === 'Bebidas frías') && productsInCategory('Bebidas frías').some((p) => p.sku === 'BEB-0001')), '11e) la pantalla ve la categoría nueva con sus productos');
      check(await page.evaluate((n) => state.sales.length === n, sales), '11e) las ventas quedan intactas');
      const s11e = await stock('BEB-0001');
      await sellByScan('111');
      check((await stock('BEB-0001')) === s11e - 1, '11e) se sigue vendiendo y descontando con la categoría nueva');
      await call('__test_apply_command', ren('66666666-aaaa-4bbb-8ccc-000000000003', 'Bebidas frías', 'Bebidas'));
      await page.evaluate(() => pollRemoteChanges());
      check((await call('__test_get_product', { sku: 'BEB-0001' })).category === 'Bebidas', '11e) se puede regresar al nombre anterior');

      // 11f) Kardex por producto: muestra sus movimientos y no cambia nada
      const k0 = await call('__test_get_product', { sku: 'BEB-0001' });
      await page.evaluate(() => show('kardex'));
      await page.waitForSelector('#view-kardex:not(.hide)', { timeout: 4000 });
      await page.fill('#kardexSearch', '0111');
      await page.click('#kardexRunBtn');
      await page.waitForFunction(() => document.querySelectorAll('#kardexTable tbody tr').length > 0, null, { timeout: 6000 });
      const kTxt = await page.locator('#kardexTable').innerText();
      check(['Venta', 'Entrada', 'Merma'].every((t) => kTxt.includes(t)), '11f) el kardex muestra ventas, entradas y mermas del producto');
      check(!kTxt.includes('Papas 45 g'), '11f) solo trae movimientos de ese producto');
      const kSum = await page.locator('#kardexSummary').innerText();
      check(kSum.includes(String(k0.stock)), '11f) el resumen muestra la existencia actual', kSum.replace(/\s+/g, ' '));
      check(JSON.stringify(await call('__test_get_product', { sku: 'BEB-0001' })) === JSON.stringify(k0), '11f) consultar no cambia el producto');
      await page.evaluate(() => show('pos'));

      // 11g) Atajos: F6 deja el ticket en espera, F9 cobra y F10 abre el corte
      await tapProduct(page, 'BEB-0001');
      const held0 = await page.evaluate(() => state.heldTickets.length);
      await page.keyboard.press('F6');
      check(await page.evaluate((n) => state.heldTickets.length === n + 1 && state.cart.length === 0, held0), '11g) F6 deja el ticket en espera');
      await page.evaluate(() => resumeHeldTicket(state.heldTickets[0].id));
      check(await page.evaluate((n) => state.heldTickets.length === n && state.cart.length === 1, held0), '11g) el ticket en espera se recupera completo');
      const s11g = await stock('BEB-0001');
      const sales11g = await page.evaluate(() => state.sales.length);
      await page.keyboard.press('F9');
      check(await page.evaluate(() => state.view === 'checkout'), '11g) F9 abre el cobro');
      await page.click('#autoFillPaymentBtn');
      await page.click('#addPaymentBtn');
      await page.keyboard.press('F9');
      await page.waitForFunction(() => state.cart.length === 0, null, { timeout: 6000 }).catch(() => {});
      check((await stock('BEB-0001')) === s11g - 1, '11g) F9 otra vez cobra y descuenta una sola vez', `${s11g} -> ${await stock('BEB-0001')}`);
      check(await page.evaluate((n) => state.sales.length === n + 1, sales11g), '11g) queda una venta');
      await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }).catch(() => {});
      await page.click('#closeReceiptBtn').catch(() => {});
      await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); show('pos'); });
      await page.keyboard.press('F9');
      check(await page.evaluate(() => state.view === 'pos'), '11g) F9 con el ticket vacío no abre el cobro');
      await page.keyboard.press('F10');
      check(await page.evaluate(() => state.view === 'cashcut'), '11g) F10 abre el corte de caja');
      await page.evaluate(() => show('pos'));
    }
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    console.log('\n14) Sin existencia con un cajero: la entrada pide el PIN de un encargado o administrador');
    await seed([product('CERO-002', '557', 'Paleta', 6, 0)]);
    const boss14 = await call('login', { code: '1234' });
    await call('save_user', { username: '2001', password: '2001', displayName: 'Ana', role: 'cajero' }, boss14.sessionToken);
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await page.fill('#authCode', '2001');
    await page.press('#authCode', 'Enter');
    await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 8000 });
    await openCash(page);
    await page.fill('#scanInput', '557');
    await page.press('#scanInput', 'Enter');
    await page.waitForSelector('#noStockDialog[open]', { timeout: 4000 }).catch(() => {});
    check((await page.locator('#noStockDialog[open]').count()) > 0, '14) el cajero ve "Sin existencia"');
    await page.fill('#noStockQty', '2');
    await page.click('#noStockForm button[type="submit"]');
    await page.waitForSelector('#supervisorDialog[open]', { timeout: 4000 }).catch(() => {});
    check((await page.locator('#supervisorDialog[open]').count()) > 0, '14) pide el PIN de un encargado o administrador');
    await page.fill('#supervisorCode', '2001');
    await page.press('#supervisorCode', 'Enter');
    await page.waitForTimeout(900);
    check((await stock('CERO-002')) === 0, '14) el PIN de un cajero no autoriza la entrada');
    await page.fill('#supervisorCode', '1234');
    await page.press('#supervisorCode', 'Enter');
    await page.waitForFunction(() => state.cart.some((l) => l.sku === 'CERO-002'), null, { timeout: 6000 }).catch(() => {});
    check((await stock('CERO-002')) === 2, '14) con el PIN del administrador entra la mercancía', String(await stock('CERO-002')));
    const m14 = (await call('history', { kind: 'moves', from: '2000-01-01T00:00:00Z', to: '' }, boss14.sessionToken)).rows.filter((m) => m.sku === 'CERO-002');
    check(m14.length === 1 && m14[0].user === 'Ana' && m14[0].authorizedBy === 'Admin', '14) el movimiento dice quién la registró y quién autorizó', JSON.stringify(m14.map((m) => [m.user, m.authorizedBy])));
    if (await page.locator('#lowStockDialog[open]').count()) await page.click('#lowStockOkBtn'); // queda 1: aviso de inventario bajo
    await pay(page);
    await page.waitForSelector('#receiptDialog[open]', { timeout: 8000 }).catch(() => {});
    await page.click('#closeReceiptBtn').catch(() => {});
    await page.waitForTimeout(600);
    check((await stock('CERO-002')) === 1, '14) se cobra y descuenta exacto (2 -> 1)');
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    // Falla reportada: F2/F4 tardaban varios segundos con meses de historial
    console.log('\n15) Rapidez: F2 y F4 con 470 productos y 5,000 movimientos');
    await call('__test_reset');
    for (let i = 0; i < 470; i++) await call('__test_put_product', product('V' + (1000 + i), String(7500000000000 + i), 'Producto ' + i, 10, 5));
    await call('__test_bulk_moves', { n: 5000, sku: 'V1000' });
    ({ page, errors, context } = await newPage(browser));
    await login(page);
    await openCash(page).catch(() => {});
    const timeKey = async (key, sel) => {
      const t = Date.now();
      await page.keyboard.press(key);
      await page.waitForSelector(sel + ':not(.hide)', { timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('#movesTable') || state.view !== 'movements' || document.querySelectorAll('#movesTable tbody tr').length > 0, null, { timeout: 30000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return Date.now() - t;
    };
    await timeKey('F4', '#view-movements'); // la primera vez trae el historial de 30 días (en segundo plano)
    await page.waitForFunction(() => state.range && state.range.moves && state.range.moves.key && !state.range.moves.pendingKey, null, { timeout: 30000 });
    await timeKey('F1', '#view-pos');
    const t15 = [];
    for (let i = 0; i < 3; i++) { t15.push(await timeKey('F4', '#view-movements')); t15.push(await timeKey('F2', '#view-design')); await timeKey('F1', '#view-pos'); }
    check(Math.max(...t15) < 1500, `15) F4 y F2 abren rápido (máximo ${Math.max(...t15)} ms)`, JSON.stringify(t15));
    await page.keyboard.press('F4');
    await page.waitForSelector('#view-movements:not(.hide)');
    const rows15 = await page.locator('#movesTable tbody tr').count();
    check(rows15 === 200, '15) Movimientos dibuja las 200 filas más recientes', String(rows15));
    check(await page.evaluate(() => document.querySelectorAll('#productsTable tbody tr').length === 0), '15) no dibuja la tabla de productos que no se ve');
    await page.click('[data-more-rows="moves"]');
    check((await page.locator('#movesTable tbody tr').count()) === 400, '15) "Mostrar más" agrega 200 filas');
    const csv15 = await page.evaluate(() => rangeRows('moves', state.moves).length);
    check(csv15 >= 4000, '15) el historial completo del periodo sigue disponible (filtro y archivo)', String(csv15));
    check(errors.length === 0, 'sin errores de JavaScript', errors.join(' | '));
    await context.close();

    // Reportes de tienda: "el flan desapareció" (merma en vez de entrada, sin saber quién) y
    // "los bimbuñuelos no aparecen" (se buscaban sin ñ)
    console.log('\n16) Quién hizo cada cambio, motivo en salidas y mermas, aviso al guardar y búsqueda sin acentos');
    await seed([product('BIM-0001', '7501030472698', 'Bimbuñuelos', 22, 5), product('FLA-0001', '7501020510041', 'Flan lala', 10, 9)]);
    await call('save_catalog', { kind: 'category', name: 'Bebidas' }, (await call('login', { code: '1234' })).sessionToken);
    ({ page, errors, context } = await newPage(browser));
    await page.evaluate(fakePrint);
    await login(page);
    await openCash(page).catch(() => {});
    await page.fill('#saleSearchInput', 'bimbunuelos');
    await page.evaluate(() => renderSaleSearch());
    check(await page.locator('#saleSearchResults [data-add="BIM-0001"]').count() === 1, '16) buscar "bimbunuelos" (sin ñ) encuentra "Bimbuñuelos"');
    await page.fill('#saleSearchInput', '');
    await page.evaluate(() => renderSaleSearch());
    const token16 = (await call('login', { code: '1234' })).sessionToken;
    const moves16 = async (sku) => (await call('history', { kind: 'moves', from: '2000-01-01T00:00:00Z', to: '' }, token16)).rows.filter((m) => m.sku === sku);
    await page.evaluate(() => { show('movements'); });
    await page.waitForSelector('#view-movements:not(.hide)');
    const pick16 = async (sku, qty, type) => {
      await page.evaluate(([t]) => setMoveType(t), [type]);
      await page.selectOption('#moveCategory', 'Bebidas');
      await page.selectOption('#moveSku', sku);
      await page.fill('#moveQty', String(qty));
    };
    // merma sin motivo: no se registra
    await pick16('FLA-0001', 9, 'merma');
    await page.evaluate(() => document.getElementById('movementForm').requestSubmit());
    await page.waitForTimeout(500);
    check((await stock('FLA-0001')) === 9 && (await page.locator('#confirmDialog[open]').count()) === 0, '16) una merma sin motivo no se registra');
    // con motivo: pide confirmar diciendo cómo queda la existencia; si se cancela, nada cambia
    await page.fill('#moveReason', 'Caducado');
    await page.evaluate(() => document.getElementById('movementForm').requestSubmit());
    await page.waitForSelector('#confirmDialog[open]', { timeout: 4000 }).catch(() => {});
    const conf16 = await page.locator('#confirmMessage').innerText().catch(() => '');
    check(/Merma de 9/.test(conf16) && /de 9 a 0/.test(conf16) && /Flan lala/.test(conf16), '16) la merma pide confirmar con producto, cantidad y existencia (9 → 0)', conf16);
    await page.click('#cancelConfirmBtn');
    await page.waitForTimeout(300);
    check((await stock('FLA-0001')) === 9 && (await moves16('FLA-0001')).length === 0, '16) al cancelar no se registra nada');
    // entrada de 8: aviso grande con lo que se guardó
    await pick16('FLA-0001', 8, 'entrada_compra');
    await page.evaluate(() => document.getElementById('movementForm').requestSubmit());
    await page.waitForFunction(() => /Flan lala/.test(document.getElementById('moveResult')?.textContent || ''), null, { timeout: 6000 }).catch(() => {});
    const res16 = await page.locator('#moveResult').innerText().catch(() => '');
    check((await stock('FLA-0001')) === 17 && /Entrada/.test(res16) && /\+8/.test(res16) && /17/.test(res16), '16) al guardar se ve en grande: "Entrada: Flan lala +8 → existencia 17"', res16);
    // merma confirmada: queda con motivo y usuario
    await pick16('FLA-0001', 2, 'merma');
    await page.fill('#moveReason', 'Caducado');
    await page.evaluate(() => document.getElementById('movementForm').requestSubmit());
    await page.waitForSelector('#confirmDialog[open]', { timeout: 4000 }).catch(() => {});
    await page.click('#acceptConfirmBtn');
    await page.waitForFunction(() => /Merma/.test(document.getElementById('moveResult')?.textContent || ''), null, { timeout: 6000 }).catch(() => {});
    const m16 = (await moves16('FLA-0001')).find((m) => m.type === 'merma');
    check((await stock('FLA-0001')) === 15 && m16 && m16.reason === 'Caducado' && m16.user === 'Admin', '16) la merma queda con su motivo y quién la hizo', JSON.stringify(m16 && [m16.reason, m16.user]));
    check(/Registrados antes/.test(await page.locator('#moveResult').innerText()), '16) el aviso muestra también lo registrado antes');
    check(/Admin/.test(await page.locator('#movesTable').innerText()) && /Caducado/.test(await page.locator('#movesTable').innerText()), '16) la tabla de movimientos muestra usuario y motivo');
    // editar el precio en la caja queda registrado con el cambio y quién lo hizo
    await page.evaluate(() => { show('products'); editProduct('BIM-0001'); });
    await page.fill('#priceInput', '25');
    await page.evaluate(() => document.getElementById('productForm').requestSubmit());
    await page.waitForTimeout(1200);
    const ed16 = (await moves16('BIM-0001')).filter((m) => m.type === 'edicion_producto');
    check(ed16.length === 1 && /Precio: \$22\.00 → \$25\.00/.test(ed16[0].notes) && ed16[0].user === 'Admin', '16) editar el precio queda registrado (Precio: $22.00 → $25.00, Admin)', JSON.stringify(ed16.map((m) => [m.notes, m.user])));
    check((await stock('BIM-0001')) === 5, '16) editar no cambia la existencia');
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
