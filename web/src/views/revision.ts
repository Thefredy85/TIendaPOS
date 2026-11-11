import type { Ctx } from '../main';
import { listProducts, salesWithoutMoves, suspiciousProducts, type Product, type SaleWithoutMove, type SuspiciousProduct } from '../api';
import { codeKey, daysAgoIso, esc, fmtDateTime, fmtMoney, fmtQty, icon, paintIcons, rangeOf, todayIso } from '../ui';
import { downloadXlsx } from '../xlsx';

// Revisión del inventario con los datos de la nube. Solo muestra: nada se corrige solo.
interface Section { key: string; title: string; help: string; count: number; html: string; header: string[]; rows: unknown[][] }

const prodLine = (p: Product, extra = '') => `<li><div class="grow"><div><b>${esc(p.name ?? 'Sin nombre')}</b>${p.active === false ? ' <span class="pill off">desactivado</span>' : ''}</div>
  <div class="small muted">${esc(p.barcode ?? 'sin código')}${p.category ? ` · ${esc(p.category)}` : ''}${extra}</div></div>
  <div class="right num">${fmtQty(p.stock)}</div></li>`;

const prodRow = (p: Product) => [p.barcode, p.name, p.category, p.cost, p.price, p.stock, p.active !== false];
const PROD_HEADER = ['Código de barras', 'Nombre', 'Categoría', 'Costo', 'Precio', 'Existencia', 'Activo'];

