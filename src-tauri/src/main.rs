#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "256"]

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
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

// Contador que nunca se repite mientras la app esta abierta. Se usa en los ids de
// movimientos: con solo los milisegundos, dos movimientos del mismo producto en el
// mismo milisegundo tenian el mismo id y el segundo borraba al primero del historial.
fn next_seq() -> u64 {
    COUNTER.fetch_add(1, Ordering::SeqCst)
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

// Registros con "timestamp" dentro de [from, to). Filtra en SQLite para no cargar
// todo el historial (con meses de ventas, cargarlo todo hacia lenta la caja).
// from/to vacios = sin limite por ese lado.
fn list_items_between(conn: &Connection, store: &str, from: &str, to: &str) -> Vec<Value> {
    // Se arma solo con los limites que vengan, para que SQLite use idx_store_data_fecha.
    let mut sql = String::from("SELECT data FROM store_data WHERE store = ?1");
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&store];
    if !from.is_empty() { sql.push_str(" AND json_extract(data, '$.timestamp') >= ?2"); args.push(&from); }
    if !to.is_empty() { sql.push_str(if from.is_empty() { " AND json_extract(data, '$.timestamp') < ?2" } else { " AND json_extract(data, '$.timestamp') < ?3" }); args.push(&to); }
    let mut stmt = match conn.prepare(&sql) { Ok(s) => s, Err(_) => return vec![] };
    let rows = match stmt.query_map(args.as_slice(), |row| row.get::<_, String>(0)) { Ok(r) => r, Err(_) => return vec![] };
    rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str::<Value>(&s).ok()).collect()
}

// Varias escrituras como una sola: o quedan todas o ninguna (por ejemplo, si se va
// la luz a mitad de una venta no queda inventario descontado sin su venta).
// SAVEPOINT se puede anidar, asi que funciona aunque ya haya una transaccion abierta.
fn all_or_nothing<F: FnOnce() -> Result<(), String>>(conn: &Connection, f: F) -> Result<(), String> {
    conn.execute_batch("SAVEPOINT todo_o_nada").map_err(|e| e.to_string())?;
    match f() {
        Ok(()) => conn.execute_batch("RELEASE todo_o_nada").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO todo_o_nada; RELEASE todo_o_nada");
            Err(e)
        }
    }
}

// Codigo de barras normalizado para comparar: sin espacios ni simbolos y sin ceros a
// la izquierda ("0750 100-0" y "7501000" son el mismo codigo).
fn norm_code(code: &str) -> String {
    let t: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    t.trim_start_matches('0').to_string()
}

