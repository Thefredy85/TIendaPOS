import type { Ctx } from '../main';
import {
  getPolicy, licRegisterPayment, licSetContact, licSetEnforce, licSetMinVersion, licUnlockCode, licUpsert,
  listBusinesses, listLicenses, listPayments, type Business, type License,
} from '../api';
import { esc, fmtDate, fmtDateTime, fmtMoney, icon, openSheet, paintIcons, toast } from '../ui';
import { firstCutDate, licenseState, localIso } from '../licencia-fechas';

const PILL = { none: 'off', ok: 'ok', soon: 'wait', expired: 'wait', suspended: 'bad' } as const;
const fmtDay = (day: string) => fmtDate(`${day}T12:00:00`);

// Solo el superadmin (el dueño del sistema). Los gestores y dueños de negocio no la ven.
export async function renderLicencias(ctx: Ctx, el: HTMLElement) {
  document.getElementById('sub')!.textContent = 'Licencias mensuales de todos los negocios';
  if (ctx.role !== 'superadmin') {
    el.innerHTML = '<div class="card empty">Solo el administrador del sistema puede ver las licencias.</div>';
    return;
  }
  el.innerHTML = '<div class="card empty">Cargando…</div>';

  const draw = async () => {
    const [businesses, licenses, policy] = await Promise.all([listBusinesses(), listLicenses(), getPolicy()]);
    const byBiz = new Map(licenses.map((l) => [l.business_id, l]));
    const today = localIso(new Date());
    const rows = businesses.map((b) => {
      const l = byBiz.get(b.id) ?? null;
      return { b, l, st: licenseState(l?.paid_until ?? null, l?.enforce ?? false, today) };
    }).sort((a, z) => (a.st.daysLeft ?? 9999) - (z.st.daysLeft ?? 9999));
    const attention = rows.filter((r) => r.st.state === 'soon' || r.st.state === 'expired' || r.st.state === 'suspended').length;

    el.innerHTML = `
      ${attention ? `<div class="banner wait">${icon('shield-alert')}<div><b>${attention} negocio(s) por vencer o vencidos.</b></div></div>` : ''}
      <div class="card pad" style="margin-bottom:14px">
        <div class="section-title" style="margin-top:0">${icon('settings')} Ajustes generales</div>
        <div class="filters">
          <label style="flex:1;min-width:220px">Contacto que ven las tiendas (aviso y suspensión)
            <input id="f-contact" value="${esc(policy.contact_text ?? '')}" placeholder="Pagos y soporte: 55 1234 5678"></label>
          <button class="btn" id="save-contact">Guardar contacto</button>
        </div>
        <div class="filters">
          <label>Versión mínima de la app<input id="f-minver" value="${esc(policy.min_version ?? '')}" placeholder="0.2.14" style="width:120px"></label>
          <button class="btn" id="save-minver">Guardar versión</button>
          <span class="small muted">${policy.min_version ? `Desde ${fmtDateTime(policy.min_version_set_at)}; las cajas más viejas tienen 7 días para actualizar.` : 'Sin versión mínima.'}</span>
        </div>
      </div>
      <ul class="list card">${rows.map(({ b, l, st }) => `<li style="flex-wrap:wrap">
        <div class="grow">
          <div><b>${esc(b.name || b.license_key)}</b> <span class="pill ${PILL[st.state]}">${st.label}</span>
            ${l ? `<span class="pill ${l.enforce ? 'bad' : 'off'}">${l.enforce ? 'Bloqueo encendido' : 'Bloqueo apagado'}</span>` : ''}</div>
          <div class="small muted">${esc(b.license_key)}${l ? ` · corte día ${l.cut_day} · ${fmtMoney(l.monthly_amount)} al mes · vigente hasta ${fmtDay(l.paid_until)}` : ''}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${l ? `<button class="btn primary" data-act="pay" data-id="${b.id}">${icon('check')} Registrar pago</button>
                 <button class="btn" data-act="code" data-id="${b.id}">${icon('key-round')} Código</button>
                 <button class="btn" data-act="enforce" data-id="${b.id}">${l.enforce ? 'Apagar bloqueo' : 'Encender bloqueo'}</button>
                 <button class="btn" data-act="history" data-id="${b.id}">Pagos</button>` : ''}
          <button class="btn" data-act="edit" data-id="${b.id}">${l ? 'Editar' : 'Definir licencia'}</button>
        </div>
      </li>`).join('')}</ul>`;
    paintIcons();

    el.querySelector<HTMLButtonElement>('#save-contact')!.onclick = async () => {
      try { await licSetContact(el.querySelector<HTMLInputElement>('#f-contact')!.value.trim() || null); toast('Contacto guardado'); } catch (e) { toast((e as Error).message); }
    };
    el.querySelector<HTMLButtonElement>('#save-minver')!.onclick = async () => {
      const v = el.querySelector<HTMLInputElement>('#f-minver')!.value.trim();
      if (v && !confirm(`¿Fijar la versión mínima en ${v}?\n\nLas cajas con una versión más vieja verán un aviso por 7 días y después se suspenderán (solo en negocios con el bloqueo encendido).`)) return;
      try { await licSetMinVersion(v || null); toast(v ? 'Versión mínima guardada' : 'Sin versión mínima'); await draw(); } catch (e) { toast((e as Error).message); }
    };
    el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
      const row = rows.find((r) => r.b.id === btn.dataset.id)!;
      btn.onclick = () => actions[btn.dataset.act as keyof typeof actions](row.b, row.l, draw);
    });
  };

  await draw().catch((e) => { el.innerHTML = `<div class="card empty">No se pudo cargar: ${esc((e as Error).message)}</div>`; });
}

