#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "256"]

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const IVA_RATE: f64 = 0.16;

fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

#[derive(Clone)]
struct Session {
    username: String,
    expires_at: i64,
}

struct DbConn(Mutex<Connection>);
struct SessionStore(Mutex<HashMap<String, Session>>);

// ---------- utilidades basicas ----------

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn random_text() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{:x}{:x}{:x}", nanos, c, std::process::id())
}

fn random_suffix() -> String {
    random_text().chars().rev().take(6).collect()
}

fn clean_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn num_of(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn not_false(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Bool(false)))
}

fn truthy_opt(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true)))
}

fn is_username(v: &str) -> bool {
    v.len() >= 4 && v.chars().all(|c| c.is_ascii_digit())
}

fn normalize_role(v: &str) -> String {
    let v = v.to_lowercase();
    if ["admin", "encargado", "cajero"].contains(&v.as_str()) {
        v
    } else {
        "cajero".to_string()
    }
}

fn display_or_username(u: &Value) -> String {
    let d = clean_text(u.get("displayName"));
    if !d.is_empty() {
        d
    } else {
        clean_text(u.get("username"))
    }
}

fn first_nonempty(payload: &Value, keys: &[&str]) -> String {
    for k in keys {
        let v = clean_text(payload.get(*k));
        if !v.is_empty() {
            return v;
        }
    }
    String::new()
}

fn slug(value: &str) -> String {
    let mut s = value.trim().to_lowercase();
    for (a, b) in [
        ("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"),
        ("ü", "u"), ("ñ", "n"),
    ] {
        s = s.replace(a, b);
    }
    let mut out = String::new();
    let mut last_us = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_us = false;
        } else if !last_us && !out.is_empty() {
            out.push('_');
            last_us = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        format!("item_{}", now_millis())
    } else {
        out
    }
}

fn hash_password(password: &str, salt: &str) -> String {
    let text = format!("{}|{}", salt, password);
    let mut a: u32 = 2166136261;
    let mut b: u32 = 16777619;
    let mut c: u32 = 3735928559;
    let mut d: u32 = 1103547991;
    for (i, ch) in text.encode_utf16().enumerate() {
        let ch = ch as u32;
        let i = i as u32;
        a ^= ch;
        a = a.wrapping_mul(16777619);
        b ^= ch.wrapping_add(i);
        b = b.wrapping_mul(2166136261);
        c = (c ^ ch).wrapping_mul(2654435761);
        d = (d.wrapping_add(ch).wrapping_add(a >> 7)).wrapping_mul(1597334677);
    }
    format!("{:08x}{:08x}{:08x}{:08x}", a, b, c, d)
}

fn iva_parts(gross: f64) -> (f64, f64) {
    let iva = (gross * IVA_RATE * 100.0).round() / 100.0;
    let without = ((gross - iva) * 100.0).round() / 100.0;
    (iva, without)
}

fn is_valid_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn color_or(v: Option<&Value>, fallback: &str) -> String {
    let s = clean_text(v);
    if is_valid_color(&s) {
        s
    } else {
        fallback.to_string()
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

// ---------- almacenamiento generico (SQLite) ----------

fn list_items(conn: &Connection, store: &str) -> Vec<Value> {
    let mut stmt = match conn.prepare("SELECT data FROM store_data WHERE store = ?1") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = match stmt.query_map(params![store], |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    rows.filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
        .collect()
}

fn get_item(conn: &Connection, store: &str, id: &str) -> Option<Value> {
    let raw: Result<String, _> = conn.query_row(
        "SELECT data FROM store_data WHERE store = ?1 AND id = ?2",
        params![store, id],
        |row| row.get(0),
    );
    raw.ok().and_then(|s| serde_json::from_str(&s).ok())
}

// Ejecuta varias escrituras como una sola: o quedan todas o ninguna.
// (SAVEPOINT se puede anidar, asi que funciona aunque ya haya una transaccion abierta.)
fn in_savepoint<F: FnOnce() -> Result<(), String>>(conn: &Connection, f: F) -> Result<(), String> {
    conn.execute_batch("SAVEPOINT escritura").map_err(|e| e.to_string())?;
    match f() {
        Ok(()) => conn.execute_batch("RELEASE escritura").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO escritura; RELEASE escritura");
            Err(e)
        }
    }
}

fn create_item(conn: &Connection, store: &str, id: &str, record: &Value) -> Result<(), String> {
    in_savepoint(conn, || {
        conn.execute(
            "INSERT INTO store_data (store, id, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(store, id) DO UPDATE SET data = excluded.data",
            params![store, id, record.to_string()],
        )
        .map_err(|e| e.to_string())?;
        outbox_enqueue(conn, store, id, None)
    })
}

fn patch_item(conn: &Connection, store: &str, id: &str, patch: &Value) -> Result<(), String> {
    let mut current = get_item(conn, store, id).unwrap_or_else(|| json!({}));
    if let (Value::Object(cur_map), Value::Object(patch_map)) = (&mut current, patch) {
        for (k, v) in patch_map {
            cur_map.insert(k.clone(), v.clone());
        }
    }
    create_item(conn, store, id, &current)
}

fn delete_item(conn: &Connection, store: &str, id: &str) -> Result<(), String> {
    // lo ultimo que se supo del registro viaja a la nube marcado como borrado
    let last = get_item(conn, store, id);
    in_savepoint(conn, || {
        conn.execute(
            "DELETE FROM store_data WHERE store = ?1 AND id = ?2",
            params![store, id],
        )
        .map_err(|e| e.to_string())?;
        outbox_enqueue(conn, store, id, last.as_ref())
    })
}

// ---------- cola de envio a la nube (outbox) ----------
// Cada escritura de los datos que se espejean anota (store, id) aqui, en la misma
// operacion. Al enviar se lee el estado ACTUAL del registro, asi que diez cambios
// sin internet se envian una sola vez. `version` sube con cada cambio: un registro
// solo sale de la cola si no cambio mientras se enviaba.

const SYNC_STORES: [&str; 6] = ["products", "sales", "moves", "cash_cuts", "users", "role_permissions"];

fn outbox_enqueue(conn: &Connection, store: &str, id: &str, tombstone: Option<&Value>) -> Result<(), String> {
    if !SYNC_STORES.contains(&store) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO outbox (store, id, version, tombstone) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(store, id) DO UPDATE SET version = version + 1, tombstone = excluded.tombstone",
        params![store, id, tombstone.map(|t| t.to_string())],
    )
    .map_err(|e| e.to_string())?;
    wake_cloud_worker(false);
    Ok(())
}

fn outbox_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap_or(0)
}