fn get_item(conn: &Connection, store: &str, id: &str) -> Option<Value> {
    let raw: Result<String, _> = conn.query_row(
        "SELECT data FROM store_data WHERE store = ?1 AND id = ?2",
        params![store, id],
        |row| row.get(0),
    );
    raw.ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn create_item(conn: &Connection, store: &str, id: &str, record: &Value) -> Result<(), String> {
    conn.execute(
        "INSERT INTO store_data (store, id, data) VALUES (?1, ?2, ?3)
         ON CONFLICT(store, id) DO UPDATE SET data = excluded.data",
        params![store, id, record.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    conn.execute(
        "DELETE FROM store_data WHERE store = ?1 AND id = ?2",
        params![store, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- configuracion (settings) ----------

fn normalize_settings(source: &Value) -> Value {
    let mut out = normalize_base_settings(source);
    add_print_settings(source, &mut out);
    out
}

fn normalize_base_settings(source: &Value) -> Value {
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

// v0.2.13: impresión unificada para los 3 tickets (venta, Corte X y Corte Z).
// Si la tienda nunca guardó estas opciones, se derivan de las que ya tenía
// (58 mm -> 57 mm, compacto, casillas, títulos y pies): nada se pierde.
fn add_print_settings(source: &Value, out: &mut Value) {
    let g = |k: &str| source.get(k);
    let flag = |k: &str, default: bool| match g(k) { Some(Value::Bool(b)) => *b, _ => default };
    let text = |k: &str, default: String| { let t = clean_text(g(k)); if t.is_empty() { default } else { t.chars().take(300).collect() } };
    let paper = { let v = clean_text(g("printPaperWidth")); if v == "57" || v == "80" { v } else if clean_text(g("ticketPaperWidth")) == "58" { "57".to_string() } else { "80".to_string() } };
    out["printPaperWidth"] = json!(paper);
    out["printCompact"] = json!(flag("printCompact", truthy_opt(g("ticketCompactMode"))));
    let ff = clean_text(g("printFontFamily"));
    out["printFontFamily"] = if ["Arial", "Courier New", "Tahoma", "Verdana"].contains(&ff.as_str()) { json!(ff) } else { out["ticketFontFamily"].clone() };
    out["printFontSize"] = if g("printFontSize").is_some() { json!(clamp(num_of(g("printFontSize")), 8.0, 18.0)) } else { out["ticketFontSize"].clone() };
    let ls = clean_text(g("printLineSpacing"));
    out["printLineSpacing"] = if ["tight", "normal", "wide"].contains(&ls.as_str()) { json!(ls) } else { out["ticketLineSpacing"].clone() };
    out["printBold"] = json!(flag("printBold", truthy_opt(g("ticketBold"))));
    let compact = truthy_opt(g("ticketCompactMode"));
    let sale_defaults = [
        ("ShowLogo", truthy_opt(g("ticketShowLogo"))), ("ShowStore", not_false(g("ticketShowStore"))),
        ("ShowTitle", !compact), ("ShowDate", not_false(g("ticketShowDate"))),
        ("ShowCashier", not_false(g("ticketShowCashier"))), ("ShowPayments", not_false(g("ticketShowPayment"))),
        ("ShowProducts", true), ("ShowBarcode", not_false(g("ticketShowSku"))),
        ("ShowIva", not_false(g("ticketShowIva"))), ("ShowFooter", true),
    ];
    let cut_defaults = [
        ("ShowLogo", truthy_opt(g("cashCutShowLogo"))), ("ShowStore", true), ("ShowTitle", true), ("ShowDate", true),
        ("ShowCashier", true), ("ShowPayments", not_false(g("cashCutShowPayments"))),
        ("ShowProducts", not_false(g("cashCutShowProducts"))), ("ShowBarcode", not_false(g("cashCutShowBarcode"))),
        ("ShowIva", false), ("ShowFooter", true),
    ];
    for (k, d) in sale_defaults.iter() { let key = format!("sale{}", k); out[key.as_str()] = json!(flag(&key, *d)); }
    for doc in ["cutX", "cutZ"] {
        for (k, d) in cut_defaults.iter() { let key = format!("{}{}", doc, k); out[key.as_str()] = json!(flag(&key, *d)); }
    }
    let cut_title = clean_text(out.get("cashCutTitle"));
    let cut_footer = clean_text(out.get("cashCutFooter"));
    out["saleTitle"] = json!(text("saleTitle", clean_text(out.get("ticketTitle"))));
    out["saleFooter"] = json!(text("saleFooter", clean_text(out.get("ticketFooter"))));
    out["cutXTitle"] = json!(text("cutXTitle", format!("{} · Corte X", cut_title)));
    out["cutZTitle"] = json!(text("cutZTitle", format!("{} · Corte Z", cut_title)));
    out["cutXFooter"] = json!(text("cutXFooter", cut_footer.clone()));
    out["cutZFooter"] = json!(text("cutZFooter", cut_footer));
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
    // Al abrir solo se cargan los ultimos 45 dias (o desde que se abrio la caja, si el
    // turno es mas largo). NADA se borra: lo anterior se consulta con op_history.
    let cash_state = get_item(conn, "cash_state", "current").unwrap_or_else(|| json!({"periodStart": "", "openingAmount": 0.0, "isOpen": false}));
    let mut since = (Utc::now() - chrono::Duration::days(HISTORY_DAYS_LOADED)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let period_start = clean_text(cash_state.get("periodStart"));
    if !period_start.is_empty() && period_start < since { since = period_start; }
    let products = list_items(conn, "products");
    let moves = if sees_ops { list_items_between(conn, "moves", &since, "") } else { vec![] };
    let counts = if sees_ops { list_items_between(conn, "counts", &since, "") } else { vec![] };
    let sales = list_items_between(conn, "sales", &since, "");
    let settings = read_settings(conn);
    let categories = list_items(conn, "categories");
    let units = list_items(conn, "units");
    let suppliers = list_items(conn, "suppliers");
    let presentations = list_items(conn, "presentations");
    let users: Vec<Value> = if admin { list_items(conn, "users").iter().map(public_user).collect() } else { vec![] };
    let cash_cuts = list_items_between(conn, "cash_cuts", &since, "");
    // mermas del mes (hora local de la PC), sin cargar todos los movimientos del mes
    let month_start = {
        use chrono::Datelike;
        let now = chrono::Local::now();
        chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
            .map(|dt| dt.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_default()
    };
    let waste_month: f64 = if sees_ops {
        list_items_between(conn, "moves", &month_start, "").iter()
            .filter(|m| clean_text(m.get("type")) == "merma")
            .map(|m| num_of(m.get("totalCost")).abs()).sum()
    } else { 0.0 };
    Ok(json!({
        "ok": true, "user": public_user(&user), "products": products, "moves": moves,
        "counts": counts, "sales": sales, "users": users, "settings": settings,
        "categories": categories, "units": units, "suppliers": suppliers, "presentations": presentations,
        "cashState": cash_state, "cashCuts": cash_cuts, "rolePermissions": perms,
        "historyFrom": since,
        "summary": {"wasteMonth": waste_month}
    }))
}

// Al abrir: 8 dias (resumen de hoy, grafica de 7 dias). Las tablas de historial piden
// su rango (30 dias por defecto, o cualquier fecha) solo cuando se abren.
const HISTORY_DAYS_LOADED: i64 = 8;

// Consulta del historial por fechas (todo lo guardado, sin limite de antiguedad).
// from/to: instantes ISO (la pantalla los calcula con la hora local del dia elegido).
fn op_history(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    let role = clean_text(user.get("role"));
    let manager = role == "admin" || role == "encargado";
    let perms = read_role_permissions(conn);
    let sees_ops = manager || has_permission(&perms, &role, "movements") || has_permission(&perms, &role, "counts");
    let kind = clean_text(payload.get("kind"));
    let store = match kind.as_str() {
        "sales" => "sales",
        "cash_cuts" => "cash_cuts",
        "moves" => "moves",
        "counts" => "counts",
        _ => return Err("Historial no reconocido".into()),
    };
    if (store == "moves" || store == "counts") && !sees_ops {
        return Err("No autorizado".into());
    }
    let mut rows = list_items_between(conn, store, &clean_text(payload.get("from")), &clean_text(payload.get("to")));
    rows.sort_by(|a, b| clean_text(b.get("timestamp")).cmp(&clean_text(a.get("timestamp"))));
    Ok(json!({"ok": true, "kind": kind, "rows": rows}))
}

// Diagnostico de inventario (solo lectura): codigos duplicados, existencias negativas
// o en cero, y ventas cuyo descuento no tiene su movimiento registrado.
fn op_inventory_diagnostics(conn: &Connection, sessions: &mut HashMap<String, Session>, token: &str, payload: &Value) -> Result<Value, String> {
    let user = current_user(true, conn, sessions, token)?.unwrap();
    assert_role(&user, &["admin", "encargado"])?;
    let products = list_items(conn, "products");
    let brief = |p: &Value| json!({
        "sku": clean_text(p.get("sku")), "name": clean_text(p.get("name")),
        "barcode": clean_text(p.get("barcode")), "stock": num_of(p.get("stock")),
        "active": not_false(p.get("active"))
    });
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    for p in &products {
        let code = norm_code(&clean_text(p.get("barcode")));
        if !code.is_empty() { groups.entry(code).or_default().push(brief(p)); }
    }
    let mut duplicates: Vec<Value> = groups.into_iter().filter(|(_, v)| v.len() > 1)
        .map(|(k, v)| json!({"code": k, "products": v})).collect();
    duplicates.sort_by(|a, b| clean_text(a.get("code")).cmp(&clean_text(b.get("code"))));
    let negative: Vec<Value> = products.iter().filter(|p| num_of(p.get("stock")) < 0.0).map(|p| brief(p)).collect();
    let zero: Vec<Value> = products.iter().filter(|p| num_of(p.get("stock")) == 0.0 && not_false(p.get("active"))).map(|p| brief(p)).collect();

    let from = clean_text(payload.get("from"));
    let to = clean_text(payload.get("to"));
    let sales = list_items_between(conn, "sales", &from, &to);
    let moves = list_items_between(conn, "moves", &from, "");
    let mut has_move: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for m in &moves {
        if clean_text(m.get("type")) == "venta" {
            has_move.insert((clean_text(m.get("reference")), clean_text(m.get("sku"))));
        }
    }
    let mut missing: Vec<Value> = vec![];
    for sale in &sales {
        let sid = clean_text(sale.get("id"));
        let lines: Vec<Value> = serde_json::from_str(&clean_text(sale.get("itemsJson"))).unwrap_or_default();
        for line in &lines {
            let sku = clean_text(line.get("sku"));
            if !sku.is_empty() && !has_move.contains(&(sid.clone(), sku.clone())) {
                missing.push(json!({
                    "saleId": sid, "timestamp": clean_text(sale.get("timestamp")), "sku": sku,
                    "name": clean_text(line.get("name")), "qty": num_of(line.get("qty")),
                    "cancelled": truthy_opt(sale.get("cancelled"))
                }));
            }
        }
    }
    Ok(json!({
        "ok": true, "duplicates": duplicates, "negative": negative, "zero": zero,
        "missingMoves": missing, "checkedSales": sales.len(), "from": from, "to": to
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
    let sales = list_items_between(conn, "sales", &period_start, "");
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
        let wanted = norm_code(&barcode);
        if let Some(dup) = products.iter().find(|p| clean_text(p.get("sku")) != sku && !wanted.is_empty() && norm_code(&clean_text(p.get("barcode"))) == wanted) {
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
        let mov_id = format!("MOV-{}-{}-{}", now_millis(), next_seq(), sku);
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
    // Une las lineas del mismo producto: si llegaran dos, se descuentan las dos.
    let raw_items = payload.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut items: Vec<Value> = vec![];
    for line in &raw_items {
        let sku = clean_text(line.get("sku"));
        let qty = num_of(line.get("qty"));
        if sku.is_empty() || qty <= 0.0 { return Err("Cantidad invalida".into()); }
        if let Some(prev) = items.iter_mut().find(|l| clean_text(l.get("sku")) == sku) {
            let total_qty = num_of(prev.get("qty")) + qty;
            prev["qty"] = json!(total_qty);
        } else {
            items.push(line.clone());
        }
    }
    if items.is_empty() { return Err("Ticket vacio".into()); }
    let requested_id = { let a = clean_text(payload.get("clientId")); if !a.is_empty() { a } else { clean_text(payload.get("id")) } };
    let id = if !requested_id.is_empty() { requested_id } else { format!("SALE-{}-{}", now_millis(), next_seq()) };
    // reintento con el mismo folio: no se vuelve a descontar
    if let Some(existing) = get_item(conn, "sales", &id) {
        return Ok(json!({"ok": true, "sale": existing, "duplicate": true}));
    }
    let timestamp = now_iso();
    let mut subtotal = 0.0;
    let mut profit = 0.0;
    for line in &items {
        let sku = clean_text(line.get("sku"));
        let product = get_item(conn, "products", &sku).ok_or_else(|| format!("Producto no encontrado: {}", sku))?;
        let qty = num_of(line.get("qty"));
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
    } else if (payments_sum - total).abs() > 0.01 {
        return Err(format!("El pago (${:.2}) no coincide con el total (${:.2})", payments_sum, total));
    }
    let payment_method = if payment_breakdown.len() > 1 {
        "Mixto".to_string()
    } else {
        payment_breakdown.keys().next().cloned().unwrap_or_else(|| "Efectivo".to_string())
    };
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
    let sale = json!({
        "id": id, "timestamp": timestamp, "itemsJson": items_json, "subtotal": subtotal,
        "discount": discount, "total": total, "paymentMethod": payment_method,
        "paymentBreakdown": Value::Object(payment_breakdown),
        "user": display_or_username(&user), "notes": "", "profit": profit
    });
    // Descuento: con la existencia del momento de cada producto. Si no alcanza, se
    // vende igual y queda en negativo (asi ninguna venta se escapa del inventario);
    // se avisa para corregirlo con un conteo. Todo se guarda junto o nada.
    let mut negative: Vec<Value> = vec![];
    all_or_nothing(conn, || {
        for line in &items {
            let sku = clean_text(line.get("sku"));
            let product = get_item(conn, "products", &sku).ok_or_else(|| format!("Producto no encontrado: {}", sku))?;
            let qty = num_of(line.get("qty"));
            let before = num_of(product.get("stock"));
            let after = before - qty;
            patch_item(conn, "products", &sku, &json!({"stock": after}))?;
            if after < 0.0 {
                negative.push(json!({"sku": sku, "name": clean_text(product.get("name")), "stock": after}));
            }
            let mov_id = format!("MOV-{}-{}-{}", now_millis(), next_seq(), sku);
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
        create_item(conn, "sales", &id, &sale)
    })?;
    Ok(json!({"ok": true, "sale": sale, "negativeStock": negative}))
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
    let mut restored: Vec<Value> = vec![];
    let mut skipped: Vec<String> = vec![];
    let timestamp = now_iso();
    // devolver inventario y marcar la venta cancelada: todo junto o nada
    all_or_nothing(conn, || {
        for line in &items {
            let sku = clean_text(line.get("sku"));
            let qty = num_of(line.get("qty"));
            if let Some(product) = get_item(conn, "products", &sku) {
                let before = num_of(product.get("stock"));
                let after = before + qty;
                patch_item(conn, "products", &sku, &json!({"stock": after}))?;
                let mov_id = format!("MOV-DEV-{}-{}-{}", now_millis(), next_seq(), sku);
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
        Ok(())
    })?;
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
        "history" => op_history(conn, sessions, token, payload),
        "inventory_diagnostics" => op_inventory_diagnostics(conn, sessions, token, payload),
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
    // v0.2.13: indice por fecha para leer historial por rango sin revisar todas las filas.
    // Solo se agrega; no cambia ningun dato. La expresion debe ser IGUAL a la de list_items_between.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_store_data_fecha ON store_data (store, json_extract(data, '$.timestamp'))",
        [],
    )
    .ok();
}

// ---------- panel web (Supabase) - solo lectura por ahora ----------

const SUPABASE_URL: &str = "https://qizccncdyhzxeltwzjni.supabase.co/rest/v1";
const SUPABASE_KEY: &str = "sb_publishable_yrmAdp65Ai2IzEnTQkMVeA_zT_qeLSA";

fn supabase_upsert(table: &str, rows: &[Value]) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let url = format!("{}/{}", SUPABASE_URL, table);
    let client = http_client();
    let resp = client
        .post(&url)
        .header("apikey", SUPABASE_KEY)
        .header("Content-Type", "application/json")
        .header("Prefer", "resolution=merge-duplicates,return=minimal")
        .json(&Value::Array(rows.to_vec()))
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Supabase respondio {}: {}", status, text));
    }
    Ok(())
}

#[tauri::command]
fn sync_to_cloud(app: tauri::AppHandle, db: tauri::State<DbConn>) -> Value {
    // Todo lo que necesita la base de datos local se lee aqui adentro, en un
    // bloque separado: al terminar el bloque el candado (MutexGuard) se suelta
    // solo. Asi las llamadas de red que siguen (que pueden tardar varios
    // segundos si el internet esta lento) NO bloquean el resto de la app
    // (por ejemplo, que alguien pueda cobrar una venta al mismo tiempo).
    let (
        license_key,
        business_name,
        app_version,
        last_sales_ts,
        last_cuts_ts,
        products,
        sales,
        cuts,
    ) = {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(_) => return json!({"ok": false, "error": "Error de base de datos local"}),
        };
        let license_key = get_or_create_license_key(&conn);
        let settings = read_settings(&conn);
        let business_name = clean_text(settings.get("storeTitle"));
        let app_version = app.package_info().version.to_string();
        let sync_state = get_item(&conn, "cloud_sync", "state").unwrap_or_else(|| json!({}));
        let last_sales_ts = clean_text(sync_state.get("lastSalesTs"));
        let last_cuts_ts = clean_text(sync_state.get("lastCutsTs"));
        let products = list_items(&conn, "products");
        let sales = list_items(&conn, "sales");
        let cuts = list_items(&conn, "cash_cuts");
        (license_key, business_name, app_version, last_sales_ts, last_cuts_ts, products, sales, cuts)
        // <- aqui se suelta el candado, antes de tocar la red
    };
    let product_rows: Vec<Value> = products
        .iter()
        .map(|p| {
            json!({
                "license_key": license_key,
                "sku": clean_text(p.get("sku")),
                "name": clean_text(p.get("name")),
                "category": clean_text(p.get("category")),
                "presentation": clean_text(p.get("presentation")),
                "supplier": clean_text(p.get("supplier")),
                "unit": clean_text(p.get("unit")),
                "cost": num_of(p.get("cost")),
                "price": num_of(p.get("price")),
                "stock": num_of(p.get("stock")),
                "min_stock": num_of(p.get("minStock")),
                "active": not_false(p.get("active")),
                "updated_at": now_iso()
            })
        })
        .collect();

    let new_sales: Vec<&Value> = sales
        .iter()
        .filter(|s| last_sales_ts.is_empty() || clean_text(s.get("timestamp")) > last_sales_ts)
        .collect();
    let mut max_sales_ts = last_sales_ts.clone();
    let sale_rows: Vec<Value> = new_sales
        .iter()
        .map(|s| {
            let ts = clean_text(s.get("timestamp"));
            if ts > max_sales_ts {
                max_sales_ts = ts.clone();
            }
            json!({
                "license_key": license_key,
                "id": clean_text(s.get("id")),
                "ts": ts,
                "total": num_of(s.get("total")),
                "subtotal": num_of(s.get("subtotal")),
                "payment_method": clean_text(s.get("paymentMethod")),
                "payment_breakdown": s.get("paymentBreakdown").cloned().unwrap_or_else(|| json!({})),
                "cashier": clean_text(s.get("user")),
                "profit": num_of(s.get("profit"))
            })
        })
        .collect();

    let new_cuts: Vec<&Value> = cuts
        .iter()
        .filter(|c| clean_text(c.get("type")) != "apertura")
        .filter(|c| last_cuts_ts.is_empty() || clean_text(c.get("timestamp")) > last_cuts_ts)
        .collect();
    let mut max_cuts_ts = last_cuts_ts.clone();
    let cut_rows: Vec<Value> = new_cuts
        .iter()
        .map(|c| {
            let ts = clean_text(c.get("timestamp"));
            if ts > max_cuts_ts {
                max_cuts_ts = ts.clone();
            }
            let period_start = clean_text(c.get("periodStart"));
            json!({
                "license_key": license_key,
                "id": clean_text(c.get("id")),
                "cut_type": clean_text(c.get("type")),
                "ts": ts,
                "period_start": if period_start.is_empty() { Value::Null } else { json!(period_start) },
                "period_end": clean_text(c.get("periodEnd")),
                "total": num_of(c.get("total")),
                "opening_amount": num_of(c.get("openingAmount")),
                "cashier": clean_text(c.get("user"))
            })
        })
        .collect();

    let meta_row = json!({
        "license_key": license_key,
        "business_name": business_name,
        "app_version": app_version,
        "last_sync": now_iso()
    });

    let mut errors: Vec<String> = vec![];
    if let Err(e) = supabase_upsert("pos_meta", &[meta_row]) {
        errors.push(e);
    }
    if let Err(e) = supabase_upsert("pos_products", &product_rows) {
        errors.push(e);
    }
    let sales_ok = match supabase_upsert("pos_sales", &sale_rows) {
        Ok(_) => true,
        Err(e) => { errors.push(e); false }
    };
    let cuts_ok = match supabase_upsert("pos_cash_cuts", &cut_rows) {
        Ok(_) => true,
        Err(e) => { errors.push(e); false }
    };
    // Cada marca de avance (lastSalesTs / lastCutsTs) solo se mueve si ESA subida
    // en particular tuvo exito; si una de las dos falla, no se debe perder el
    // progreso de la otra ni marcar como sincronizado lo que en realidad fallo.
    if sales_ok || cuts_ok {
        let final_sales_ts = if sales_ok { max_sales_ts.clone() } else { last_sales_ts.clone() };
        let final_cuts_ts = if cuts_ok { max_cuts_ts.clone() } else { last_cuts_ts.clone() };
        // Se vuelve a tomar el candado solo un instante, ya con la red resuelta,
        // nada mas para guardar hasta donde se avanzo.
        if let Ok(conn) = db.0.lock() {
            create_item(&conn, "cloud_sync", "state", &json!({"lastSalesTs": final_sales_ts, "lastCutsTs": final_cuts_ts})).ok();
        }
    }

    if errors.is_empty() {
        json!({"ok": true, "productsSynced": product_rows.len(), "salesSynced": sale_rows.len(), "cutsSynced": cut_rows.len()})
    } else {
        json!({"ok": false, "error": errors.join(" | ")})
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
        // v0.2.13: las opciones viejas pasan a la impresion unificada sin perderse
        assert_eq!(n["printPaperWidth"], "57");
        assert_eq!(n["printCompact"], true);
        assert_eq!(n["printLineSpacing"], "tight");
        assert_eq!(n["saleShowTitle"], false, "en modo compacto el ticket no llevaba titulo");
        assert_eq!(n["cutXShowBarcode"], false);
        assert_eq!(n["cutZShowProducts"], true);
        assert_eq!(n["saleTitle"], "Ticket de venta");
        assert_eq!(n["cutZTitle"], "Corte de caja · Corte Z");
        // y lo que se guarda desde la pestaña nueva se respeta
        let m = normalize_settings(&json!({"printPaperWidth":"80","printCompact":false,"saleShowIva":false,"cutXShowIva":true,"cutZFooter":"Firma del encargado","printFontSize":9}));
        assert_eq!(m["printPaperWidth"], "80");
        assert_eq!(m["printCompact"], false);
        assert_eq!(m["saleShowIva"], false);
        assert_eq!(m["cutXShowIva"], true);
        assert_eq!(m["cutZFooter"], "Firma del encargado");
        assert_eq!(m["printFontSize"], 9.0);
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

    fn snapshot(conn: &Connection) -> Vec<(String, String, String)> {
        let mut stmt = conn.prepare("SELECT store, id, data FROM store_data ORDER BY store, id").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    // ---------- rutina de diagnostico: partes sensibles (ver .claude/skills/diagnostico-antes-de-publicar) ----------

    fn login_as(conn: &Connection, s: &mut HashMap<String, Session>, username: &str, password: &str) -> String {
        let r = dispatch("login", &json!({"username": username, "password": password}), "", conn, s).unwrap();
        assert_eq!(r["ok"], true, "no pudo entrar {}: {}", username, r);
        r["sessionToken"].as_str().unwrap().to_string()
    }

    #[test]
    fn cortes_x_y_z_completos() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        let items = json!([{"sku":"BEB-0001","qty":2}]);
        // con la caja cerrada no se cobra
        assert!(dispatch("checkout", &json!({"clientId":"S0","items":items,"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).is_err());
        dispatch("open_cash_register", &json!({"openingAmount":100}), &t, &conn, &mut s).unwrap();
        // no se puede abrir dos veces
        assert!(dispatch("open_cash_register", &json!({"openingAmount":50}), &t, &conn, &mut s).is_err());
        dispatch("checkout", &json!({"clientId":"S1","items":items,"payments":{"Efectivo":24.0}}), &t, &conn, &mut s).unwrap();
        // pago mixto
        dispatch("checkout", &json!({"clientId":"S2","items":items,"payments":{"Efectivo":10.0,"Tarjeta":14.0}}), &t, &conn, &mut s).unwrap();
        // una venta cancelada no cuenta en el corte
        dispatch("checkout", &json!({"clientId":"S3","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":12.0}}), &t, &conn, &mut s).unwrap();
        dispatch("cancel_sale", &json!({"id":"S3"}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 6.0);

        let x = dispatch("cash_cut", &json!({"type":"x"}), &t, &conn, &mut s).unwrap();
        assert_eq!(x["cut"]["total"], 48.0);
        assert_eq!(x["cut"]["salesCount"], 2);
        assert_eq!(x["cut"]["payments"]["Efectivo"], 34.0);
        assert_eq!(x["cut"]["payments"]["Tarjeta"], 14.0);
        assert_eq!(x["cut"]["openingAmount"], 100.0);
        // el X no cierra la caja: se sigue cobrando
        dispatch("checkout", &json!({"clientId":"S4","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":12.0}}), &t, &conn, &mut s).unwrap();

        // el Z se niega con tickets en espera o con productos sin cobrar
        let held = dispatch("cash_cut", &json!({"type":"z","pendingHeldTickets":1}), &t, &conn, &mut s);
        assert!(held.unwrap_err().contains("en espera"));
        assert!(dispatch("cash_cut", &json!({"type":"z","pendingCartItems":2}), &t, &conn, &mut s).is_err());
        let z = dispatch("cash_cut", &json!({"type":"z"}), &t, &conn, &mut s).unwrap();
        assert_eq!(z["cut"]["total"], 60.0);
        assert_eq!(z["cut"]["salesCount"], 3);
        // despues del Z la caja queda cerrada y no se cobra
        assert!(dispatch("checkout", &json!({"clientId":"S5","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":12.0}}), &t, &conn, &mut s).is_err());
        assert!(dispatch("cash_cut", &json!({"type":"x"}), &t, &conn, &mut s).is_err());
        // y se puede abrir un turno nuevo, que empieza en cero (en la tienda pasan
        // segundos entre el Z y la apertura; aqui se espera un poco para no "empatar" el milisegundo)
        std::thread::sleep(std::time::Duration::from_millis(5));
        dispatch("open_cash_register", &json!({"openingAmount":80}), &t, &conn, &mut s).unwrap();
        let x2 = dispatch("cash_cut", &json!({"type":"x"}), &t, &conn, &mut s).unwrap();
        assert_eq!(x2["cut"]["total"], 0.0);
        assert_eq!(x2["cut"]["salesCount"], 0);
        assert_eq!(stock_of(&conn, "BEB-0001"), 5.0);
    }

    // ---------- metodo de descuento (prioridad del dueño) ----------

    #[test]
    fn el_cobro_descuenta_exacto_aunque_lleguen_lineas_repetidas_o_sin_existencia() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 10.0, 10.0);
        put(&conn, "BOT-0001", "222", "Papas", 20.0, 1.0);
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        // dos lineas del mismo producto: se descuentan las dos (antes solo una)
        let r = dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0001","qty":1},{"sku":"BEB-0001","qty":2}],"payments":{"Efectivo":30.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 7.0);
        assert_eq!(r["sale"]["total"], 30.0);
        let moves: Vec<Value> = list_items(&conn, "moves").into_iter().filter(|m| clean_text(m.get("reference")) == "S1").collect();
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0]["quantity"], -3.0);
        // sin existencia suficiente: se vende igual, queda en negativo y se avisa
        let r2 = dispatch("checkout", &json!({"clientId":"S2","items":[{"sku":"BOT-0001","qty":3}],"payments":{"Efectivo":60.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BOT-0001"), -2.0);
        assert_eq!(r2["negativeStock"][0]["sku"], "BOT-0001");
        // un pago que no cuadra no toca nada
        assert!(dispatch("checkout", &json!({"clientId":"S3","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":1.0}}), &t, &conn, &mut s).is_err());
        assert_eq!(stock_of(&conn, "BEB-0001"), 7.0);
        assert!(get_item(&conn, "sales", "S3").is_none());
        // un producto que no existe no deja nada a medias
        assert!(dispatch("checkout", &json!({"clientId":"S4","items":[{"sku":"BEB-0001","qty":1},{"sku":"NO-EXISTE","qty":1}],"payments":{"Efectivo":10.0}}), &t, &conn, &mut s).is_err());
        assert_eq!(stock_of(&conn, "BEB-0001"), 7.0);
        assert!(get_item(&conn, "sales", "S4").is_none());
        // cancelar devuelve exacto
        dispatch("cancel_sale", &json!({"id":"S1"}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
    }

    #[test]
    fn al_abrir_carga_pocos_dias_y_el_historial_encuentra_lo_anterior() {
        let (conn, mut s, t) = fresh();
        let old = (Utc::now() - chrono::Duration::days(60)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let recent = (Utc::now() - chrono::Duration::days(3)).to_rfc3339_opts(SecondsFormat::Millis, true);
        for (id, ts) in [("S-VIEJA", &old), ("S-RECIENTE", &recent)] {
            create_item(&conn, "sales", id, &json!({"id": id, "timestamp": ts, "itemsJson": "[]", "total": 5, "paymentMethod": "Efectivo"})).unwrap();
            create_item(&conn, "moves", &format!("M-{}", id), &json!({"id": format!("M-{}", id), "timestamp": ts, "type": "entrada_compra", "sku": "X", "quantity": 1})).unwrap();
        }
        let d = dispatch("data", &json!({}), &t, &conn, &mut s).unwrap();
        let ids: Vec<String> = d["sales"].as_array().unwrap().iter().map(|x| clean_text(x.get("id"))).collect();
        assert_eq!(ids, vec!["S-RECIENTE".to_string()]);
        assert_eq!(d["moves"].as_array().unwrap().len(), 1);
        // nada se borro: el historial por fechas encuentra la venta de hace 60 dias
        let from = (Utc::now() - chrono::Duration::days(90)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let h = dispatch("history", &json!({"kind":"sales","from":from,"to":""}), &t, &conn, &mut s).unwrap();
        assert_eq!(h["rows"].as_array().unwrap().len(), 2);
        assert_eq!(h["rows"][0]["id"], "S-RECIENTE");
        let hm = dispatch("history", &json!({"kind":"moves","from":from,"to":recent}), &t, &conn, &mut s).unwrap();
        assert_eq!(hm["rows"].as_array().unwrap().len(), 1);
        assert!(get_item(&conn, "sales", "S-VIEJA").is_some());
    }

    #[test]
    fn el_diagnostico_encuentra_duplicados_negativos_y_ventas_sin_descuento() {
        let (conn, mut s, t) = fresh();
        put(&conn, "A", "0750100", "Galleta A", 10.0, 3.0);
        put(&conn, "B", "750100", "Galleta B", 10.0, -2.0);
        put(&conn, "C", "333", "Jugo", 10.0, 5.0);
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S-BIEN","items":[{"sku":"C","qty":1}],"payments":{"Efectivo":10.0}}), &t, &conn, &mut s).unwrap();
        // una venta guardada sin su movimiento (como las que "no se descontaron")
        create_item(&conn, "sales", "S-MAL", &json!({"id":"S-MAL","timestamp":now_iso(),"itemsJson":"[{\"sku\":\"C\",\"qty\":2,\"name\":\"Jugo\"}]","total":20})).unwrap();
        let before = snapshot(&conn);
        let d = dispatch("inventory_diagnostics", &json!({}), &t, &conn, &mut s).unwrap();
        assert_eq!(d["duplicates"].as_array().unwrap().len(), 1, "0750100 y 750100 son el mismo codigo");
        assert_eq!(d["negative"][0]["sku"], "B");
        let missing = d["missingMoves"].as_array().unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0]["saleId"], "S-MAL");
        // el diagnostico no corrige nada solo
        assert_eq!(before, snapshot(&conn));
        // y un alta con un codigo que solo difiere en ceros se rechaza
        assert!(dispatch("save_product", &json!({"mode":"new","record":{"barcode":"00333","name":"Otro","category":"Bebidas","price":1,"cost":1}}), &t, &conn, &mut s).is_err());
    }

    #[test]
    fn cancelar_dos_veces_no_devuelve_inventario_doble() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        dispatch("open_cash_register", &json!({"openingAmount":0}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0001","qty":3}],"payments":{"Efectivo":36.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 7.0);
        dispatch("cancel_sale", &json!({"id":"S1"}), &t, &conn, &mut s).unwrap();
        assert!(dispatch("cancel_sale", &json!({"id":"S1"}), &t, &conn, &mut s).is_err());
        assert_eq!(stock_of(&conn, "BEB-0001"), 10.0);
    }

    #[test]
    fn un_cajero_cobra_y_corta_pero_no_edita_productos_ni_inventario() {
        let (conn, mut s, t) = fresh();
        put(&conn, "BEB-0001", "111", "Agua", 12.0, 10.0);
        dispatch("save_user", &json!({"username":"2001","password":"5678","displayName":"Ana","role":"cajero"}), &t, &conn, &mut s).unwrap();
        let c = login_as(&conn, &mut s, "2001", "5678");
        dispatch("open_cash_register", &json!({"openingAmount":100}), &c, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S1","items":[{"sku":"BEB-0001","qty":1}],"payments":{"Efectivo":12.0}}), &c, &conn, &mut s).unwrap();
        dispatch("cash_cut", &json!({"type":"x"}), &c, &conn, &mut s).unwrap();
        assert!(dispatch("save_product", &json!({"mode":"new","record":{"barcode":"222","name":"X","category":"Bebidas","price":1,"cost":1}}), &c, &conn, &mut s).is_err());
        assert!(dispatch("save_product", &json!({"mode":"edit","editingSku":"BEB-0001","record":{"barcode":"111","name":"Agua","category":"Bebidas","price":1,"cost":1}}), &c, &conn, &mut s).is_err());
        assert!(dispatch("movement", &json!({"sku":"BEB-0001","type":"entrada_compra","quantity":50}), &c, &conn, &mut s).is_err());
        assert!(dispatch("count", &json!({"sku":"BEB-0001","countedStock":99}), &c, &conn, &mut s).is_err());
        assert_eq!(get_item(&conn, "products", "BEB-0001").unwrap()["price"], 12.0);
        assert_eq!(stock_of(&conn, "BEB-0001"), 9.0);
        dispatch("cash_cut", &json!({"type":"z"}), &c, &conn, &mut s).unwrap();
    }

    // Base de datos "como la dejo" una version vieja: solo la tabla store_data, sin outbox.
    fn old_db(rows: &[(&str, &str, Value)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE store_data (store TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (store, id))", []).unwrap();
        for (store, id, data) in rows {
            conn.execute("INSERT INTO store_data (store, id, data) VALUES (?1, ?2, ?3)", params![store, id, data.to_string()]).unwrap();
        }
        conn
    }
    fn old_user(username: &str, password: &str, role: &str) -> Value {
        let salt = format!("salvieja{}", username);
        json!({"username":username,"displayName":format!("Usuario {}", username),"passwordHash":hash_password(password, &salt),"salt":salt,"role":role,"pin":"","active":true,"createdAt":"2026-01-01T00:00:00.000Z","lastLogin":""})
    }
    fn old_product(sku: &str, barcode: &str, name: &str, category: &str, price: f64, stock: f64) -> Value {
        let (ci, cw) = iva_parts(price / 2.0);
        let (pi, pw) = iva_parts(price);
        json!({"sku":sku,"barcode":barcode,"name":name,"category":category,"presentation":"Pieza","supplier":"","unit":"pieza","cost":price/2.0,"price":price,"costIva":ci,"priceIva":pi,"costWithoutIva":cw,"priceWithoutIva":pw,"stock":stock,"minStock":2,"description":"","active":true})
    }
    // Productos que no se vendieron ni se tocaron deben quedar exactamente igual.
    fn untouched(before: &[(String, String, String)], conn: &Connection, skus: &[&str]) {
        for sku in skus {
            let old = before.iter().find(|(st, id, _)| st == "products" && id == sku).map(|(_, _, d)| d.clone()).unwrap();
            let now = get_item(conn, "products", sku).unwrap().to_string();
            let old_v: Value = serde_json::from_str(&old).unwrap();
            assert_eq!(old_v.to_string(), now, "el producto {} cambio", sku);
        }
    }

    #[test]
    fn la_version_nueva_abre_una_base_de_la_v0_1_2_sin_perder_nada() {
        // v0.1.2: sin caja (ni apertura ni cortes), sin permisos por rol, ventas sin desglose de pago
        let conn = old_db(&[
            ("users", "1234", old_user("1234", "1234", "admin")),
            ("products", "BEB-0001", old_product("BEB-0001", "7501", "Agua", "Bebidas", 12.0, 10.0)),
            ("products", "ABA-0001", old_product("ABA-0001", "", "Frijol granel", "Abarrotes", 9.0, 20.0)),
            ("products", "BOT-0001", old_product("BOT-0001", "7502", "Papas", "Botanas", 18.0, 5.0)),
            ("sales", "SALE-1700000000000", json!({"id":"SALE-1700000000000","timestamp":"2026-01-10T10:00:00.000Z","itemsJson":"[{\"sku\":\"BEB-0001\",\"qty\":1}]","subtotal":12,"discount":0,"total":12,"paymentMethod":"Efectivo","user":"Usuario 1234","notes":"","profit":6})),
            ("moves", "MOV-1700000000000-BEB-0001", json!({"id":"MOV-1700000000000-BEB-0001","timestamp":"2026-01-10T10:00:00.000Z","type":"venta","sku":"BEB-0001","productName":"Agua","quantity":-1,"stockBefore":11,"stockAfter":10,"unitCost":6,"totalCost":-6,"reason":"Venta POS","reference":"SALE-1700000000000","user":"Usuario 1234","notes":""})),
            ("settings", "app", json!({"key":"app","value":"{\"storeTitle\":\"Abarrotes Viejo\"}"})),
        ]);
        let before = snapshot(&conn);
        init_db(&conn);
        assert_eq!(before, snapshot(&conn), "abrir con la version nueva no debe cambiar ningun dato");

        let mut s = HashMap::new();
        let t = login_as(&conn, &mut s, "1234", "1234");
        let data = dispatch("data", &json!({}), &t, &conn, &mut s).unwrap();
        assert_eq!(data["products"].as_array().unwrap().len(), 3);
        // la venta vieja (enero) no se carga al abrir, pero sigue guardada y el historial la encuentra
        assert_eq!(data["sales"].as_array().unwrap().len(), 0);
        let h = dispatch("history", &json!({"kind":"sales","from":"2026-01-01T00:00:00.000Z","to":""}), &t, &conn, &mut s).unwrap();
        assert_eq!(h["rows"].as_array().unwrap().len(), 1);
        assert_eq!(read_settings(&conn)["storeTitle"], "Abarrotes Viejo");

        // cobrar un producto viejo y uno SIN codigo de barras
        dispatch("open_cash_register", &json!({"openingAmount":100}), &t, &conn, &mut s).unwrap();
        dispatch("checkout", &json!({"clientId":"S-NUEVA","items":[{"sku":"BEB-0001","qty":1},{"sku":"ABA-0001","qty":2}],"payments":{"Efectivo":30.0}}), &t, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 9.0);
        assert_eq!(stock_of(&conn, "ABA-0001"), 18.0);
        // dar de alta un producto nuevo
        dispatch("save_product", &json!({"mode":"new","record":{"barcode":"7503","name":"Jugo","category":"Bebidas","price":15,"cost":9,"stock":4}}), &t, &conn, &mut s).unwrap();
        assert_eq!(list_items(&conn, "products").len(), 4);
        // corte Z con la venta nueva
        let z = dispatch("cash_cut", &json!({"type":"z"}), &t, &conn, &mut s).unwrap();
        assert_eq!(z["cut"]["total"], 30.0);
        // lo que no se vendio queda identico; la venta vieja sigue ahi
        untouched(&before, &conn, &["BOT-0001"]);
        assert!(get_item(&conn, "sales", "SALE-1700000000000").is_some());
        assert_eq!(list_items(&conn, "sales").len(), 2);
    }

    #[test]
    fn la_version_nueva_abre_una_base_de_la_v0_2_7_sin_perder_nada() {
        // v0.2.7: caja abierta a medio turno, cortes viejos, codigos de barras duplicados, sin permisos por rol
        let conn = old_db(&[
            ("users", "1234", old_user("1234", "1234", "admin")),
            ("users", "2001", old_user("2001", "5678", "cajero")),
            ("products", "BEB-0001", old_product("BEB-0001", "7501", "Agua", "Bebidas", 12.0, 10.0)),
            ("products", "GAL-0001", old_product("GAL-0001", "999", "Galleta A", "Botanas", 10.0, 3.0)),
            ("products", "GAL-0002", old_product("GAL-0002", "999", "Galleta B", "Botanas", 11.0, 4.0)),
            ("cash_state", "current", json!({"periodStart":"2026-10-01T08:00:00.000Z","openingAmount":200,"isOpen":true})),
            ("cash_cuts", "CORTEZ-1759000000000-abc123", json!({"id":"CORTEZ-1759000000000-abc123","type":"z","timestamp":"2026-09-30T21:00:00.000Z","periodStart":"2026-09-30T08:00:00.000Z","periodEnd":"2026-09-30T21:00:00.000Z","openingAmount":200,"total":540,"salesCount":12,"payments":{"Efectivo":540},"user":"Usuario 1234","notes":""})),
            ("sales", "SALE-1759300000000", json!({"id":"SALE-1759300000000","timestamp":"2026-10-01T09:00:00.000Z","itemsJson":"[{\"sku\":\"BEB-0001\",\"qty\":1}]","subtotal":12,"discount":0,"total":12,"paymentMethod":"Efectivo","paymentBreakdown":{"Efectivo":12},"user":"Usuario 2001","notes":"","profit":6})),
        ]);
        let before = snapshot(&conn);
        init_db(&conn);
        assert_eq!(before, snapshot(&conn), "abrir con la version nueva no debe cambiar ningun dato");

        let mut s = HashMap::new();
        // el cajero viejo entra y sigue con el turno que ya estaba abierto
        let c = login_as(&conn, &mut s, "2001", "5678");
        dispatch("checkout", &json!({"clientId":"S-NUEVA","items":[{"sku":"BEB-0001","qty":2}],"payments":{"Efectivo":24.0}}), &c, &conn, &mut s).unwrap();
        assert_eq!(stock_of(&conn, "BEB-0001"), 8.0);
        // el Z del cajero incluye la venta vieja del turno y la nueva
        let z = dispatch("cash_cut", &json!({"type":"z"}), &c, &conn, &mut s).unwrap();
        assert_eq!(z["cut"]["total"], 36.0);
        assert_eq!(z["cut"]["openingAmount"], 200.0);
        // los duplicados siguen igual: nunca se corrigen solos
        untouched(&before, &conn, &["GAL-0001", "GAL-0002"]);
        // el admin da de alta un producto: no puede reutilizar el codigo duplicado, y lo demas no cambia
        let a = login_as(&conn, &mut s, "1234", "1234");
        assert!(dispatch("save_product", &json!({"mode":"new","record":{"barcode":"999","name":"Galleta C","category":"Botanas","price":9,"cost":5}}), &a, &conn, &mut s).is_err());
        dispatch("save_product", &json!({"mode":"new","record":{"barcode":"7504","name":"Cafe","category":"Abarrotes","price":40,"cost":25,"stock":2}}), &a, &conn, &mut s).unwrap();
        assert_eq!(list_items(&conn, "products").len(), 4);
        untouched(&before, &conn, &["GAL-0001", "GAL-0002"]);
        // el corte viejo y la venta vieja siguen ahi
        assert!(get_item(&conn, "cash_cuts", "CORTEZ-1759000000000-abc123").is_some());
        assert!(get_item(&conn, "sales", "SALE-1759300000000").is_some());
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
                // registro con cualquier forma y fecha (p. ej. una venta de hace 60 dias)
                "__test_put_item" => {
                    let store = clean_text(payload.get("store"));
                    let id = clean_text(payload.get("id"));
                    create_item(&conn, &store, &id, payload.get("data").unwrap_or(&json!({}))).unwrap();
                    json!({"ok": true})
                }
                // carga rapida de N ventas (con sus 2 movimientos) repartidas en los ultimos 60 dias,
                // para la prueba de volumen. No pasa por el cobro: solo llena el historial.
                "__test_bulk_sales" => {
                    let n = num_of(payload.get("n")) as i64;
                    conn.execute_batch("BEGIN").unwrap();
                    for i in 0..n {
                        let ts = (Utc::now() - chrono::Duration::minutes((n - i) * 60 * 24 * 60 / n.max(1))).to_rfc3339_opts(SecondsFormat::Millis, true);
                        let id = format!("BULK-{}", i);
                        let items = json!([{"sku":"GRA-0001","qty":1,"name":"Granel","price":9.0,"cost":4.5},{"sku":"GRA-0001","qty":1,"name":"Granel","price":9.0,"cost":4.5}]).to_string();
                        create_item(&conn, "sales", &id, &json!({"id":id,"timestamp":ts,"itemsJson":items,"subtotal":18.0,"discount":0,"total":18.0,"paymentMethod":"Efectivo","paymentBreakdown":{"Efectivo":18.0},"user":"Admin","notes":"","profit":9.0})).unwrap();
                        for k in 0..2 {
                            let mid = format!("MOV-BULK-{}-{}", i, k);
                            create_item(&conn, "moves", &mid, &json!({"id":mid,"timestamp":ts,"type":"venta","sku":"GRA-0001","productName":"Granel","quantity":-1,"stockBefore":0,"stockAfter":0,"unitCost":4.5,"totalCost":-4.5,"reason":"Venta POS","reference":id,"user":"Admin","notes":""})).unwrap();
                        }
                    }
                    conn.execute_batch("COMMIT").unwrap();
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