export async function renderRevision(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Revisión del inventario con los datos de la nube. Solo muestra: nada se corrige solo.';
  el.innerHTML = `<div class="filters">
      <label>Ventas desde<input type="date" id="f-from" value="${daysAgoIso(29)}" max="${todayIso()}"></label>
      <label>Hasta<input type="date" id="f-to" value="${todayIso()}" max="${todayIso()}"></label>
      <button class="btn" id="xlsx">${icon('file-spreadsheet')} Excel</button>
    </div>
    <div class="kpis" id="sum"></div>
    <div id="out"><div class="card empty">Revisando…</div></div>`;
  paintIcons();
  const from = el.querySelector<HTMLInputElement>('#f-from')!;
  const to = el.querySelector<HTMLInputElement>('#f-to')!;
  const out = el.querySelector<HTMLElement>('#out')!;
  let sections: Section[] = [];
  let seq = 0;

  const build = (products: Product[], missing: SaleWithoutMove[], renamed: SuspiciousProduct[]): Section[] => {
    const groups = new Map<string, Product[]>();
    for (const p of products) { const k = codeKey(p.barcode); if (k) groups.set(k, [...(groups.get(k) ?? []), p]); }
    const dups = [...groups.values()].filter((g) => g.length > 1);
    const neg = products.filter((p) => (p.stock ?? 0) < 0).sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
    const noCost = products.filter((p) => p.active !== false && !p.cost);
    const loss = products.filter((p) => p.active !== false && (p.cost ?? 0) > 0 && (p.price ?? 0) > 0 && (p.price ?? 0) <= (p.cost ?? 0));
    return [
      { key: 'dup', title: 'Códigos de barras repetidos', count: dups.length,
        help: 'Dos o más productos con el mismo código (con o sin ceros). Al escanear, la caja pregunta cuál es. Corrígelos en la caja.',
        html: dups.map((g) => `<li class="assign"><div class="grow"><div><b>Código ${esc(g[0].barcode)}</b></div>
          ${g.map((p) => `<div class="small">${esc(p.name ?? 'Sin nombre')} · existencia ${fmtQty(p.stock)}${p.active === false ? ' · desactivado' : ''}</div>`).join('')}</div></li>`).join(''),
        header: ['Código', ...PROD_HEADER], rows: dups.flatMap((g) => g.map((p) => [codeKey(p.barcode), ...prodRow(p)])) },
      { key: 'neg', title: 'Existencia en negativo', count: neg.length,
        help: 'Se vendió más de lo registrado. Suele faltar una entrada de mercancía o un conteo.',
        html: neg.map((p) => prodLine(p)).join(''), header: PROD_HEADER, rows: neg.map(prodRow) },
      { key: 'cost', title: 'Sin costo', count: noCost.length,
        help: 'Sin costo no se puede calcular la ganancia. Se captura con Editar en Inventario.',
        html: noCost.map((p) => prodLine(p, ` · precio ${fmtMoney(p.price)}`)).join(''), header: PROD_HEADER, rows: noCost.map(prodRow) },
      { key: 'loss', title: 'Precio igual o menor que el costo', count: loss.length,
        help: 'Se vende sin ganancia o con pérdida. Puede ser un error de captura.',
        html: loss.map((p) => prodLine(p, ` · costo ${fmtMoney(p.cost)} · precio ${fmtMoney(p.price)}`)).join(''), header: PROD_HEADER, rows: loss.map(prodRow) },
      { key: 'miss', title: 'Ventas que no descontaron inventario', count: missing.length,
        help: 'Líneas de venta (no canceladas) del periodo sin su movimiento de salida en la nube. Puede ser una falla o que la caja aún no termina de subir los datos.',
        html: missing.map((m) => `<li><div class="grow"><div><b>${esc(m.name ?? 'Producto')}</b></div>
          <div class="small muted">${esc(fmtDateTime(m.ts))} · folio ${esc(m.sale_id)}</div></div><div class="right num">${fmtQty(m.qty)}</div></li>`).join(''),
        header: ['Fecha', 'Folio', 'Producto', 'Cantidad'], rows: missing.map((m) => [fmtDateTime(m.ts), m.sale_id, m.name, m.qty]) },
      { key: 'ren', title: 'Nombre distinto al de sus ventas', count: renamed.length,
        help: 'El nombre actual no coincide con el que tenía en ventas o movimientos. Puede ser un cambio de nombre normal o un producto pisado por la falla de v0.2.9 a v0.2.11 (al dar de alta uno nuevo se sobrescribía el que estaba en edición). Revisa cada caso; nada se corrige solo.',
        html: renamed.map((r) => `<li class="assign"><div class="grow"><div><b>${esc(r.name ?? 'Sin nombre')}</b> <span class="small muted">${esc(r.barcode ?? 'sin código')}</span></div>
          <div class="small">Antes se llamaba: ${r.old_names.map(esc).join(', ')}</div>
          <div class="small muted">${r.lines} registros · último ${esc(fmtDateTime(r.last_seen))}</div></div><div class="right num">${fmtQty(r.stock)}</div></li>`).join(''),
        header: ['Código de barras', 'Nombre actual', 'Nombres anteriores', 'Registros', 'Último registro', 'Existencia'],
        rows: renamed.map((r) => [r.barcode, r.name, r.old_names.join(' | '), r.lines, fmtDateTime(r.last_seen), r.stock]) },
    ];
  };

  const draw = () => {
    el.querySelector('#sum')!.innerHTML = sections.map((s) => `<a class="card kpi" href="#rev-${s.key}" style="text-decoration:none;color:inherit">
      <small>${esc(s.title)}</small><b${s.count ? ' style="color:var(--warn)"' : ''}>${s.count}</b></a>`).join('');
    out.innerHTML = sections.map((s) => `<div class="section-title" id="rev-${s.key}">${esc(s.title)} <span class="pill ${s.count ? 'wait' : 'ok'}">${s.count || 'Bien'}</span></div>
      <p class="small muted" style="margin:-4px 0 8px">${esc(s.help)}</p>
      ${s.count ? `<ul class="list card">${s.html}</ul>` : '<div class="card empty small">Nada que revisar.</div>'}`).join('');
  };

  const load = async () => {
    const my = ++seq;
    out.innerHTML = '<div class="card empty">Revisando…</div>';
    try {
      const [f, t] = rangeOf(from.value, to.value);
      const [products, missing, renamed] = await Promise.all([
        listProducts(ctx.business.id), salesWithoutMoves(ctx.business.id, f, t), suspiciousProducts(ctx.business.id)]);
      if (my !== seq) return;
      sections = build(products, missing, renamed);
      draw();
    } catch (e) {
      if (my === seq) out.innerHTML = `<div class="card empty">No se pudo revisar: ${esc((e as Error).message)}</div>`;
    }
  };

  from.onchange = load;
  to.onchange = load;
  el.querySelector<HTMLButtonElement>('#xlsx')!.onclick = () => downloadXlsx(
    `revision-${ctx.business.name || ctx.business.license_key}-${todayIso()}.xlsx`,
    sections.map((s) => ({ name: s.title, header: s.header, rows: s.rows })));
  await load();
}