// Carga inicial: encola todo lo que hay. Solo LEE los datos; no cambia ninguno.
fn outbox_enqueue_all(conn: &Connection) -> Result<(), String> {
    let stores = SYNC_STORES.iter().map(|s| format!("'{}'", s)).collect::<Vec<_>>().join(",");
    conn.execute(
        &format!(
            "INSERT INTO outbox (store, id, version) SELECT store, id, 1 FROM store_data
             WHERE store IN ({}) ON CONFLICT(store, id) DO NOTHING",
            stores
        ),
        [],
    )
    .map_err(|e| e.to_string())?;
    // los permisos van aunque nunca se hayan guardado (asi el panel ve los de fabrica)
    conn.execute(
        "INSERT INTO outbox (store, id, version) VALUES ('role_permissions', 'current', 1) ON CONFLICT(store, id) DO NOTHING",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- configuracion (settings) ----------

fn normalize_settings(source: &Value) -> Value {
    let g = |k: &str| source.get(k);
    let text_or = |k: &str, fallback: &str| {
        let s = clean_text(g(k));
        if s.is_empty() { fallback.to_string() } else { s }
    };
    let font_or = |k: &str, fallback: &str| {
        let s = clean_text(g(k));
        let allowed = ["Arial", "Courier New", "Tahoma", "Verdana"];
        if allowed.contains(&s.as_str()) { s } else { fallback.to_string() }
    };
    json!({
        "storeTitle": text_or("storeTitle", "Tienda de Conveniencia"),
        "storeSubtitle": text_or("storeSubtitle", "Venta, entradas, salidas, mermas, conteos y reportes"),
        "authTitle": text_or("authTitle", "Acceso a tienda"),
        "authHelp": text_or("authHelp", "Ingresa con tu usuario de tienda."),
        "showAuthHelp": not_false(g("showAuthHelp")),
        "accessFontSize": clamp(if g("accessFontSize").is_some() { num_of(g("accessFontSize")) } else { 16.0 }, 14.0, 24.0),
        "accent": color_or(g("accent"), "#125f56"),
        "accent2": color_or(g("accent2"), "#cf7f2a"),
        "blue": color_or(g("blue"), "#276b9f"),
        "green": color_or(g("green"), "#317448"),
        "danger": color_or(g("danger"), "#bd4438"),
        "bg": color_or(g("bg"), "#f2f4f1"),
        "panel": color_or(g("panel"), "#fffefb"),
        "soft": color_or(g("soft"), "#f8f1e7"),
        "confirmPayLabel": text_or("confirmPayLabel", "Cobrar"),
        "ticketTitle": text_or("ticketTitle", "Ticket de venta"),
        "ticketFooter": text_or("ticketFooter", "Gracias por su compra"),
        "ticketTaxLabel": text_or("ticketTaxLabel", "IVA 16%"),
        "ticketShowStore": not_false(g("ticketShowStore")),
        "ticketShowDate": not_false(g("ticketShowDate")),
        "ticketShowCashier": not_false(g("ticketShowCashier")),
        "ticketShowPayment": not_false(g("ticketShowPayment")),
        "ticketShowSku": not_false(g("ticketShowSku")),
        "ticketShowIva": not_false(g("ticketShowIva")),
        "ticketShowLogo": truthy_opt(g("ticketShowLogo")),
        "ticketLogoData": ({ let s = clean_text(g("ticketLogoData")); if s.len() > 250000 { s[..250000].to_string() } else { s } }),
        "ticketFontFamily": font_or("ticketFontFamily", "Arial"),
        "ticketFontSize": clamp(if g("ticketFontSize").is_some() { num_of(g("ticketFontSize")) } else { 11.0 }, 9.0, 18.0),
        "ticketBold": truthy_opt(g("ticketBold")),
        "ticketAutoPrint": truthy_opt(g("ticketAutoPrint")),
        "ticketPreviewBeforePrint": not_false(g("ticketPreviewBeforePrint")),
        "ticketShowReceiptDialog": not_false(g("ticketShowReceiptDialog")),
        "cashCutTitle": text_or("cashCutTitle", "Corte de caja"),
        "cashCutFooter": text_or("cashCutFooter", "Corte generado por el sistema"),
        "cashCutFontFamily": font_or("cashCutFontFamily", "Arial"),
        "cashCutFontSize": clamp(if g("cashCutFontSize").is_some() { num_of(g("cashCutFontSize")) } else { 11.0 }, 9.0, 18.0),
        "cashCutBold": not_false(g("cashCutBold")),
        "cashCutShowLogo": truthy_opt(g("cashCutShowLogo")),
        "cashCutShowProducts": not_false(g("cashCutShowProducts")),
        "cashCutShowPayments": not_false(g("cashCutShowPayments")),
        "cashCutGroupBy": ({ let v = clean_text(g("cashCutGroupBy")); if ["normal","categoria","proveedor"].contains(&v.as_str()) { v } else { "normal".to_string() } }),
        "ticketPaperWidth": ({ let v = clean_text(g("ticketPaperWidth")); if v == "58" { v } else { "80".to_string() } }),
        "ticketCompactMode": truthy_opt(g("ticketCompactMode")),
        "ticketLineSpacing": ({ let v = clean_text(g("ticketLineSpacing")); if ["tight","normal","wide"].contains(&v.as_str()) { v } else { "normal".to_string() } }),
        "cashCutLineSpacing": ({ let v = clean_text(g("cashCutLineSpacing")); if ["tight","normal","wide"].contains(&v.as_str()) { v } else { "normal".to_string() } }),
        "cashCutShowName": not_false(g("cashCutShowName")),
        "cashCutShowBarcode": not_false(g("cashCutShowBarcode")),
        "cashCutShowUnit": truthy_opt(g("cashCutShowUnit")),
        "cashCutShowSupplier": truthy_opt(g("cashCutShowSupplier")),
        "enabledPaymentMethods": ({
            let epm = g("enabledPaymentMethods");
            let get_flag = |key: &str| -> bool {
                epm.and_then(|m| m.get(key)).and_then(|v| v.as_bool()).unwrap_or(true)
            };
            let mut efectivo = get_flag("Efectivo");
            let tarjeta = get_flag("Tarjeta");
            let transferencia = get_flag("Transferencia");
            if !efectivo && !tarjeta && !transferencia { efectivo = true; }
            json!({"Efectivo": efectivo, "Tarjeta": tarjeta, "Transferencia": transferencia})
        })
    })
}

fn default_settings() -> Value {
    normalize_settings(&json!({}))
}

fn read_settings(conn: &Connection) -> Value {
    let rows = list_items(conn, "settings");
    if let Some(row) = rows.iter().find(|r| clean_text(r.get("key")) == "app") {
        if let Some(val_str) = row.get("value").and_then(|v| v.as_str()) {
            if let Ok(parsed) = serde_json::from_str::<Value>(val_str) {
                return normalize_settings(&parsed);
            }
        }
    }
    default_settings()
}

// ---------- usuarios y sesiones ----------

fn public_user(u: &Value) -> Value {
    json!({
        "username": clean_text(u.get("username")),
        "displayName": clean_text(u.get("displayName")),
        "role": clean_text(u.get("role")),
        "active": not_false(u.get("active")),
        "createdAt": clean_text(u.get("createdAt")),
        "lastLogin": clean_text(u.get("lastLogin")),
    })
}

fn create_user_record(conn: &Connection, input: &Value, role_fallback: &str) -> Result<Value, String> {
    let username = {
        let a = clean_text(input.get("loginCode"));
        if !a.is_empty() { a } else { clean_text(input.get("username")) }
    };
    let password = clean_text(input.get("password"));
    if !is_username(&username) {
        return Err("El usuario debe tener al menos 4 digitos numericos".into());
    }
    if password.len() < 4 {
        return Err("La contrasena debe tener al menos 4 caracteres".into());
    }
    let users = list_items(conn, "users");
    if users.iter().any(|u| clean_text(u.get("username")) == username) {
        return Err("Ese usuario ya existe".into());
    }
    let salt = random_text();
    let display_name = { let d = clean_text(input.get("displayName")); if d.is_empty() { username.clone() } else { d } };
    let role = { let r = clean_text(input.get("role")); if r.is_empty() { role_fallback.to_string() } else { r } };
    let active = input.get("active").map(truthy).unwrap_or(true);
    let record = json!({
        "username": username,
        "displayName": display_name,
        "passwordHash": hash_password(&password, &salt),
        "salt": salt,
        "role": normalize_role(&role),
        "pin": "",
        "active": active,
        "createdAt": now_iso(),
        "lastLogin": ""
    });
    create_item(conn, "users", &username, &record)?;
    Ok(public_user(&record))
}

fn current_user(
    required: bool,
    conn: &Connection,
    sessions: &mut HashMap<String, Session>,
    token: &str,
) -> Result<Option<Value>, String> {
    let now = now_millis();
    let sess = sessions.get(token).cloned();
    let sess = match sess {
        Some(s) if s.expires_at >= now => s,
        _ => {
            if required { return Err("Sesion expirada".into()); }
            return Ok(None);
        }
    };
    let users = list_items(conn, "users");
    let user = users.into_iter().find(|u| {
        clean_text(u.get("username")) == sess.username && not_false(u.get("active"))
    });
    let user = match user {
        Some(u) => u,
        None => {
            if required { return Err("Usuario inactivo".into()); }
            return Ok(None);
        }
    };
    sessions.insert(
        token.to_string(),
        Session { username: sess.username, expires_at: now + 1000 * 60 * 60 * 14 },
    );
    Ok(Some(user))
}

fn assert_role(user: &Value, roles: &[&str]) -> Result<(), String> {
    let role = clean_text(user.get("role"));
    if roles.contains(&role.as_str()) { Ok(()) } else { Err("No autorizado".into()) }
}

// ---------- permisos configurables por rol ----------
// admin siempre tiene todo. La gestion de usuarios y el cobro (checkout) quedan
// fijos por seguridad y no son configurables desde aqui.
const PERM_KEYS: [&str; 6] = ["settings", "catalogs", "products", "movements", "counts", "cashcut"];
const PERM_ROLES: [&str; 2] = ["encargado", "cajero"];

fn default_role_permission(role: &str, key: &str) -> bool {
    match (role, key) {
        ("cajero", "cashcut") => true,
        ("cajero", _) => false,
        ("encargado", _) => true,
        _ => false,
    }
}

fn read_role_permissions(conn: &Connection) -> Value {
    let stored = get_item(conn, "role_permissions", "current").unwrap_or_else(|| json!({}));
    let mut out = serde_json::Map::new();
    for role in PERM_ROLES {
        let mut role_map = serde_json::Map::new();
        for key in PERM_KEYS {
            let stored_val = stored.get(role).and_then(|r| r.get(key)).and_then(|v| v.as_bool());
            let val = stored_val.unwrap_or_else(|| default_role_permission(role, key));
            role_map.insert(key.to_string(), json!(val));
        }
        out.insert(role.to_string(), Value::Object(role_map));
    }
    Value::Object(out)
}

fn has_permission(perms: &Value, role: &str, key: &str) -> bool {
    perms.get(role).and_then(|r| r.get(key)).and_then(|v| v.as_bool())
        .unwrap_or_else(|| default_role_permission(role, key))
}

fn assert_permission(conn: &Connection, user: &Value, key: &str) -> Result<(), String> {
    let role = clean_text(user.get("role"));
    if role == "admin" { return Ok(()); }
    let perms = read_role_permissions(conn);
    if has_permission(&perms, &role, key) {
        Ok(())
    } else {
        Err("No autorizado. Pide a un administrador que active este permiso para tu rol en Configuracion > Permisos.".into())
    }
}

fn op_save_role_permissions(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin"])?;
    let input = payload.get("permissions").cloned().unwrap_or_else(|| json!({}));
    let mut out = serde_json::Map::new();
    for role in PERM_ROLES {
        let mut role_map = serde_json::Map::new();
        for key in PERM_KEYS {
            let val = input.get(role).and_then(|r| r.get(key)).map(truthy)
                .unwrap_or_else(|| default_role_permission(role, key));
            role_map.insert(key.to_string(), json!(val));
        }
        out.insert(role.to_string(), Value::Object(role_map));
    }
    let record = Value::Object(out);
    create_item(conn, "role_permissions", "current", &record)?;
    Ok(json!({"ok": true, "permissions": record}))
}

fn verify_supervisor(conn: &Connection, input: &Value) -> Result<Value, String> {
    let code = first_nonempty(input, &["code", "loginCode", "pin"]);
    let username = { let u = clean_text(input.get("username")); if !u.is_empty() { u } else { code.clone() } };
    let password = { let p = clean_text(input.get("password")); if !p.is_empty() { p } else { code.clone() } };
    let users = list_items(conn, "users");
    let mut user = users.iter().find(|u| clean_text(u.get("username")) == username && not_false(u.get("active"))).cloned();
    let ok = user.as_ref().map(|u| {
        hash_password(&password, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
    }).unwrap_or(false);
    if !ok {
        let single_key = if !code.is_empty() { code.clone() }
            else if !username.is_empty() && username == password { username.clone() }
            else { String::new() };
        let matches: Vec<Value> = if !single_key.is_empty() {
            users.iter().filter(|u| {
                not_false(u.get("active")) && hash_password(&single_key, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
            }).cloned().collect()
        } else { vec![] };
        user = if matches.len() == 1 { Some(matches[0].clone()) } else { None };
    }
    let user = user.ok_or_else(|| "Permiso superior incorrecto".to_string())?;
    let role = clean_text(user.get("role"));
    if !["admin", "encargado"].contains(&role.as_str()) {
        return Err("Ese usuario no tiene permiso superior".into());
    }
    Ok(user)
}

// ---------- actualizacion propia (reemplaza el updater basico de Tauri) ----------

const APP_UPDATE_MANIFEST_URL: &str = "https://github.com/Thefredy85/TiendaPOS/releases/latest/download/latest.json";

fn parse_version(v: &str) -> (u32, u32, u32) {
    let mut parts = v.trim().split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn is_newer(candidate: &str, current: &str) -> bool {
    parse_version(candidate) > parse_version(current)
}

#[tauri::command]
fn check_for_update(app: tauri::AppHandle) -> Value {
    let current_version = app.package_info().version.to_string();
    let resp = match http_client().get(APP_UPDATE_MANIFEST_URL).send() {
        Ok(r) => r,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let manifest: Value = match resp.json() {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let latest_version = clean_text(manifest.get("version"));
    let notes = clean_text(manifest.get("notes"));
    let url = manifest
        .get("platforms")
        .and_then(|p| p.get("windows-x86_64"))
        .and_then(|w| w.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    let available = !latest_version.is_empty() && is_newer(&latest_version, &current_version);
    json!({
        "ok": true,
        "available": available,
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "url": url,
        "notes": notes
    })
}

#[tauri::command]
fn exit_app() {
    std::process::exit(0);
}

#[tauri::command]
fn download_and_launch_update(url: String) -> Result<(), String> {
    if url.is_empty() {
        return Err("No hay una URL de actualizacion valida".into());
    }
    let download_client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .connect_timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response = download_client
        .get(&url)
        .send()
        .map_err(|e| format!("No se pudo descargar la actualizacion: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "El servidor de actualizaciones respondio con un error ({}). No se descargo ni se instalo nada; intenta de nuevo mas tarde o avisa que revisen la publicacion de la nueva version.",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if content_type.contains("text/html") || content_type.contains("application/json") {
        return Err("La respuesta del servidor no es un instalador valido (parece una pagina de error). No se instalo nada.".into());
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("No se pudo leer la actualizacion descargada: {}", e))?;
    const MIN_INSTALLER_BYTES: usize = 1_000_000; // un instalador real siempre pesa varios MB
    if bytes.len() < MIN_INSTALLER_BYTES {
        return Err(format!(
            "El archivo descargado es demasiado pequeno para ser el instalador real ({} bytes). No se instalo nada por seguridad.",
            bytes.len()
        ));
    }
    // Un .exe de Windows valido siempre inicia con la firma "MZ". Si el archivo
    // descargado no la tiene, es basura (una pagina, una redireccion mal resuelta,
    // una descarga truncada, etc.) y jamas debe ejecutarse.
    if bytes.len() < 2 || &bytes[0..2] != b"MZ" {
        return Err(
            "El archivo descargado no tiene el formato de un instalador de Windows valido. No se instalo nada por seguridad; intenta de nuevo mas tarde o avisa que revisen la publicacion de la nueva version.".into(),
        );
    }
    // El nombre local NUNCA se toma de la URL: un espacio, acento o caracter mal
    // codificado en el nombre del archivo remoto (p. ej. "%20") puede guardar el
    // instalador con un nombre corrupto que Windows no reconoce como ejecutable
    // valido. Usamos siempre un nombre fijo y seguro.
    let mut path = std::env::temp_dir();
    path.push("TiendaPOS_Actualizacion.exe");
    std::fs::write(&path, &bytes).map_err(|e| format!("No se pudo guardar el instalador: {}", e))?;
    std::process::Command::new(&path)
        .spawn()
        .map_err(|e| format!("No se pudo abrir el instalador: {}", e))?;
    std::process::exit(0);
}

// ---------- licencia / suscripcion ----------

// Reemplaza esta URL por el link de "publicar en la web" (formato CSV) de tu
// Google Sheet de licencias, con columnas: license_key, estado (activo/suspendido)
const LICENSE_SHEET_URL: &str = "REEMPLAZAR_CON_TU_URL_DE_HOJA_PUBLICADA_CSV";
const LICENSE_GRACE_DAYS: i64 = 7;

fn get_or_create_license_key(conn: &Connection) -> String {
    if let Some(row) = get_item(conn, "license", "local") {
        let existing = clean_text(row.get("licenseKey"));
        if !existing.is_empty() {
            return existing;
        }
    }
    let raw = random_text();
    let key = format!("TP-{}", raw.chars().take(8).collect::<String>().to_uppercase());
    create_item(
        conn,
        "license",
        "local",
        &json!({"licenseKey": key, "lastStatus": "desconocido", "lastOkIso": ""}),
    )
    .ok();
    key
}

fn fetch_license_status(license_key: &str) -> Result<Option<String>, String> {
    if LICENSE_SHEET_URL.starts_with("REEMPLAZAR_") {
        return Err("La hoja de licencias todavia no esta configurada".into());
    }
    let text = http_client()
        .get(LICENSE_SHEET_URL)
        .send()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;
    let mut lines = text.lines();
    let header = lines.next().ok_or_else(|| "Hoja de licencias vacia".to_string())?;
    let headers: Vec<String> = header
        .split(',')
        .map(|h| h.trim().trim_matches('"').to_lowercase())
        .collect();
    let key_idx = headers.iter().position(|h| h == "license_key" || h == "llave_licencia");
    let status_idx = headers.iter().position(|h| h == "estado");
    let (key_idx, status_idx) = match (key_idx, status_idx) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("La hoja de licencias no tiene las columnas esperadas".into()),
    };
    for line in lines {
        let cols: Vec<String> = line.split(',').map(|c| c.trim().trim_matches('"').to_string()).collect();
        if cols.len() <= key_idx.max(status_idx) {
            continue;
        }
        if cols[key_idx] == license_key {
            return Ok(Some(cols[status_idx].to_lowercase()));
        }
    }
    Ok(None)
}

fn days_between_now_and(iso: &str) -> i64 {
    if iso.is_empty() {
        return i64::MAX;
    }
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(then) => {
            let now = Utc::now();
            (now.signed_duration_since(then.with_timezone(&Utc))).num_days()
        }
        Err(_) => i64::MAX,
    }
}

#[tauri::command]
fn check_license(db: tauri::State<DbConn>) -> Value {
    // Igual que en sync_to_cloud: primero se lee lo necesario y se suelta el
    // candado, y solo despues se hace la llamada de red (que puede tardar si
    // el internet esta lento), para que el resto de la app no se congele
    // mientras se revisa la licencia.
    let key = {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(_) => return json!({"ok": false, "error": "Error de base de datos local"}),
        };
        get_or_create_license_key(&conn)
    };
    match fetch_license_status(&key) {
        Ok(Some(status)) => {
            let now_iso_val = now_iso();
            if let Ok(conn) = db.0.lock() {
                patch_item(&conn, "license", "local", &json!({"lastStatus": status, "lastOkIso": now_iso_val})).ok();
            }
            json!({"ok": true, "licenseKey": key, "status": status, "online": true})
        }
        Ok(None) => {
            json!({"ok": true, "licenseKey": key, "status": "no_registrada", "online": true})
        }
        Err(_) => {
            let conn = match db.0.lock() {
                Ok(c) => c,
                Err(_) => return json!({"ok": false, "error": "Error de base de datos local"}),
            };
            let row = get_item(&conn, "license", "local").unwrap_or_else(|| json!({}));
            let last_status = clean_text(row.get("lastStatus"));
            let last_ok = clean_text(row.get("lastOkIso"));
            json!({"ok": true, "licenseKey": key, "status": if last_status.is_empty() {"desconocido".to_string()} else {last_status}, "online": false, "lastOkIso": last_ok})
        }
    }
}

fn ensure_license_allows_sale(conn: &Connection) -> Result<(), String> {
    let row = get_item(conn, "license", "local").unwrap_or_else(|| json!({}));
    let last_status = clean_text(row.get("lastStatus"));
    let last_ok = clean_text(row.get("lastOkIso"));
    if last_status == "suspendido" {
        return Err(
            "Cuenta suspendida por falta de pago. Contacta a tu proveedor para reactivar el punto de venta.".into(),
        );
    }
    // Si todavia nunca se ha logrado confirmar la licencia (por ejemplo,
    // recien instalada sin internet la primera vez), no bloqueamos --
    // el limite de 7 dias solo aplica despues de haber confirmado al menos
    // una vez y luego perder la conexion.
    if !last_ok.is_empty() && days_between_now_and(&last_ok) > LICENSE_GRACE_DAYS {
        return Err(
            "No se ha podido confirmar tu licencia en mas de 7 dias. Conecta la computadora a internet para reactivar las ventas.".into(),
        );
    }
    Ok(())
}

// ---------- operaciones ----------

fn op_bootstrap(conn: &Connection) -> Result<Value, String> {
    let users = list_items(conn, "users");
    let settings = read_settings(conn);
    Ok(json!({"ok": true, "needsSetup": users.is_empty(), "userCount": users.len(), "settings": settings}))
}

fn op_setup_admin(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let users = list_items(conn, "users");
    if !users.is_empty() {
        return Ok(json!({"ok": false, "error": "La tienda ya tiene usuarios configurados"}));
    }
    let mut input = payload.clone();
    if let Value::Object(m) = &mut input {
        m.insert("role".into(), json!("admin"));
        m.insert("active".into(), json!(true));
    }
    let user = create_user_record(conn, &input, "admin")?;
    Ok(json!({"ok": true, "user": user}))
}

fn op_login(conn: &Connection, sessions: &mut HashMap<String, Session>, payload: &Value) -> Result<Value, String> {
    let code = first_nonempty(payload, &["code", "loginCode", "pin"]);
    let username = { let u = clean_text(payload.get("username")); if !u.is_empty() { u } else { code.clone() } };
    let password = { let p = clean_text(payload.get("password")); if !p.is_empty() { p } else { code.clone() } };
    let users = list_items(conn, "users");

    let mut candidates: Vec<(String, String)> = vec![(username.clone(), password.clone()), (password.clone(), username.clone())];
    if !code.is_empty() { candidates.push((code.clone(), code.clone())); }

    let mut user: Option<Value> = None;
    let mut matched_username = String::new();
    for (cu, cp) in &candidates {
        if let Some(found) = users.iter().find(|u| clean_text(u.get("username")) == *cu && not_false(u.get("active"))) {
            if hash_password(cp, &clean_text(found.get("salt"))) == clean_text(found.get("passwordHash")) {
                user = Some(found.clone());
                matched_username = cu.clone();
                break;
            }
        }
    }
    if user.is_none() {
        let single_key = if !code.is_empty() { code.clone() }
            else if !username.is_empty() && username == password { username.clone() }
            else { String::new() };
        if !single_key.is_empty() {
            let matches: Vec<&Value> = users.iter().filter(|u| {
                not_false(u.get("active")) && hash_password(&single_key, &clean_text(u.get("salt"))) == clean_text(u.get("passwordHash"))
            }).collect();
            if matches.len() == 1 {
                user = Some(matches[0].clone());
                matched_username = clean_text(matches[0].get("username"));
            } else if matches.len() > 1 {
                return Ok(json!({"ok": false, "error": "Clave duplicada. Cambia una de las claves desde Usuarios."}));
            }
        }
    }
    let mut user = match user {
        Some(u) => u,
        None => return Ok(json!({"ok": false, "error": "Usuario o contrasena incorrectos"})),
    };
    let token = random_text();
    sessions.insert(token.clone(), Session { username: matched_username.clone(), expires_at: now_millis() + 1000 * 60 * 60 * 14 });
    patch_item(conn, "users", &matched_username, &json!({"lastLogin": now_iso()}))?;
    user["lastLogin"] = json!(now_iso());
    Ok(json!({"ok": true, "sessionToken": token, "user": public_user(&user)}))
}

fn op_logout(sessions: &mut HashMap<String, Session>, token: &str) -> Value {
    sessions.remove(token);
    json!({"ok": true})
}

fn op_data(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    let role = clean_text(user.get("role"));
    let admin = role == "admin";
    let manager = admin || role == "encargado";
    let perms = read_role_permissions(conn);
    let sees_ops = manager || has_permission(&perms, &role, "movements") || has_permission(&perms, &role, "counts");
    let products = list_items(conn, "products");
    let moves = if sees_ops { list_items(conn, "moves") } else { vec![] };
    let counts = if sees_ops { list_items(conn, "counts") } else { vec![] };
    let sales = list_items(conn, "sales");
    let settings = read_settings(conn);
    let categories = list_items(conn, "categories");
    let units = list_items(conn, "units");
    let suppliers = list_items(conn, "suppliers");
    let presentations = list_items(conn, "presentations");
    let users: Vec<Value> = if admin { list_items(conn, "users").iter().map(public_user).collect() } else { vec![] };
    let cash_state = get_item(conn, "cash_state", "current").unwrap_or_else(|| json!({"periodStart": "", "openingAmount": 0.0, "isOpen": false}));
    let cash_cuts = list_items(conn, "cash_cuts");
    Ok(json!({
        "ok": true, "user": public_user(&user), "products": products, "moves": moves,
        "counts": counts, "sales": sales, "users": users, "settings": settings,
        "categories": categories, "units": units, "suppliers": suppliers, "presentations": presentations,
        "cashState": cash_state, "cashCuts": cash_cuts, "rolePermissions": perms
    }))
}

fn op_open_cash_register(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "cashcut")?;
    let existing_state = get_item(conn, "cash_state", "current").unwrap_or_else(|| json!({"isOpen": false}));
    if existing_state.get("isOpen").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("La caja ya esta abierta. Genera un Corte Z antes de abrir un turno nuevo.".into());
    }
    let opening = num_of(payload.get("openingAmount"));
    let now = now_iso();
    let state_rec = json!({"periodStart": now, "openingAmount": opening, "isOpen": true});
    create_item(conn, "cash_state", "current", &state_rec)?;
    let id = format!("APER-{}-{}", now_millis(), random_suffix());
    let hist = json!({
        "id": id, "type": "apertura", "timestamp": now, "periodStart": now, "periodEnd": now,
        "openingAmount": opening, "total": 0.0, "salesCount": 0, "payments": json!({}),
        "user": display_or_username(&user), "notes": clean_text(payload.get("notes"))
    });
    create_item(conn, "cash_cuts", &id, &hist)?;
    Ok(json!({"ok": true, "cashState": state_rec, "cut": hist}))
}

fn op_cash_cut(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "cashcut")?;
    let cut_type = clean_text(payload.get("type"));
    if !["x", "z"].contains(&cut_type.as_str()) {
        return Err("Tipo de corte no reconocido".into());
    }
    if cut_type == "z" {
        let pending_held = num_of(payload.get("pendingHeldTickets")) as i64;
        let pending_cart = num_of(payload.get("pendingCartItems")) as i64;
        if pending_held > 0 || pending_cart > 0 {
            return Err(format!(
                "No se puede cerrar el turno (Corte Z): hay {} ticket(s) en espera y/o un ticket actual con {} producto(s) sin cobrar. Cobra o cancela esos tickets primero.",
                pending_held, pending_cart
            ));
        }
    }
    let cash_state = get_item(conn, "cash_state", "current").unwrap_or_else(|| json!({"isOpen": false}));
    if !cash_state.get("isOpen").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("No hay una caja abierta. Abre la caja antes de generar un corte.".into());
    }
    let period_start = clean_text(cash_state.get("periodStart"));
    let opening = num_of(cash_state.get("openingAmount"));
    let now = now_iso();
    let sales = list_items(conn, "sales");
    let period_sales: Vec<&Value> = sales
        .iter()
        .filter(|s| (period_start.is_empty() || clean_text(s.get("timestamp")) >= period_start) && !truthy_opt(s.get("cancelled")))
        .collect();
    let total: f64 = period_sales.iter().map(|s| num_of(s.get("total"))).sum();
    let mut by_payment: HashMap<String, f64> = HashMap::new();
    for s in &period_sales {
        if let Some(breakdown) = s.get("paymentBreakdown").and_then(|v| v.as_object()) {
            if !breakdown.is_empty() {
                for (k, v) in breakdown {
                    *by_payment.entry(k.clone()).or_insert(0.0) += v.as_f64().unwrap_or(0.0);
                }
                continue;
            }
        }
        let pay = { let p = clean_text(s.get("paymentMethod")); if p.is_empty() { "Efectivo".to_string() } else { p } };
        *by_payment.entry(pay).or_insert(0.0) += num_of(s.get("total"));
    }
    let id = format!("{}-{}-{}", if cut_type == "z" { "CORTEZ" } else { "CORTEX" }, now_millis(), random_suffix());
    let hist = json!({
        "id": id, "type": cut_type, "timestamp": now, "periodStart": period_start, "periodEnd": now,
        "openingAmount": opening, "total": total, "salesCount": period_sales.len(),
        "payments": json!(by_payment),
        "user": display_or_username(&user), "notes": clean_text(payload.get("notes"))
    });
    create_item(conn, "cash_cuts", &id, &hist)?;
    if cut_type == "z" {
        let new_state = json!({"periodStart": "", "openingAmount": 0.0, "isOpen": false});
        create_item(conn, "cash_state", "current", &new_state)?;
    }
    Ok(json!({"ok": true, "cut": hist}))
}


fn op_save_user(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin"])?;
    let editing_username = clean_text(payload.get("editingUsername"));
    let username = clean_text(payload.get("username"));
    if !is_username(&username) {
        return Err("El usuario debe tener al menos 4 digitos numericos".into());
    }
    let users = list_items(conn, "users");
    let existing = if !editing_username.is_empty() {
        users.iter().find(|u| clean_text(u.get("username")) == editing_username).cloned()
    } else { None };
    if existing.is_none() {
        if !clean_text(payload.get("password")).is_empty() {
            let new_user = create_user_record(conn, payload, "cajero")?;
            return Ok(json!({"ok": true, "user": new_user}));
        }
        return Err("Usuario no encontrado".into());
    }
    let existing = existing.unwrap();
    if editing_username != username && users.iter().any(|u| clean_text(u.get("username")) == username) {
        return Err("Ese usuario ya existe".into());
    }
    let mut record = existing.clone();
    record["username"] = json!(username);
    let display_name_value = { let d = clean_text(payload.get("displayName")); if d.is_empty() { username.clone() } else { d } };
    record["displayName"] = json!(display_name_value);
    record["role"] = json!(normalize_role(&clean_text(payload.get("role"))));
    record["active"] = json!(payload.get("active").map(truthy).unwrap_or(true));
    let new_password = { let a = clean_text(payload.get("newPassword")); if !a.is_empty() { a } else { clean_text(payload.get("password")) } };
    if !new_password.is_empty() {
        if new_password.len() < 4 {
            return Err("La contrasena debe tener al menos 4 caracteres".into());
        }
        let salt = random_text();
        record["salt"] = json!(salt.clone());
        record["passwordHash"] = json!(hash_password(&new_password, &salt));
    }
    if editing_username != username {
        create_item(conn, "users", &username, &record)?;
        delete_item(conn, "users", &editing_username)?;
    } else {
        create_item(conn, "users", &username, &record)?;
    }
    sessions.retain(|_, s| s.username != editing_username);
    Ok(json!({"ok": true, "user": public_user(&record)}))
}

fn op_delete_user(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin"])?;
    let username = clean_text(payload.get("username"));
    if username.is_empty() { return Err("Falta usuario".into()); }
    if username == clean_text(user.get("username")) {
        return Err("No puedes eliminar el usuario activo".into());
    }
    delete_item(conn, "users", &username)?;
    sessions.retain(|_, s| s.username != username);
    Ok(json!({"ok": true}))
}

fn op_save_settings(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "settings")?;
    let settings = normalize_settings(payload);
    let record = json!({"key": "app", "value": settings.to_string()});
    create_item(conn, "settings", "app", &record)?;
    Ok(json!({"ok": true, "settings": settings}))
}

fn catalog_store(kind: &str) -> Option<&'static str> {
    match kind {
        "category" => Some("categories"),
        "unit" => Some("units"),
        "supplier" => Some("suppliers"),
        "presentation" => Some("presentations"),
        _ => None,
    }
}

