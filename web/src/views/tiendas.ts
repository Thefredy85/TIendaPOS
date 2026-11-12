import type { Ctx } from '../main';
import { addMember, createAccount, listAllDevices, listBusinesses, listLicenses, listUnassignedAccounts, salesSince, type Business, type Device, type UnassignedAccount } from '../api';
import { askConfirm, dayRange, esc, fmtDate, fmtMoney, fmtToday, icon, paintIcons, todayIso, toast } from '../ui';
import { licenseState, localIso } from '../licencia-fechas';
import { deviceName, deviceState } from './cajas';
import { askResetPassword, showCredentials, tempPassword } from './cuentas-ui';

const PILL = { none: 'off', ok: 'ok', soon: 'wait', expired: 'wait', suspended: 'bad' } as const;

// Solo el superadmin: un vistazo a todas las tiendas a la vez
export async function renderTiendas(ctx: Ctx, el: HTMLElement) {
  const sub = document.getElementById('sub')!;
  if (ctx.role !== 'superadmin') {
    el.innerHTML = '<div class="card empty">Solo el administrador del sistema ve todas las tiendas.</div>';
    return;
  }
  // Cajas aparte: el refresco de las tiendas no debe borrar lo que se está escribiendo abajo
  el.innerHTML = '<div id="t-main"><div class="card empty">Cargando…</div></div><div id="t-nueva"></div><div id="t-cuentas"></div>';
  const main = el.querySelector<HTMLElement>('#t-main')!;
  const nueva = el.querySelector<HTMLElement>('#t-nueva')!;
  const box = el.querySelector<HTMLElement>('#t-cuentas')!;
  let known: Business[] = [];
  const twins = (b: Business) => known.filter((x) => (x.name || x.license_key) === (b.name || b.license_key)).length > 1;
  const storeOptions = () => known.map((b) => `<option value="${b.id}">${esc(b.name || b.license_key)}${twins(b) ? ` (${esc(b.license_key)})` : ''}</option>`).join('');
  const ROLE_OPTIONS = '<option value="owner">Dueño</option><option value="gestor">Gestor (solo consulta)</option>';

  const draw = async () => {
    let businesses: Business[], devices: Device[], licenses, sales;
    try {
      [businesses, devices, licenses, sales] = await Promise.all([
        listBusinesses(), listAllDevices(), listLicenses(), salesSince(dayRange(todayIso())[0])]);
    } catch (e) {
      main.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      return;
    }
    known = businesses;
    sub.textContent = fmtToday();
    const today = localIso(new Date());
    const lic = new Map(licenses.map((l) => [l.business_id, l]));
    const rows = businesses.map((b) => {
      const devs = devices.filter((d) => d.business_id === b.id && d.status !== 'revocado');
      const mine = sales.filter((s) => s.business_id === b.id && !s.cancelled);
      const l = lic.get(b.id) ?? null;
      return {
        b, devs,
        total: mine.reduce((a, s) => a + (s.total ?? 0), 0), tickets: mine.length,
        st: licenseState(l?.paid_until ?? null, l?.enforce ?? false, today), enforce: l?.enforce ?? false,
      };
    });
    const online = devices.filter((d) => deviceState(d).cls === 'ok').length;
    const pending = devices.filter((d) => d.status === 'pendiente').length;
    const total = rows.reduce((a, r) => a + r.total, 0);

    main.innerHTML = `
      <div class="kpis">
        <div class="card kpi"><small>Tiendas</small><b>${businesses.length}</b></div>
        <div class="card kpi"><small>Cajas en línea</small><b>${online}</b></div>
        <div class="card kpi"><small>Ventas de hoy (todas)</small><b>${fmtMoney(total)}</b></div>
        ${pending ? `<div class="card kpi"><small>Cajas por aprobar</small><b style="color:var(--warn)">${pending}</b></div>` : ''}
      </div>
      <ul class="list card">${rows.map((r) => {
        const devLine = r.devs.length
          ? r.devs.map((d) => { const s = deviceState(d); return `<span class="pill ${s.cls}"><span class="dot ${s.cls}"></span>${esc(deviceName(d))} · ${s.label}${d.app_version ? ` · v${esc(d.app_version)}` : ''}</span>`; }).join(' ')
          : '<span class="pill off">Sin caja conectada (falta instalar la v0.2.14)</span>';
        return `<li class="click" data-biz="${r.b.id}">
          <div class="grow"><div><b>${esc(r.b.name || r.b.license_key)}</b>${twins(r.b) ? ` <span class="small muted">${esc(r.b.license_key)}</span>` : ''}</div>
            <div class="small" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${devLine}
              <span class="pill ${PILL[r.st.state]}">${icon('key-round')} ${esc(r.st.label)}${r.st.state !== 'none' ? (r.enforce ? ' · bloqueo encendido' : ' · bloqueo apagado') : ''}</span></div></div>
          <div class="right"><b class="num">${fmtMoney(r.total)}</b><div class="small muted">${r.tickets} ticket${r.tickets === 1 ? '' : 's'} hoy</div></div>
          ${icon('chevron-right')}</li>`;
      }).join('')}</ul>
      <p class="small muted">Toca una tienda para ver su panel completo.</p>`;
    paintIcons();
    main.querySelectorAll<HTMLElement>('[data-biz]').forEach((li) => { li.onclick = () => ctx.openBusiness(li.dataset.biz!); });
  };

  const drawNew = () => {
    nueva.innerHTML = `<div class="section-title">${icon('user-plus')} Crear cuenta</div>
      <form class="card pad" id="na-form">
        <div class="filters" style="margin:0">
          <label class="grow-field">Correo<input type="email" id="na-email" required autocomplete="off" placeholder="correo@ejemplo.com"></label>
          <label>Contraseña temporal<input id="na-pass" required minlength="8" maxlength="72" autocomplete="off" spellcheck="false" value="${tempPassword()}"></label>
          <label>Tienda<select id="na-store" required><option value="">Elige la tienda…</option>${storeOptions()}</select></label>
          <label>Acceso<select id="na-role">${ROLE_OPTIONS}</select></label>
          <button class="btn primary" type="submit">${icon('user-plus')} Crear cuenta</button>
        </div>
        <p class="small muted" style="margin:10px 0 0">Al entrar por primera vez, la persona tendrá que elegir su propia contraseña.</p>
      </form>`;
    paintIcons();
    const form = nueva.querySelector<HTMLFormElement>('#na-form')!;
    const field = <T extends HTMLElement>(id: string) => form.querySelector<T>(`#${id}`)!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const email = field<HTMLInputElement>('na-email').value.trim();
      const password = field<HTMLInputElement>('na-pass').value;
      const store = field<HTMLSelectElement>('na-store');
      const access = field<HTMLSelectElement>('na-role');
      if (!await askConfirm(`¿Crear la cuenta ${email} con acceso de ${access.selectedOptions[0].text} en "${store.selectedOptions[0].text}"?`)) return;
      const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      btn.disabled = true;
      try {
        await createAccount(email, password, store.value, access.value as 'owner' | 'gestor');
        showCredentials('Cuenta creada', email, password);
        drawNew();
      } catch (err) {
        btn.disabled = false;
        toast((err as Error).message);
      }
    };
  };

  const drawAccounts = async (force = false) => {
    // Si alguien está a medio asignar, el refresco automático espera
    const picking = box.querySelector('select:focus') || Array.from(box.querySelectorAll<HTMLSelectElement>('[data-store]')).some((s) => s.value);
    if (picking && !force) return;
    let accounts: UnassignedAccount[];
    try {
      accounts = await listUnassignedAccounts();
    } catch (e) {
      box.innerHTML = `<div class="section-title">${icon('user-plus')} Cuentas sin tienda</div>
        <div class="card empty small">No se pudo cargar: ${esc((e as Error).message)}</div>`;
      paintIcons();
      return;
    }
    const options = storeOptions();
    box.innerHTML = `<div class="section-title">${icon('user-plus')} Cuentas sin tienda</div>
      ${accounts.length ? `<ul class="list card">${accounts.map((a) => `<li class="assign" data-user="${a.user_id}">
          <div class="grow"><div><b>${esc(a.email)}</b></div>
            <div class="small muted">Se registró el ${fmtDate(a.created_at)}</div></div>
          ${a.confirmed ? '' : '<span class="pill wait">Falta confirmar su correo</span>'}
          <select data-store aria-label="Tienda para ${esc(a.email)}"><option value="">Elige la tienda…</option>${options}</select>
          <select data-access aria-label="Acceso de ${esc(a.email)}">${ROLE_OPTIONS}</select>
          <button class="btn primary" type="button" data-assign disabled>Asignar</button>
          <button class="icon-btn" type="button" data-reset aria-label="Restablecer contraseña" title="Restablecer contraseña">${icon('key-round')}</button>
        </li>`).join('')}</ul>
        <p class="small muted">El dueño administra su tienda y aprueba sus cajas. El gestor solo consulta.</p>`
      : '<div class="card empty small">Todas las cuentas registradas ya tienen tienda.</div>'}`;
    paintIcons();
    box.querySelectorAll<HTMLElement>('[data-user]').forEach((li) => {
      const a = accounts.find((x) => x.user_id === li.dataset.user)!;
      const store = li.querySelector<HTMLSelectElement>('[data-store]')!;
      const access = li.querySelector<HTMLSelectElement>('[data-access]')!;
      const btn = li.querySelector<HTMLButtonElement>('[data-assign]')!;
      store.onchange = () => { btn.disabled = !store.value; };
      li.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => void askResetPassword(a.user_id, a.email);
      btn.onclick = async () => {
        const name = store.selectedOptions[0].text;
        const role = access.value as 'owner' | 'gestor';
        const warn = a.confirmed ? '' : '\n\nOjo: esta persona todavía no confirma su correo.';
        if (!await askConfirm(`¿Dar acceso de ${access.selectedOptions[0].text} a ${a.email} en "${name}"?${warn}`)) return;
        btn.disabled = true;
        try {
          await addMember(store.value, a.email, role);
          toast('Tienda asignada');
          await drawAccounts(true);
        } catch (err) {
          btn.disabled = false;
          toast((err as Error).message);
        }
      };
    });
  };

  await draw();
  if (known.length) drawNew();
  await drawAccounts();
  ctx.every(60_000, () => { void draw(); void drawAccounts(); });
}