type Redraw = () => Promise<void>;
const actions = {
  edit(b: Business, l: License | null, redraw: Redraw) {
    const today = localIso(new Date());
    const cut = l?.cut_day ?? 5;
    const body = openSheet(l ? 'Editar licencia' : 'Definir licencia', `
      <p class="small muted">${esc(b.name || b.license_key)} · ${esc(b.license_key)}</p>
      <form class="filters" id="lic-form" style="flex-direction:column;align-items:stretch">
        <label>Día de corte (1 a 28)<input id="f-cut" type="number" min="1" max="28" value="${cut}" required></label>
        <label>Monto mensual<input id="f-amount" type="number" min="0" step="0.01" value="${l?.monthly_amount ?? ''}" required></label>
        <label>Vigente hasta<input id="f-until" type="date" value="${l?.paid_until ?? firstCutDate(today, cut)}" required></label>
        <span class="small muted">${l ? '' : 'Sugerencia: la primera fecha de corte a 30 días o más, para que nadie se bloquee por sorpresa.'}</span>
        <label>Notas<input id="f-notes" value="${esc(l?.notes ?? '')}"></label>
        <button class="btn primary" type="submit">${icon('check')} Guardar</button>
        <div class="err" role="alert"></div>
      </form>`);
    paintIcons();
    const form = body.querySelector<HTMLFormElement>('#lic-form')!;
    const cutInput = form.querySelector<HTMLInputElement>('#f-cut')!;
    if (!l) cutInput.oninput = () => { const d = Number(cutInput.value); if (d >= 1 && d <= 28) form.querySelector<HTMLInputElement>('#f-until')!.value = firstCutDate(today, d); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const cutDay = Number(cutInput.value), amount = Number(form.querySelector<HTMLInputElement>('#f-amount')!.value);
      const until = form.querySelector<HTMLInputElement>('#f-until')!.value;
      const err = form.querySelector('.err')!;
      if (!(cutDay >= 1 && cutDay <= 28)) { err.textContent = 'El día de corte debe ser del 1 al 28.'; return; }
      if (!(amount >= 0) || !until) { err.textContent = 'Revisa el monto y la fecha.'; return; }
      try {
        await licUpsert(b.id, cutDay, amount, until, form.querySelector<HTMLInputElement>('#f-notes')!.value.trim() || null);
        document.querySelector('.sheet-bg')?.remove();
        toast('Licencia guardada'); await redraw();
      } catch (ex) { err.textContent = (ex as Error).message; }
    };
  },

  pay(b: Business, l: License | null, redraw: Redraw) {
    if (!l) return;
    const body = openSheet('Registrar pago y liberar', `
      <p class="small muted">${esc(b.name || b.license_key)} · vigente hasta ${fmtDay(l.paid_until)}</p>
      <form class="filters" id="pay-form" style="flex-direction:column;align-items:stretch">
        <label>Monto recibido<input id="f-amount" type="number" min="0" step="0.01" value="${l.monthly_amount}" required></label>
        <label>Forma de pago<select id="f-method"><option>Transferencia</option><option>Efectivo</option><option>Depósito</option><option>Otro</option></select></label>
        <label>Notas<input id="f-notes" placeholder="Referencia, folio…"></label>
        <span class="small muted">La vigencia pasa a la siguiente fecha de corte (día ${l.cut_day}). Si la tienda tiene internet se libera en menos de un minuto.</span>
        <button class="btn primary" type="submit">${icon('check')} Registrar pago</button>
        <div class="err" role="alert"></div>
      </form>`);
    paintIcons();
    const form = body.querySelector<HTMLFormElement>('#pay-form')!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const amount = Number(form.querySelector<HTMLInputElement>('#f-amount')!.value);
      if (!(amount >= 0)) { form.querySelector('.err')!.textContent = 'Revisa el monto.'; return; }
      if (!confirm(`¿Registrar el pago de ${fmtMoney(amount)} de ${b.name || b.license_key}?`)) return;
      try {
        const r = await licRegisterPayment(b.id, amount, form.querySelector<HTMLSelectElement>('#f-method')!.value, form.querySelector<HTMLInputElement>('#f-notes')!.value.trim() || null);
        document.querySelector('.sheet-bg')?.remove();
        toast(`Pago registrado: vigente hasta ${fmtDay(r.paid_until)}`); await redraw();
      } catch (ex) { form.querySelector('.err')!.textContent = (ex as Error).message; }
    };
  },

  async enforce(b: Business, l: License | null, redraw: Redraw) {
    if (!l) return;
    const on = !l.enforce;
    const msg = on
      ? `¿Encender el bloqueo de ${b.name || b.license_key}?\n\nSi no paga a tiempo, la tienda dejará de poder vender desde el día de corte (con 3 días de gracia si no tiene internet). Sus ventas e inventario no se tocan.`
      : `¿Apagar el bloqueo de ${b.name || b.license_key}?\n\nLa tienda solo verá avisos; nunca se suspenderá.`;
    if (!confirm(msg)) return;
    try { await licSetEnforce(b.id, on); toast(on ? 'Bloqueo encendido' : 'Bloqueo apagado'); await redraw(); } catch (e) { toast((e as Error).message); }
  },

  async code(b: Business) {
    try {
      const r = await licUnlockCode(b.id);
      openSheet('Código por teléfono', `
        <p class="small muted">${esc(b.name || b.license_key)}</p>
        <div class="card pad" style="text-align:center;font:600 34px ui-monospace,Consolas,monospace;letter-spacing:4px">${esc(r.code.slice(0, 4))} ${esc(r.code.slice(4))}</div>
        <p class="small">Díctaselo a la tienda: en la pantalla de suspensión lo escriben en <b>Código por teléfono</b>. Vale hoy (${fmtDay(r.day)}) y le da <b>${r.days} días</b> de uso aunque no tenga internet.</p>
        <p class="small muted">Úsalo solo cuando ya te pagaron y la tienda no puede conectarse. Registra el pago también, para que la licencia quede al día.</p>`);
    } catch (e) { toast((e as Error).message); }
  },

  async history(b: Business) {
    const body = openSheet('Pagos', '<div class="empty">Cargando…</div>');
    try {
      const pays = await listPayments(b.id);
      body.innerHTML = pays.length ? `<ul class="list card">${pays.map((p) => `<li><div class="grow">
          <div><b>${fmtMoney(p.amount)}</b> · ${esc(p.method ?? '')}</div>
          <div class="small muted">${fmtDateTime(p.paid_at)} · cubre del ${fmtDay(p.covers_from)} al ${fmtDay(p.covers_until)}${p.notes ? ` · ${esc(p.notes)}` : ''}</div>
        </div></li>`).join('')}</ul>` : '<div class="empty">Sin pagos registrados.</div>';
    } catch (e) { body.innerHTML = `<div class="empty">No se pudo cargar: ${esc((e as Error).message)}</div>`; }
  },
};