fn op_save_catalog(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "catalogs")?;
    let kind = clean_text(payload.get("kind"));
    let store = catalog_store(&kind).ok_or_else(|| "Catalogo no reconocido".to_string())?;
    let name = clean_text(payload.get("name"));
    if name.is_empty() { return Err("Falta nombre".into()); }
    let id = { let i = clean_text(payload.get("id")); if !i.is_empty() { i } else { slug(&name) } };
    let rows = list_items(conn, store);
    let mut record = json!({
        "id": id,
        "name": name,
        "active": payload.get("active").map(truthy).unwrap_or(true),
        "sortOrder": payload.get("sortOrder").and_then(|v| v.as_f64()).unwrap_or((rows.len() + 1) as f64)
    });
    match kind.as_str() {
        "category" => record["description"] = json!(clean_text(payload.get("description"))),
        "unit" => {
            let abbreviation_value = { let a = clean_text(payload.get("abbreviation")); if a.is_empty() { name.clone() } else { a } };
            record["abbreviation"] = json!(abbreviation_value);
        }
        "supplier" => {
            record["phone"] = json!(clean_text(payload.get("phone")));
            record["notes"] = json!(clean_text(payload.get("notes")));
        }
        "presentation" => record["description"] = json!(clean_text(payload.get("description"))),
        _ => {}
    }
    create_item(conn, store, &id, &record)?;
    Ok(json!({"ok": true, "item": record}))
}

fn op_delete_catalog(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "catalogs")?;
    let kind = clean_text(payload.get("kind"));
    let id = clean_text(payload.get("id"));
    let store = catalog_store(&kind);
    let store = match store {
        Some(s) if !id.is_empty() => s,
        _ => return Err("Catalogo no reconocido".into()),
    };
    delete_item(conn, store, &id)?;
    Ok(json!({"ok": true}))
}

fn op_save_product(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "products")?;
    let rec = payload.get("record").cloned().unwrap_or_else(|| payload.clone());
    let products = list_items(conn, "products");
    // La pantalla indica si es un alta ("new") o una edicion ("edit"). En un alta se
    // ignora cualquier editingSku que haya quedado: asi un producto nuevo NUNCA pisa a otro.
    let mode = clean_text(payload.get("mode"));
    let editing_sku = if mode == "new" { String::new() } else {
        let a = clean_text(payload.get("editingSku")); if !a.is_empty() { a } else { clean_text(rec.get("editingSku")) }
    };
    let existing = if !editing_sku.is_empty() {
        products.iter().find(|p| clean_text(p.get("sku")) == editing_sku).cloned()
    } else { None };
    // El identificador interno (campo "sku") ya no lo escribe nadie: es automatico,
    // nunca se muestra y nunca se reutiliza. Un producto existente conserva el suyo
    // para no romper ventas, movimientos ni conteos historicos.
    if !editing_sku.is_empty() && existing.is_none() {
        return Err("Producto no encontrado. Recarga la pantalla e intenta de nuevo.".into());
    }
    let sku = if let Some(e) = &existing {
        clean_text(e.get("sku"))
    } else {
        let mut candidate;
        loop {
            candidate = format!("P{}{}", now_millis(), random_suffix());
            if !products.iter().any(|p| clean_text(p.get("sku")) == candidate) { break; }
        }
        candidate
    };
    let exists = products.iter().any(|p| clean_text(p.get("sku")) == sku);
    let barcode = clean_text(rec.get("barcode"));
    let barcode_required = match &existing { None => true, Some(e) => !clean_text(e.get("barcode")).is_empty() };
    if barcode.is_empty() && barcode_required {
        return Err("El codigo de barras es obligatorio. Escanealo o escribelo para guardar el producto.".into());
    }
    if !barcode.is_empty() {
        if let Some(dup) = products.iter().find(|p| clean_text(p.get("sku")) != sku && clean_text(p.get("barcode")) == barcode) {
            return Err(format!("Ese código de barras ya está asignado a \"{}\" ({}). Cada producto necesita un código único para que el escaneo no descuente el producto equivocado.", clean_text(dup.get("name")), clean_text(dup.get("sku"))));
        }
    }
    // Cambiar a la vez el nombre y el codigo de barras de un producto existente casi
    // siempre es un "producto nuevo" capturado por error sobre otro: se pide confirmar.
    if let Some(e) = &existing {
        let old_name = clean_text(e.get("name"));
        let old_barcode = clean_text(e.get("barcode"));
        let new_name = clean_text(rec.get("name"));
        let renamed = !old_name.is_empty() && old_name.to_lowercase() != new_name.to_lowercase();
        let recoded = !old_barcode.is_empty() && old_barcode != barcode;
        if renamed && recoded && !truthy_opt(payload.get("confirmRename")) {
            return Err(format!(
                "CONFIRMAR: Vas a convertir \"{}\" (código {}) en \"{}\" (código {}). Conservará su existencia y su historial de ventas. Si querías dar de alta un producto nuevo, elige Cancelar y usa Cancelar edición.",
                old_name, old_barcode, new_name, barcode
            ));
        }
    }
    let cost = num_of(rec.get("cost"));
    let price = num_of(rec.get("price"));
    let (cost_iva, cost_wo) = iva_parts(cost);
    let (price_iva, price_wo) = iva_parts(price);
    let stock = if let Some(e) = &existing { num_of(e.get("stock")) } else { num_of(rec.get("stock")) };
    let record = json!({
        "sku": sku,
        "barcode": barcode,
        "name": clean_text(rec.get("name")),
        "category": clean_text(rec.get("category")),
        "presentation": clean_text(rec.get("presentation")),
        "supplier": clean_text(rec.get("supplier")),
        "unit": ({ let u = clean_text(rec.get("unit")); if u.is_empty() { "pieza".to_string() } else { u } }),
        "cost": cost, "price": price,
        "costIva": cost_iva, "priceIva": price_iva,
        "costWithoutIva": cost_wo, "priceWithoutIva": price_wo,
        "stock": stock, "minStock": num_of(rec.get("minStock")),
        "description": clean_text(rec.get("description")),
        "active": not_false(rec.get("active"))
    });
    if let Some(e) = &existing {
        let existing_sku = clean_text(e.get("sku"));
        if existing_sku != sku {
            if exists { return Err("Ese SKU ya existe".into()); }
            create_item(conn, "products", &sku, &record)?;
            delete_item(conn, "products", &existing_sku)?;
        } else {
            create_item(conn, "products", &sku, &record)?;
        }
    } else {
        create_item(conn, "products", &sku, &record)?;
    }
    Ok(json!({"ok": true, "product": record}))
}

fn op_delete_product(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "products")?;
    let sku = clean_text(payload.get("sku"));
    if sku.is_empty() { return Err("Falta SKU".into()); }
    let products = list_items(conn, "products");
    if !products.iter().any(|p| clean_text(p.get("sku")) == sku) {
        return Err("Producto no encontrado".into());
    }
    delete_item(conn, "products", &sku)?;
    Ok(json!({"ok": true}))
}

fn op_movement(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "movements")?;
    let products = list_items(conn, "products");
    let sku = clean_text(payload.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).cloned()
        .ok_or_else(|| "Producto no encontrado".to_string())?;
    let mtype = { let t = clean_text(payload.get("type")); if t.is_empty() { "entrada_compra".to_string() } else { t } };
    let mut qty = num_of(payload.get("quantity")).abs();
    if ["salida_manual", "merma"].contains(&mtype.as_str()) { qty = -qty; }
    let before = num_of(product.get("stock"));
    let after = before + qty;
    let cost = num_of(product.get("cost"));
    patch_item(conn, "products", &sku, &json!({"stock": after}))?;
    let id = format!("MOV-{}-{}", now_millis(), random_suffix());
    let rec = json!({
        "id": id, "timestamp": now_iso(), "type": mtype, "sku": sku,
        "productName": clean_text(product.get("name")),
        "quantity": qty, "stockBefore": before, "stockAfter": after,
        "unitCost": cost, "totalCost": qty * cost,
        "reason": clean_text(payload.get("reason")), "reference": clean_text(payload.get("reference")),
        "user": display_or_username(&user), "authorizedBy": "", "notes": ""
    });
    create_item(conn, "moves", &id, &rec)?;
    Ok(json!({"ok": true, "movement": rec}))
}

fn op_delete_movement(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "movements")?;
    let mut admin_user = user.clone();
    if let Some(admin_input) = payload.get("admin") {
        if !clean_text(admin_input.get("username")).is_empty() {
            admin_user = verify_supervisor(conn, admin_input)?;
        }
    }
    let id = clean_text(payload.get("id"));
    if id.is_empty() { return Err("Falta movimiento".into()); }
    let moves = list_items(conn, "moves");
    let mv = moves.iter().find(|m| clean_text(m.get("id")) == id).cloned()
        .ok_or_else(|| "Movimiento no encontrado".to_string())?;
    let products = list_items(conn, "products");
    let mv_sku = clean_text(mv.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == mv_sku).cloned();
    let mv_qty = num_of(mv.get("quantity"));
    let (stock_before, stock_after) = if let Some(p) = &product {
        let current = num_of(p.get("stock"));
        let corrected = current - mv_qty;
        patch_item(conn, "products", &mv_sku, &json!({"stock": corrected}))?;
        (json!(current), json!(corrected))
    } else { (json!(""), json!("")) };
    delete_item(conn, "moves", &id)?;
    let del_id = format!("MOV-DEL-{}-{}", now_millis(), random_suffix());
    let rec = json!({
        "id": del_id, "timestamp": now_iso(), "type": "eliminacion_movimiento", "sku": mv_sku,
        "productName": clean_text(mv.get("productName")),
        "quantity": -mv_qty, "stockBefore": stock_before, "stockAfter": stock_after,
        "unitCost": num_of(mv.get("unitCost")), "totalCost": -num_of(mv.get("totalCost")),
        "reason": format!("Eliminacion de {}", id), "reference": id,
        "user": display_or_username(&user), "authorizedBy": display_or_username(&admin_user), "notes": ""
    });
    create_item(conn, "moves", &del_id, &rec)?;
    Ok(json!({"ok": true}))
}

fn op_count(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_permission(conn, &user, "counts")?;
    let products = list_items(conn, "products");
    let sku = clean_text(payload.get("sku"));
    let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).cloned()
        .ok_or_else(|| "Producto no encontrado".to_string())?;
    let counted = num_of(payload.get("countedStock"));
    let before = num_of(product.get("stock"));
    let diff = counted - before;
    let id = format!("CNT-{}-{}", now_millis(), random_suffix());
    let inventory_id = { let i = clean_text(payload.get("inventoryId")); if !i.is_empty() { i } else { format!("INV-{}", now_millis()) } };
    let auth_or_user = { let a = clean_text(payload.get("authorizedBy")); if !a.is_empty() { a } else { display_or_username(&user) } };
    let rec = json!({
        "id": id, "inventoryId": inventory_id, "timestamp": now_iso(), "sku": sku,
        "productName": clean_text(product.get("name")),
        "barcode": clean_text(product.get("barcode")), "category": clean_text(product.get("category")),
        "presentation": clean_text(product.get("presentation")), "unit": clean_text(product.get("unit")),
        "supplier": clean_text(product.get("supplier")),
        "systemStock": before, "countedStock": counted, "difference": diff,
        "user": auth_or_user, "authorizedBy": clean_text(payload.get("authorizedBy")), "notes": clean_text(payload.get("notes"))
    });
    create_item(conn, "counts", &id, &rec)?;
    patch_item(conn, "products", &sku, &json!({"stock": counted}))?;
    if diff != 0.0 {
        let mov_id = format!("MOV-{}-{}", now_millis(), sku);
        let mov = json!({
            "id": mov_id, "timestamp": now_iso(), "type": "ajuste_conteo", "sku": sku,
            "productName": clean_text(product.get("name")),
            "quantity": diff, "stockBefore": before, "stockAfter": counted,
            "unitCost": num_of(product.get("cost")), "totalCost": diff * num_of(product.get("cost")),
            "reason": "Conteo fisico", "reference": id,
            "user": auth_or_user, "authorizedBy": clean_text(payload.get("authorizedBy")), "notes": clean_text(payload.get("notes"))
        });
        create_item(conn, "moves", &mov_id, &mov)?;
    }
    Ok(json!({"ok": true, "count": rec}))
}

fn op_checkout(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado", "cajero"])?;
    ensure_license_allows_sale(conn)?;
    let cash_state = get_item(conn, "cash_state", "current").unwrap_or_else(|| json!({"isOpen": false}));
    if !cash_state.get("isOpen").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("Debes abrir la caja antes de la primera venta. Indica el fondo inicial para comenzar.".into());
    }
    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if items.is_empty() { return Err("Ticket vacio".into()); }
    let products = list_items(conn, "products");
    let requested_id = { let a = clean_text(payload.get("clientId")); if !a.is_empty() { a } else { clean_text(payload.get("id")) } };
    let id = if !requested_id.is_empty() { requested_id } else { format!("SALE-{}", now_millis()) };
    let existing_sales = list_items(conn, "sales");
    if let Some(existing) = existing_sales.iter().find(|s| clean_text(s.get("id")) == id) {
        return Ok(json!({"ok": true, "sale": existing, "duplicate": true}));
    }
    let timestamp = now_iso();
    let mut subtotal = 0.0;
    let mut profit = 0.0;
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let product = products.iter().find(|p| clean_text(p.get("sku")) == sku)
            .ok_or_else(|| format!("Producto no encontrado: {}", sku))?;
        let qty = num_of(line.get("qty"));
        if qty <= 0.0 { return Err("Cantidad invalida".into()); }
        let stock = num_of(product.get("stock"));
        if stock < qty { return Err(format!("Stock insuficiente: {}", clean_text(product.get("name")))); }
        let price = num_of(product.get("price"));
        let cost = num_of(product.get("cost"));
        subtotal += price * qty;
        profit += (price - cost) * qty;
    }
    let discount = 0.0;
    let total = subtotal;
    let payments_input = payload.get("payments").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut payment_breakdown: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut payments_sum = 0.0;
    for (k, v) in &payments_input {
        let amt = v.as_f64().unwrap_or(0.0);
        if amt > 0.0 {
            payment_breakdown.insert(k.clone(), json!((amt * 100.0).round() / 100.0));
            payments_sum += amt;
        }
    }
    if payment_breakdown.is_empty() {
        let pm = { let p = clean_text(payload.get("paymentMethod")); if p.is_empty() { "Efectivo".to_string() } else { p } };
        payment_breakdown.insert(pm, json!(total));
        payments_sum = total;
    } else if (payments_sum - total).abs() > 0.01 {
        return Err(format!("El pago (${:.2}) no coincide con el total (${:.2})", payments_sum, total));
    }
    let payment_method = if payment_breakdown.len() > 1 {
        "Mixto".to_string()
    } else {
        payment_breakdown.keys().next().cloned().unwrap_or_else(|| "Efectivo".to_string())
    };
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let product = products.iter().find(|p| clean_text(p.get("sku")) == sku).unwrap();
        let qty = num_of(line.get("qty"));
        let before = num_of(product.get("stock"));
        let after = before - qty;
        patch_item(conn, "products", &sku, &json!({"stock": after}))?;
        let mov_id = format!("MOV-{}-{}", now_millis(), sku);
        let cost = num_of(product.get("cost"));
        let mov = json!({
            "id": mov_id, "timestamp": timestamp, "type": "venta", "sku": sku,
            "productName": clean_text(product.get("name")),
            "quantity": -qty, "stockBefore": before, "stockAfter": after,
            "unitCost": cost, "totalCost": -cost * qty,
            "reason": "Venta POS", "reference": id, "user": display_or_username(&user), "notes": ""
        });
        create_item(conn, "moves", &mov_id, &mov)?;
    }
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
    let sale = json!({
        "id": id, "timestamp": timestamp, "itemsJson": items_json, "subtotal": subtotal,
        "discount": discount, "total": total, "paymentMethod": payment_method,
        "paymentBreakdown": Value::Object(payment_breakdown),
        "user": display_or_username(&user), "notes": "", "profit": profit
    });
    create_item(conn, "sales", &id, &sale)?;
    Ok(json!({"ok": true, "sale": sale}))
}

fn op_cancel_sale(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    let mut admin_user = user.clone();
    if assert_role(&user, &["admin", "encargado"]).is_err() {
        let admin_input = payload.get("admin")
            .ok_or_else(|| "No autorizado".to_string())?;
        if clean_text(admin_input.get("username")).is_empty() {
            return Err("No autorizado".into());
        }
        admin_user = verify_supervisor(conn, admin_input)?;
    }
    let id = clean_text(payload.get("id"));
    if id.is_empty() { return Err("Falta la venta a cancelar".into()); }
    let sales = list_items(conn, "sales");
    let sale = sales.iter().find(|s| clean_text(s.get("id")) == id).cloned()
        .ok_or_else(|| "Venta no encontrada".to_string())?;
    if truthy_opt(sale.get("cancelled")) {
        return Err("Esta venta ya habia sido cancelada".into());
    }
    let items: Vec<Value> = serde_json::from_str(&clean_text(sale.get("itemsJson"))).unwrap_or_default();
    if items.is_empty() {
        return Err("Esta venta no tiene productos que revertir".into());
    }
    let products = list_items(conn, "products");
    let mut restored: Vec<Value> = vec![];
    let mut skipped: Vec<String> = vec![];
    let timestamp = now_iso();
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let qty = num_of(line.get("qty"));
        if let Some(product) = products.iter().find(|p| clean_text(p.get("sku")) == sku) {
            let before = num_of(product.get("stock"));
            let after = before + qty;
            patch_item(conn, "products", &sku, &json!({"stock": after}))?;
            let mov_id = format!("MOV-DEV-{}-{}", now_millis(), sku);
            let cost = num_of(product.get("cost"));
            let mov = json!({
                "id": mov_id, "timestamp": timestamp, "type": "devolucion_venta", "sku": sku,
                "productName": clean_text(line.get("name")),
                "quantity": qty, "stockBefore": before, "stockAfter": after,
                "unitCost": cost, "totalCost": cost * qty,
                "reason": format!("Cancelacion de venta {}", id), "reference": id,
                "user": display_or_username(&user), "authorizedBy": display_or_username(&admin_user), "notes": ""
            });
            create_item(conn, "moves", &mov_id, &mov)?;
            restored.push(json!({"sku": sku, "qty": qty}));
        } else {
            // el producto ya no existe en el catalogo (fue eliminado despues de la venta):
            // no hay a donde devolver la existencia, se deja constancia y se continua.
            skipped.push(sku);
        }
    }
    patch_item(conn, "sales", &id, &json!({
        "cancelled": true,
        "cancelledAt": timestamp,
        "cancelledBy": display_or_username(&user),
        "cancelledAuthorizedBy": display_or_username(&admin_user)
    }))?;
    Ok(json!({"ok": true, "restored": restored, "skippedSkus": skipped}))
}

fn op_sync_batch(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado", "cajero"])?;
    let items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut results = vec![];
    for item in items {
        let op = clean_text(item.get("op"));
        if op == "checkout" {
            let sub_payload = item.get("payload").cloned().unwrap_or_else(|| json!({}));
            match op_checkout(conn, sessions, token, &sub_payload) {
                Ok(v) => results.push(v),
                Err(e) => results.push(json!({"ok": false, "error": e})),
            }
        } else {
            results.push(json!({"ok": false, "error": "Operacion de cola no soportada"}));
        }
    }
    Ok(json!({"ok": true, "results": results}))
}

fn dispatch(op: &str, payload: &Value, token: &str, conn: &Connection, sessions: &mut HashMap<String, Session>) -> Result<Value, String> {
    match op {
        "bootstrap" => op_bootstrap(conn),
        "setup_admin" => op_setup_admin(conn, payload),
        "login" => op_login(conn, sessions, payload),
        "logout" => Ok(op_logout(sessions, token)),
        "data" => op_data(conn, sessions, token),
        "save_user" => op_save_user(conn, sessions, token, payload),
        "delete_user" => op_delete_user(conn, sessions, token, payload),
        "save_settings" => op_save_settings(conn, sessions, token, payload),
        "save_role_permissions" => op_save_role_permissions(conn, sessions, token, payload),
        "save_catalog" => op_save_catalog(conn, sessions, token, payload),
        "delete_catalog" => op_delete_catalog(conn, sessions, token, payload),
        "save_product" => op_save_product(conn, sessions, token, payload),
        "delete_product" => op_delete_product(conn, sessions, token, payload),
        "movement" => op_movement(conn, sessions, token, payload),
        "delete_movement" => op_delete_movement(conn, sessions, token, payload),
        "count" => op_count(conn, sessions, token, payload),
        "checkout" => op_checkout(conn, sessions, token, payload),
        "cancel_sale" => op_cancel_sale(conn, sessions, token, payload),
        "sync_batch" => op_sync_batch(conn, sessions, token, payload),
        "open_cash_register" => op_open_cash_register(conn, sessions, token, payload),
        "cash_cut" => op_cash_cut(conn, sessions, token, payload),
        _ => Ok(json!({"ok": false, "error": "Operacion no reconocida"})),
    }
}

#[tauri::command]
fn backend_call(
    op: String,
    payload: Value,
    session_token: String,
    db: tauri::State<DbConn>,
    sessions: tauri::State<SessionStore>,
) -> Value {
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return json!({"ok": false, "error": "Error de base de datos local"}),
    };
    let mut sess = match sessions.0.lock() {
        Ok(s) => s,
        Err(_) => return json!({"ok": false, "error": "Error de sesion"}),
    };
    match dispatch(&op, &payload, &session_token, &conn, &mut sess) {
        Ok(v) => v,
        Err(msg) => json!({"ok": false, "error": msg}),
    }
}

fn init_db(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS store_data (
            store TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (store, id)
        )",
        [],
    )
    .expect("no se pudo crear la tabla store_data");
    // v0.2.12: cola de envio a la nube. Solo se agrega; no toca los datos existentes.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS outbox (
            store TEXT NOT NULL,
            id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            tombstone TEXT,
            PRIMARY KEY (store, id)
        )",
        [],
    )
    .expect("no se pudo crear la tabla outbox");
}

// ---------- nube (Supabase): registro de la caja, envio y latido ----------
//
// La caja se registra una vez con su license_key y recibe un token secreto propio
// (la license_key sola no basta: se puede adivinar). Un hilo en segundo plano envia
// la cola (outbox) con la RPC pos_push y manda un latido cada minuto. La base local
// NUNCA queda bloqueada mientras se usa la red: se toma el candado solo para leer o
// para marcar lo enviado. Si no hay internet, todo se queda en la cola local.

const SUPABASE_URL: &str = "https://qizccncdyhzxeltwzjni.supabase.co/rest/v1";
const SUPABASE_KEY: &str = "sb_publishable_yrmAdp65Ai2IzEnTQkMVeA_zT_qeLSA";
const PUSH_BATCH: usize = 300;
const HEARTBEAT_SECS: i64 = 60;
const DEFAULT_STORE_TITLE: &str = "Tienda de Conveniencia";

// Para despertar al hilo de envio en cuanto hay algo nuevo en la cola.
// (bool = hay trabajo, bool = forzar latido)
static CLOUD_WAKE: OnceLock<(Mutex<(bool, bool)>, Condvar)> = OnceLock::new();
// Un solo envio a la vez.
static CLOUD_STEP: Mutex<()> = Mutex::new(());

fn cloud_wake() -> &'static (Mutex<(bool, bool)>, Condvar) {
    CLOUD_WAKE.get_or_init(|| (Mutex::new((false, false)), Condvar::new()))
}

fn wake_cloud_worker(force_heartbeat: bool) {
    let (m, c) = cloud_wake();
    if let Ok(mut f) = m.lock() {
        f.0 = true;
        f.1 = f.1 || force_heartbeat;
    }
    c.notify_all();
}

// Espera hasta `timeout` o hasta que alguien despierte al hilo. Devuelve si hay que forzar el latido.
fn wait_cloud_worker(timeout: Duration) -> bool {
    let (m, c) = cloud_wake();
    let guard = match m.lock() { Ok(g) => g, Err(_) => return false };
    let (mut guard, _) = match c.wait_timeout_while(guard, timeout, |f| !f.0) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let force = guard.1;
    *guard = (false, false);
    force
}

fn cloud_state(conn: &Connection) -> Value {
    get_item(conn, "cloud", "device").unwrap_or_else(|| json!({}))
}

fn save_cloud_state(conn: &Connection, patch: &Value) {
    patch_item(conn, "cloud", "device", patch).ok();
}

fn assigned_store_title(conn: &Connection) -> String {
    let t = clean_text(read_settings(conn).get("storeTitle"));
    if t == DEFAULT_STORE_TITLE { String::new() } else { t }
}

// Nombre de la caja en la nube: el nombre de la tienda cuando ya se asigno;
// mientras tanto, el nombre de Windows del equipo.
fn cloud_device_name(store_title: &str) -> String {
    if !store_title.is_empty() {
        return store_title.chars().take(80).collect();
    }
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    if host.trim().is_empty() { "Caja".to_string() } else { host.trim().to_string() }
}

fn rpc_call(name: &str, args: &Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/rpc/{}", SUPABASE_URL, name))
        .header("apikey", SUPABASE_KEY)
        .header("Content-Type", "application/json")
        .json(args)
        .send()
        .map_err(|_| "Sin conexion con la nube".to_string())?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .map(|v| clean_text(v.get("message")))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| format!("La nube respondio {}", status));
        return Err(msg);
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// ----- conversion de registros locales al formato de la nube -----
// Solo se copian los campos listados. Contrasenas, hashes, salt y pin NUNCA salen.

fn opt_text(v: Option<&Value>) -> Value {
    let t = clean_text(v);
    if t.is_empty() { Value::Null } else { json!(t) }
}

fn cloud_product(p: &Value) -> Value {
    json!({
        "internal_id": clean_text(p.get("sku")),
        "barcode": opt_text(p.get("barcode")),
        "name": opt_text(p.get("name")),
        "category": opt_text(p.get("category")),
        "presentation": opt_text(p.get("presentation")),
        "supplier": opt_text(p.get("supplier")),
        "unit": opt_text(p.get("unit")),
        "cost": num_of(p.get("cost")),
        "price": num_of(p.get("price")),
        "stock": num_of(p.get("stock")),
        "min_stock": num_of(p.get("minStock")),
        "description": opt_text(p.get("description")),
        "active": not_false(p.get("active"))
    })
}

fn cloud_user(u: &Value) -> Value {
    json!({
        "username": clean_text(u.get("username")),
        "display_name": opt_text(u.get("displayName")),
        "role": opt_text(u.get("role")),
        "active": not_false(u.get("active"))
    })
}

fn cloud_movement(m: &Value) -> Value {
    json!({
        "id": clean_text(m.get("id")),
        "ts": opt_text(m.get("timestamp")),
        "type": opt_text(m.get("type")),
        "internal_id": opt_text(m.get("sku")),
        "product_name": opt_text(m.get("productName")),
        "quantity": m.get("quantity").cloned().unwrap_or(Value::Null),
        "stock_before": m.get("stockBefore").cloned().unwrap_or(Value::Null),
        "stock_after": m.get("stockAfter").cloned().unwrap_or(Value::Null),
        "unit_cost": m.get("unitCost").cloned().unwrap_or(Value::Null),
        "total_cost": m.get("totalCost").cloned().unwrap_or(Value::Null),
        "reason": opt_text(m.get("reason")),
        "reference": opt_text(m.get("reference")),
        "user_name": opt_text(m.get("user")),
        "authorized_by": opt_text(m.get("authorizedBy")),
        "notes": opt_text(m.get("notes"))
    })
}

fn cloud_cut(c: &Value) -> Value {
    json!({
        "id": clean_text(c.get("id")),
        "type": opt_text(c.get("type")),
        "ts": opt_text(c.get("timestamp")),
        "period_start": opt_text(c.get("periodStart")),
        "period_end": opt_text(c.get("periodEnd")),
        "opening_amount": num_of(c.get("openingAmount")),
        "total": num_of(c.get("total")),
        "sales_count": num_of(c.get("salesCount")),
        "payments": c.get("payments").cloned().unwrap_or_else(|| json!({})),
        "cashier": opt_text(c.get("user")),
        "notes": opt_text(c.get("notes")),
        "detail": c.clone()
    })
}

fn cloud_sale(conn: &Connection, s: &Value) -> Value {
    let lines: Vec<Value> = serde_json::from_str(&clean_text(s.get("itemsJson"))).unwrap_or_default();
    let items: Vec<Value> = lines
        .iter()
        .map(|l| {
            let sku = clean_text(l.get("sku"));
            // las ventas viejas pueden no traer codigo o costo en la linea: se completa con el producto
            let needs_product = clean_text(l.get("barcode")).is_empty() || l.get("cost").is_none() || l.get("name").is_none();
            let product = if needs_product { get_item(conn, "products", &sku) } else { None };
            let from = |k: &str| l.get(k).filter(|v| !clean_text(Some(v)).is_empty()).or_else(|| product.as_ref().and_then(|p| p.get(k)));
            json!({
                "internal_id": sku,
                "barcode": opt_text(from("barcode")),
                "name": opt_text(from("name")),
                "qty": num_of(l.get("qty")),
                "price": from("price").cloned().unwrap_or(Value::Null),
                "cost": from("cost").cloned().unwrap_or(Value::Null)
            })
        })
        .collect();
    json!({
        "id": clean_text(s.get("id")),
        "ts": opt_text(s.get("timestamp")),
        "subtotal": num_of(s.get("subtotal")),
        "discount": num_of(s.get("discount")),
        "total": num_of(s.get("total")),
        "payment_method": opt_text(s.get("paymentMethod")),
        "payment_breakdown": s.get("paymentBreakdown").cloned().unwrap_or_else(|| json!({})),
        "cashier": opt_text(s.get("user")),
        "profit": num_of(s.get("profit")),
        "notes": opt_text(s.get("notes")),
        "cancelled": truthy_opt(s.get("cancelled")),
        "cancelled_at": opt_text(s.get("cancelledAt")),
        "cancelled_by": opt_text(s.get("cancelledBy")),
        "cancelled_authorized_by": opt_text(s.get("cancelledAuthorizedBy")),
        "items": items
    })
}

// Arma un envio con lo que hay en la cola. Devuelve el lote y las claves (store, id, version)
// para marcarlas como enviadas solo si Supabase confirma.
fn build_push_batch(conn: &Connection, limit: usize) -> (Value, Vec<(String, String, i64)>) {
    let mut keys: Vec<(String, String, i64, Option<String>)> = vec![];
    if let Ok(mut stmt) = conn.prepare("SELECT store, id, version, tombstone FROM outbox ORDER BY rowid LIMIT ?1") {
        if let Ok(rows) = stmt.query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))) {
            keys = rows.filter_map(|r| r.ok()).collect();
        }
    }
    let mut batch = json!({
        "at": now_iso(), "products": [], "sales": [], "movements": [], "cash_cuts": [], "users": []
    });
    let push = |batch: &mut Value, kind: &str, row: Value| {
        if let Some(a) = batch.get_mut(kind).and_then(|v| v.as_array_mut()) { a.push(row); }
    };
    for (store, id, _, tombstone) in &keys {
        let current = get_item(conn, store, id);
        let (record, deleted) = match (&current, tombstone) {
            (Some(r), _) => (r.clone(), false),
            (None, Some(t)) => (serde_json::from_str::<Value>(t).unwrap_or_else(|_| json!({})), true),
            (None, None) => (json!({}), true),
        };
        let mark = |mut v: Value| { if deleted { v["deleted"] = json!(true); } v };
        match store.as_str() {
            "products" => { let mut v = cloud_product(&record); v["internal_id"] = json!(id); push(&mut batch, "products", mark(v)); }
            "users" => { let mut v = cloud_user(&record); v["username"] = json!(id); push(&mut batch, "users", mark(v)); }
            "moves" => { let mut v = cloud_movement(&record); v["id"] = json!(id); push(&mut batch, "movements", mark(v)); }
            // ventas y cortes nunca se borran en la caja
            "sales" if !deleted => push(&mut batch, "sales", cloud_sale(conn, &record)),
            "cash_cuts" if !deleted => push(&mut batch, "cash_cuts", cloud_cut(&record)),
            // permisos efectivos: los guardados o, si nunca se cambiaron, los de fabrica
            "role_permissions" => { batch["role_permissions"] = read_role_permissions(conn); }
            _ => {}
        }
    }
    (batch, keys.into_iter().map(|(s, i, v, _)| (s, i, v)).collect())
}

fn ack_push_batch(conn: &Connection, keys: &[(String, String, i64)]) {
    for (store, id, version) in keys {
        conn.execute(
            "DELETE FROM outbox WHERE store = ?1 AND id = ?2 AND version = ?3",
            params![store, id, version],
        )
        .ok();
    }
}

fn active_session_user(app: &tauri::AppHandle) -> String {
    let now = now_millis();
    app.state::<SessionStore>()
        .0
        .lock()
        .ok()
        .and_then(|s| {
            s.values()
                .filter(|x| x.expires_at > now)
                .max_by_key(|x| x.expires_at)
                .map(|x| x.username.clone())
        })
        .unwrap_or_default()
}

fn with_db<T>(app: &tauri::AppHandle, f: impl FnOnce(&Connection) -> T) -> Option<T> {
    let db = app.state::<DbConn>();
    let conn = db.0.lock().ok()?;
    Some(f(&conn))
}

// Un ciclo completo: registrar si hace falta, latido si toca y vaciar la cola.
// Devuelve Ok si se pudo hablar con la nube.
fn cloud_step(app: &tauri::AppHandle, force_heartbeat: bool) -> Result<(), String> {
    let _one_at_a_time = CLOUD_STEP.lock().map_err(|_| "ocupado".to_string())?;
    let app_version = app.package_info().version.to_string();
    let (state, license_key, store_title) = with_db(app, |conn| {
        (cloud_state(conn), get_or_create_license_key(conn), assigned_store_title(conn))
    })
    .ok_or("Error de base de datos local")?;

    // 1. registro (una sola vez)
    let mut token = clean_text(state.get("token"));
    let mut status = clean_text(state.get("status"));
    if token.is_empty() {
        let r = rpc_call("pos_register_device", &json!({
            "p_license_key": license_key,
            "p_device_name": cloud_device_name(&store_title),
            "p_app_version": app_version,
            "p_business_name": if store_title.is_empty() { Value::Null } else { json!(store_title) }
        }));
        match r {
            Ok(v) => {
                token = clean_text(v.get("token"));
                status = clean_text(v.get("status"));
                with_db(app, |conn| save_cloud_state(conn, &json!({
                    "deviceId": clean_text(v.get("device_id")), "token": token, "status": status,
                    "registeredAt": now_iso(), "lastError": ""
                })));
            }
            Err(e) => {
                with_db(app, |conn| save_cloud_state(conn, &json!({"lastError": e})));
                return Err(e);
            }
        }
    }
    if status == "revocado" {
        return Ok(());
    }

    // 2. latido
    let last_hb = state.get("lastHeartbeatMs").and_then(|v| v.as_i64()).unwrap_or(0);
    if force_heartbeat || now_millis() - last_hb >= HEARTBEAT_SECS * 1000 || status != "aprobado" {
        let cash = with_db(app, |conn| get_item(conn, "cash_state", "current")).flatten().unwrap_or_else(|| json!({}));
        let r = rpc_call("pos_heartbeat", &json!({
            "p_token": token,
            "p_info": {
                "app_version": app_version,
                "device_name": cloud_device_name(&store_title),
                "business_name": if store_title.is_empty() { Value::Null } else { json!(store_title) },
                "session_user": active_session_user(app),
                "cash_open": truthy_opt(cash.get("isOpen")),
                "cash_period_start": opt_text(cash.get("periodStart")),
                "cash_opening_amount": num_of(cash.get("openingAmount"))
            }
        }));
        match r {
            Ok(v) => {
                status = clean_text(v.get("status"));
                with_db(app, |conn| save_cloud_state(conn, &json!({
                    "status": status, "lastHeartbeatMs": now_millis(), "lastError": ""
                })));
            }
            Err(e) => {
                if e.contains("no registrada o revocada") {
                    status = "revocado".to_string();
                }
                with_db(app, |conn| save_cloud_state(conn, &json!({"status": status, "lastError": e})));
                return Err(e);
            }
        }
    }
    if status != "aprobado" {
        return Ok(());
    }

    // 3. carga inicial (una vez, al quedar aprobada): encola todo lo local
    if !truthy_opt(state.get("initialLoadDone")) {
        with_db(app, |conn| {
            if outbox_enqueue_all(conn).is_ok() {
                save_cloud_state(conn, &json!({"initialLoadDone": true, "initialLoadAt": now_iso()}));
            }
        });
    }

    // 4. vaciar la cola por lotes
    for _ in 0..200 {
        let (batch, keys) = with_db(app, |conn| build_push_batch(conn, PUSH_BATCH)).ok_or("Error de base de datos local")?;
        if keys.is_empty() {
            break;
        }
        match rpc_call("pos_push", &json!({"p_token": token, "p_batch": batch})) {
            Ok(_) => {
                with_db(app, |conn| {
                    ack_push_batch(conn, &keys);
                    save_cloud_state(conn, &json!({"lastPushOkAt": now_iso(), "lastError": ""}));
                });
            }
            Err(e) => {
                with_db(app, |conn| save_cloud_state(conn, &json!({"lastError": e})));
                return Err(e);
            }
        }
    }
    Ok(())
}

// Hilo en segundo plano: envia en cuanto hay cambios y manda el latido cada minuto.
// Si falla, reintenta cada vez mas espaciado (5 s, 15 s, 1 min, hasta 5 min).
fn cloud_worker(app: tauri::AppHandle) {
    std::thread::sleep(Duration::from_secs(8));
    let backoff = [5u64, 15, 60, 300];
    let mut fails = 0usize;
    let mut force = true;
    loop {
        match cloud_step(&app, force) {
            Ok(()) => fails = 0,
            Err(_) => fails = (fails + 1).min(backoff.len()),
        }
        let wait = if fails == 0 { HEARTBEAT_SECS as u64 } else { backoff[fails - 1] };
        force = wait_cloud_worker(Duration::from_secs(wait));
        // pequena pausa para juntar en un solo envio los cambios de una misma venta
        std::thread::sleep(Duration::from_millis(1500));
    }
}

fn cloud_status(conn: &Connection) -> Value {
    let st = cloud_state(conn);
    let status = clean_text(st.get("status"));
    let pending = outbox_count(conn);
    let last_error = clean_text(st.get("lastError"));
    let message = match status.as_str() {
        "aprobado" if pending == 0 => "Al dia".to_string(),
        "aprobado" if last_error.is_empty() => format!("Enviando {} cambio(s)", pending),
        "aprobado" => format!("Sin conexion: {} cambio(s) guardados para enviar", pending),
        "pendiente" => format!("Caja pendiente de aprobacion ({} cambio(s) guardados para enviar)", pending),
        "revocado" => "Esta caja fue dada de baja en la nube".to_string(),
        _ => format!("Aun sin conectar a la nube ({} cambio(s) guardados para enviar)", pending),
    };
    json!({
        "ok": status == "aprobado" && last_error.is_empty(),
        "status": if status.is_empty() { "sin_registrar".to_string() } else { status },
        "pending": pending,
        "lastPushOkAt": clean_text(st.get("lastPushOkAt")),
        "error": last_error,
        "message": message
    })
}

// Lo llama la pantalla (boton Actualizar y cada 20 min). No usa la red: despierta al
// hilo de envio y responde al instante con el estado actual.
#[tauri::command]
fn sync_to_cloud(db: tauri::State<DbConn>) -> Value {
    wake_cloud_worker(true);
    match db.0.lock() {
        Ok(conn) => cloud_status(&conn),
        Err(_) => json!({"ok": false, "error": "Error de base de datos local"}),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            let data_dir = handle
                .path_resolver()
                .app_data_dir()
                .expect("no se pudo resolver el directorio de datos de la app");
            fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("tienda_pos.sqlite");
            let conn = Connection::open(db_path).expect("no se pudo abrir la base de datos");
            init_db(&conn);
            app.manage(DbConn(Mutex::new(conn)));
            app.manage(SessionStore(Mutex::new(HashMap::new())));
            // envio a la nube en segundo plano (nunca bloquea la venta)
            let cloud_handle = handle.clone();
            std::thread::spawn(move || cloud_worker(cloud_handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_call, check_license, check_for_update, download_and_launch_update, sync_to_cloud, exit_app])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicacion Tauri");
}

// ---------- pruebas automaticas (no se incluyen en el programa final) ----------
// Se ejecutan con `cargo test` antes de publicar cada version. El flujo de GitHub
// Actions las corre y NO publica nada si alguna falla.
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn fresh() -> (Connection, HashMap<String, Session>, String) {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn);
        let mut sessions = HashMap::new();
        dispatch("setup_admin", &json!({"loginCode":"1234","password":"1234","displayName":"Admin"}), "", &conn, &mut sessions).unwrap();
        let r = dispatch("login", &json!({"code":"1234"}), "", &conn, &mut sessions).unwrap();
        let token = r["sessionToken"].as_str().unwrap().to_string();
        (conn, sessions, token)
    }
    fn put(conn: &Connection, sku: &str, barcode: &str, name: &str, price: f64, stock: f64) {
        create_item(conn, "products", sku, &json!({"sku":sku,"barcode":barcode,"name":name,"category":"Bebidas","presentation":"Pieza","unit":"pieza","stock":stock,"minStock":1,"price":price,"cost":price/2.0,"active":true})).unwrap();
    }
    fn count(conn: &Connection) -> usize { list_items(conn, "products").len() }
    fn stock_of(conn: &Connection, sku: &str) -> f64 { num_of(get_item(conn, "products", sku).unwrap().get("stock")) }

    #[test]
    fn productos_nuevos_no_sobrescriben_a_los_existentes() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        put(&conn, "BEB-0002", "", "Granel", 9.0, 7.0);
        // el SKU que mande el cliente se ignora: jamas debe pisar a un producto existente
        let r = dispatch("save_product", &json!({"record":{"sku":"BEB-0001","barcode":"222","name":"Nuevo","category":"Bebidas","price":20,"cost":10,"stock":3}}), &t, &conn, &mut s).unwrap();
        assert_ne!(r["product"]["sku"].as_str().unwrap(), "BEB-0001");
        assert_eq!(count(&conn), 3);
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["name"], "Agua");
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        // codigo de barras obligatorio y unico
        assert!(dispatch("save_product", &json!({"record":{"name":"X","category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s).is_err());
        assert!(dispatch("save_product", &json!({"record":{"barcode":"111","name":"Y","category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s).is_err());
        assert_eq!(count(&conn), 3);
        // editar conserva identificador y existencia
        dispatch("save_product", &json!({"editingSku":"BEB-0001","record":{"barcode":"111","name":"Agua 600","category":"Bebidas","price":13,"cost":5,"stock":999}}), &t, &conn, &mut s).unwrap();
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["name"], "Agua 600");
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        // un producto viejo sin codigo (a granel) se puede seguir editando
        dispatch("save_product", &json!({"editingSku":"BEB-0002","record":{"barcode":"","name":"Granel","category":"Bebidas","price":9,"cost":4,"active":false}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0002"), 7.0);
        assert!(dispatch("save_product", &json!({"editingSku":"NOPE","record":{"barcode":"999","name":"Z","category":"Bebidas"}}), &t, &conn, &mut s).is_err());
        assert_eq!(count(&conn), 3);
        // 50 productos nuevos seguidos: ids distintos
        let mut ids = std::collections::HashSet::new();
        for i in 0..50 {
            let r = dispatch("save_product", &json!({"record":{"barcode":format!("B{}",i),"name":format!("P{}",i),"category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s).unwrap();
            ids.insert(r["product"]["sku"].as_str().unwrap().to_string());
        }
        assert_eq!(ids.len(), 50);
        assert_eq!(count(&conn), 53);
    }

    #[test]
    fn un_alta_nunca_pisa_a_un_producto_que_quedo_en_edicion() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        // la pantalla dejo "BEB-0001" en editingSku pero dice que es un alta: se crea uno nuevo
        let r = dispatch("save_product", &json!({"mode":"new","editingSku":"BEB-0001","record":{"barcode":"750100","name":"Chocolate","category":"Botanas","price":14,"cost":8,"stock":6}}), &t, &conn, &mut s).unwrap();
        assert_ne!(r["product"]["sku"], "BEB-0001");
        assert_eq!(count(&conn), 2);
        let agua = get_item(&conn, "products", "BEB-0001").unwrap();
        assert_eq!(agua["name"], "Agua");
        assert_eq!(agua["barcode"], "111");
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        // una edicion que cambia nombre Y codigo a la vez pide confirmar y no toca nada
        let e = dispatch("save_product", &json!({"mode":"edit","editingSku":"BEB-0001","record":{"barcode":"999","name":"Otra cosa","category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s);
        assert!(e.unwrap_err().starts_with("CONFIRMAR:"));
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["name"], "Agua");
        // las ediciones normales (solo precio, o solo nombre) pasan sin preguntar
        dispatch("save_product", &json!({"mode":"edit","editingSku":"BEB-0001","record":{"barcode":"111","name":"Agua 1L","category":"Bebidas","price":13,"cost":6}}), &t, &conn, &mut s).unwrap();
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["name"], "Agua 1L");
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        // y con confirmacion explicita, el cambio grande se permite
        dispatch("save_product", &json!({"mode":"edit","editingSku":"BEB-0001","confirmRename":true,"record":{"barcode":"999","name":"Otra cosa","category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s).unwrap();
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["barcode"], "999");
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
    }

    #[test]
    fn la_personalizacion_conserva_todas_sus_opciones() {
        let n = normalize_settings(&json!({"ticketPaperWidth":"58","ticketCompactMode":true,"ticketLineSpacing":"tight","cashCutLineSpacing":"wide","cashCutShowUnit":true,"cashCutShowSupplier":true,"cashCutShowBarcode":false}));
        assert_eq!(n["ticketPaperWidth"], "58");
        assert_eq!(n["ticketCompactMode"], true);
        assert_eq!(n["ticketLineSpacing"], "tight");
        assert_eq!(n["cashCutLineSpacing"], "wide");
        assert_eq!(n["cashCutShowUnit"], true);
        assert_eq!(n["cashCutShowSupplier"], true);
        assert_eq!(n["cashCutShowBarcode"], false);
        let d = normalize_settings(&json!({}));
        assert_eq!(d["ticketPaperWidth"], "80");
        assert_eq!(d["cashCutShowName"], true);
    }

    #[test]
    fn venta_completa_descuenta_inventario_y_valida_el_total() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.5, 10.0);
        put(&conn, "P1759000000000ABC", "222", "Refresco", 18.0, 5.0);
        // sin caja abierta no se puede vender
        let items = json!([{"sku":"BEB-0001","qty":2},{"sku":"P1759000000000ABC","qty":1}]);
        assert!(dispatch("checkout", &json!({"items":items,"payments":{"Efectivo":43.0}}), &t, &conn, &mut s).is_err());
        dispatch("open_cash_register", &json!({"openingAmount":100}), &t, &conn, &mut s).unwrap();
        // pago que no coincide: rechazado y sin tocar inventario
        let bad = dispatch("checkout", &json!({"clientId":"S1","items":items,"payments":{"Efectivo":44.0}}), &t, &conn, &mut s);
        assert!(bad.is_err() && bad.unwrap_err().contains("no coincide con el total"));
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        assert_eq!(stock_of(&conn, "P1759000000000ABC"), 5.0);
        // pago correcto: descuenta una sola vez y registra movimientos
        dispatch("checkout", &json!({"clientId":"S2","items":items,"payments":{"Efectivo":43.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 8.0);
        assert_eq!(stock_of(&conn, "P1759000000000ABC"), 4.0);
        // reintento con el mismo folio no vuelve a descontar
        dispatch("checkout", &json!({"clientId":"S2","items":items,"payments":{"Efectivo":43.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 8.0);
        // cancelar la venta devuelve el inventario
        dispatch("cancel_sale", &json!({"id":"S2"}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
        assert_eq!(stock_of(&conn, "P1759000000000ABC"), 5.0);
    }

    fn outbox_keys(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn.prepare("SELECT store, id FROM outbox ORDER BY store, id").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }
    fn snapshot(conn: &Connection) -> Vec<(String, String, String)> {
        let mut stmt = conn.prepare("SELECT store, id, data FROM store_data ORDER BY store, id").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }
    fn clear_outbox(conn: &Connection) { conn.execute("DELETE FROM outbox", []).unwrap(); }

    #[test]
    fn la_cola_anota_cada_cambio_una_sola_vez() {
        let (conn, mut s, t) = fresh();
        clear_outbox(&conn);
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        dispatch("open_cash_register", &json!({"openingAmount":100}), &t, &conn, &mut s).unwrap();
        let items = json!([{"sku":"BEB-0001","barcode":"111","name":"Agua","qty":2,"price":12.0,"cost":6.0}]);
        dispatch("checkout", &json!({"clientId":"S1","items":items,"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S2","items":items,"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).unwrap();
        let keys = outbox_keys(&conn);
        let n = |store: &str| keys.iter().filter(|(s, _)| s == store).count();
        assert_eq!(n("products"), 1, "el producto cambio 3 veces pero se anota una vez");
        assert_eq!(n("sales"), 2);
        assert_eq!(n("moves"), 2);
        assert_eq!(n("cash_cuts"), 1, "la apertura de caja");
        // lo que no se espejea no entra a la cola
        assert_eq!(n("cash_state"), 0);
        assert_eq!(n("settings"), 0);
    }

    #[test]
    fn lo_enviado_sale_de_la_cola_solo_si_no_cambio_mientras_se_enviaba() {
        let (conn, mut s, t) = fresh();
        clear_outbox(&conn);
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        put(&conn, "BEB-0002", "222", "Jugo", 15.0, 4.0);
        let (batch, keys) = build_push_batch(&conn, PUSH_BATCH);
        assert_eq!(batch["products"].as_array().unwrap().len(), 2);
        // mientras "viaja" el envio, se vende un jugo
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0002","qty":1,"price":15.0}],"payments":{"Efectivo":15.0}}), &t, &conn, &mut s).unwrap();
        ack_push_batch(&conn, &keys);
        let left = outbox_keys(&conn);
        assert!(!left.contains(&("products".into(), "BEB-0001".into())), "el agua ya se envio");
        assert!(left.contains(&("products".into(), "BEB-0002".into())), "el jugo cambio: debe reenviarse");
        // y el reenvio lleva el stock nuevo
        let (batch2, _) = build_push_batch(&conn, PUSH_BATCH);
        let jugo = batch2["products"].as_array().unwrap().iter().find(|p| p["internal_id"] == "BEB-0002").unwrap();
        assert_eq!(jugo["stock"], 3.0);
    }

    #[test]
    fn el_envio_nunca_lleva_contrasenas_y_las_ventas_llevan_su_detalle() {
        let (conn, mut s, t) = fresh();
        let admin = get_item(&conn, "users", "1234").unwrap();
        let hash = clean_text(admin.get("passwordHash"));
        let salt = clean_text(admin.get("salt"));
        assert!(!hash.is_empty() && !salt.is_empty());
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0001","qty":2}],"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).unwrap();
        dispatch("cancel_sale", &json!({"id":"S1"}), &t, &conn, &mut s).unwrap();
        let (batch, _) = build_push_batch(&conn, PUSH_BATCH);
        let text = batch.to_string();
        assert!(!text.contains(&hash) && !text.contains(&salt));
        assert!(!text.contains("passwordHash") && !text.contains("\"salt\"") && !text.contains("\"pin\""));
        assert_eq!(batch["users"][0]["username"], "1234");
        let sale = &batch["sales"][0];
        assert_eq!(sale["cancelled"], true);
        // la linea no traia codigo ni costo: se completan con el producto
        assert_eq!(sale["items"][0]["barcode"], "111");
        assert_eq!(sale["items"][0]["cost"], 6.0);
        assert_eq!(sale["items"][0]["qty"], 2.0);
        // sin permisos guardados viajan los de fabrica, completos
        outbox_enqueue_all(&conn).unwrap();
        let (batch, _) = build_push_batch(&conn, PUSH_BATCH);
        assert_eq!(batch["role_permissions"]["cajero"]["cashcut"], true);
        assert_eq!(batch["role_permissions"]["cajero"]["products"], false);
        assert_eq!(batch["role_permissions"]["encargado"]["products"], true);
    }

    #[test]
    fn borrar_viaja_como_borrado_con_sus_ultimos_datos() {
        let (conn, _s, _t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        clear_outbox(&conn);
        delete_item(&conn, "products", "BEB-0001").unwrap();
        let (batch, _) = build_push_batch(&conn, PUSH_BATCH);
        let p = &batch["products"][0];
        assert_eq!(p["deleted"], true);
        assert_eq!(p["name"], "Agua");
        assert_eq!(p["barcode"], "111");
    }

    #[test]
    fn la_carga_inicial_no_cambia_productos_ni_stock() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        put(&conn, "BEB-0002", "", "Granel", 9.0, 7.0);
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":12.0}}), &t, &conn, &mut s).unwrap();
        clear_outbox(&conn);
        let before = snapshot(&conn);
        outbox_enqueue_all(&conn).unwrap();
        outbox_enqueue_all(&conn).unwrap();
        assert_eq!(before, snapshot(&conn), "la carga inicial solo lee");
        let has_perms = before.iter().any(|(st, _, _)| st == "role_permissions");
        let expected = before.iter().filter(|(st, _, _)| SYNC_STORES.contains(&st.as_str())).count() + if has_perms { 0 } else { 1 };
        assert_eq!(outbox_keys(&conn).len(), expected);
        // y armar los envios tampoco cambia nada
        let _ = build_push_batch(&conn, PUSH_BATCH);
        assert_eq!(before, snapshot(&conn));
    }

    // Prueba REAL contra Supabase con un negocio de prueba. Solo a mano:
    // `cargo test nube_de_punta_a_punta -- --ignored --nocapture`. Despues hay que borrar el negocio de prueba.
    #[test]
    #[ignore]
    fn nube_de_punta_a_punta() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        dispatch("open_cash_register", &json!({"openingAmount":50}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"SALE-E2E-1","items":[{"sku":"BEB-0001","qty":2}],"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).unwrap();
        dispatch("cash_cut", &json!({"type":"x"}), &t, &conn, &mut s).unwrap();
        let key = format!("TP-PRUEBA-{}", now_millis());
        let reg = rpc_call("pos_register_device", &json!({"p_license_key": key, "p_device_name": cloud_device_name(""), "p_app_version": "0.2.12-prueba", "p_business_name": "PRUEBA AUTOMATICA"})).unwrap();
        println!("negocio de prueba: {}  registro: status={}", key, reg["status"]);
        assert_eq!(reg["status"], "aprobado");
        let token = reg["token"].as_str().unwrap().to_string();
        let hb = rpc_call("pos_heartbeat", &json!({"p_token": token, "p_info": {"app_version":"0.2.12-prueba","device_name":"Tienda Prueba","cash_open":true}})).unwrap();
        assert_eq!(hb["status"], "aprobado");
        outbox_enqueue_all(&conn).unwrap();
        let (batch, keys) = build_push_batch(&conn, PUSH_BATCH);
        let r = rpc_call("pos_push", &json!({"p_token": token, "p_batch": batch})).unwrap();
        println!("push: {}", r);
        assert_eq!(r["applied"]["sales"], 1);
        assert_eq!(r["applied"]["products"], 1);
        assert_eq!(r["applied"]["cash_cuts"], 2);
        ack_push_batch(&conn, &keys);
        assert_eq!(outbox_count(&conn), 0);
        assert!(rpc_call("pos_push", &json!({"p_token": "f".repeat(64), "p_batch": {}})).is_err());
    }

    // Servidor local que permite a la prueba de pantalla (tests/ui-smoke.mjs) usar la
    // logica REAL del programa. Solo se arranca a mano: `cargo test ui_bridge -- --ignored`.
    #[test]
    #[ignore]
    fn ui_bridge() {
        let port = std::env::var("TEST_BRIDGE_PORT").unwrap_or_else(|_| "8765".into());
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).unwrap();
        let (mut conn, mut sessions, _t) = fresh();
        for stream in listener.incoming() {
            let mut stream = match stream { Ok(s) => s, Err(_) => continue };
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, content_len) = loop {
                let n = match stream.read(&mut chunk) { Ok(n) => n, Err(_) => 0 };
                if n == 0 { break (0, 0); }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                    let cl = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    break (pos + 4, cl);
                }
            };
            if header_end == 0 { continue; }
            while buf.len() < header_end + content_len {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 { break; }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body: Value = serde_json::from_slice(&buf[header_end..]).unwrap_or(json!({}));
            let op = body["op"].as_str().unwrap_or("").to_string();
            let token = body["sessionToken"].as_str().unwrap_or("").to_string();
            let payload = body.get("payload").cloned().unwrap_or(json!({}));
            let out: Value = match op.as_str() {
                "__test_reset" => {
                    let (c, s, _) = fresh();
                    conn = c; sessions = s;
                    json!({"ok": true})
                }
                "__test_put_product" => {
                    let sku = clean_text(payload.get("sku"));
                    create_item(&conn, "products", &sku, &payload).unwrap();
                    json!({"ok": true})
                }
                "__test_get_product" => {
                    let sku = clean_text(payload.get("sku"));
                    get_item(&conn, "products", &sku).unwrap_or(json!(null))
                }
                _ => match dispatch(&op, &payload, &token, &conn, &mut sessions) {
                    Ok(v) => v,
                    Err(msg) => json!({"ok": false, "error": msg}),
                },
            };
            let text = out.to_string();
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", text.len(), text);
            let _ = stream.write_all(resp.as_bytes());
        }
    }
}
