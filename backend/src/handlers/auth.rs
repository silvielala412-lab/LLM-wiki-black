/*!
 * auth.rs — Lightweight user authentication for LLM Wiki
 *
 * Design:
 *   - Users stored in {data_root}/.auth/users.json (no database)
 *   - Passwords hashed with SHA-256 + salt stored inline
 *   - JWT issued on login, stored as HttpOnly cookie "llm_wiki_session"
 *   - JWT contains { sub: user_id, username }
 *
 * API:
 *   POST /api/auth/register  { username, password, confirm_password }
 *   POST /api/auth/login     { username, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 */

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Arc};
use tracing::{info, warn};
use uuid::Uuid;

use crate::state::AppState;

// ── Constants ─────────────────────────────────────────────────────────────────

const USERS_FILE: &str = ".auth/users.json";
const COOKIE_NAME: &str = "llm_wiki_session";
const TOKEN_EXPIRE_SECS: i64 = 7 * 24 * 3600; // 7 days

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredUser {
    pub id: String,
    pub username: String,
    pub password_hash: String, // "salt:sha256hex"
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,      // user id
    pub username: String,
    pub exp: i64,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub confirm_password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

// ── User storage helpers ──────────────────────────────────────────────────────

fn users_path(data_root: &std::path::Path) -> PathBuf {
    data_root.join(USERS_FILE)
}

fn load_users(data_root: &std::path::Path) -> Vec<StoredUser> {
    let path = users_path(data_root);
    if !path.exists() {
        return vec![];
    }
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn save_users(data_root: &std::path::Path, users: &[StoredUser]) -> anyhow::Result<()> {
    let path = users_path(data_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(users)?)?;
    Ok(())
}

fn hash_password(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{salt}:{password}"));
    let result = hasher.finalize();
    format!("{salt}:{}", hex::encode(result))
}

fn verify_password(password: &str, stored_hash: &str) -> bool {
    let parts: Vec<&str> = stored_hash.splitn(2, ':').collect();
    if parts.len() != 2 {
        return false;
    }
    let salt = parts[0];
    let expected = hash_password(password, salt);
    expected == stored_hash
}

fn jwt_secret(state: &AppState) -> String {
    // Use a stable secret: combine a fixed prefix with data_root path
    // In production you'd store this in an env var; this is sufficient for intranet use
    format!("llm-wiki-secret-{}", state.data_root.to_string_lossy())
}

fn issue_jwt(state: &AppState, user: &StoredUser) -> anyhow::Result<String> {
    let exp = chrono::Utc::now().timestamp() + TOKEN_EXPIRE_SECS;
    let claims = JwtClaims {
        sub: user.id.clone(),
        username: user.username.clone(),
        exp,
    };
    let secret = jwt_secret(state);
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_jwt(state: &AppState, token: &str) -> Option<JwtClaims> {
    let secret = jwt_secret(state);
    decode::<JwtClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .ok()
    .map(|d| d.claims)
}

fn extract_token(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix(&format!("{COOKIE_NAME}=")) {
            return Some(val.to_string());
        }
    }
    None
}

pub fn get_current_user(state: &AppState, headers: &HeaderMap) -> Option<JwtClaims> {
    let token = extract_token(headers)?;
    verify_jwt(state, &token)
}

fn set_cookie_header(token: &str) -> String {
    format!(
        "{COOKIE_NAME}={token}; HttpOnly; Path=/; Max-Age={TOKEN_EXPIRE_SECS}; SameSite=Lax"
    )
}

fn clear_cookie_header() -> String {
    format!("{COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax")
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Response {
    // Validate
    let username = req.username.trim().to_string();
    if username.len() < 3 || username.len() > 32 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Username must be 3-32 characters" }))).into_response();
    }
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Username can only contain letters, numbers, _ and -" }))).into_response();
    }
    if req.password.len() < 6 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Password must be at least 6 characters" }))).into_response();
    }
    if req.password != req.confirm_password {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Passwords do not match" }))).into_response();
    }

    let mut users = load_users(&state.data_root);

    // Check duplicate
    if users.iter().any(|u| u.username.eq_ignore_ascii_case(&username)) {
        return (StatusCode::CONFLICT, Json(json!({ "error": "Username already exists" }))).into_response();
    }

    // Create user
    let salt = &Uuid::new_v4().to_string()[..8];
    let new_user = StoredUser {
        id: Uuid::new_v4().to_string(),
        username: username.clone(),
        password_hash: hash_password(&req.password, salt),
        created_at: chrono::Utc::now().timestamp(),
    };

    users.push(new_user.clone());
    if let Err(e) = save_users(&state.data_root, &users) {
        warn!("Failed to save users: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to save user" }))).into_response();
    }

    // Issue JWT
    match issue_jwt(&state, &new_user) {
        Ok(token) => {
            info!("Registered new user: {username}");
            let mut response = (StatusCode::CREATED, Json(json!({ "id": new_user.id, "username": new_user.username }))).into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                set_cookie_header(&token).parse().unwrap(),
            );
            response
        }
        Err(e) => {
            warn!("JWT issue failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Auth token error" }))).into_response()
        }
    }
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Response {
    let username = req.username.trim();
    let users = load_users(&state.data_root);

    let user = users.iter().find(|u| u.username.eq_ignore_ascii_case(username));
    let Some(user) = user else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid username or password" }))).into_response();
    };

    if !verify_password(&req.password, &user.password_hash) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid username or password" }))).into_response();
    }

    match issue_jwt(&state, user) {
        Ok(token) => {
            info!("User logged in: {username}");
            let mut response = Json(json!({ "id": user.id, "username": user.username })).into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                set_cookie_header(&token).parse().unwrap(),
            );
            response
        }
        Err(e) => {
            warn!("JWT issue failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Auth token error" }))).into_response()
        }
    }
}

pub async fn logout() -> Response {
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        clear_cookie_header().parse().unwrap(),
    );
    response
}

pub async fn me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    match get_current_user(&state, &headers) {
        Some(claims) => Json(json!({ "id": claims.sub, "username": claims.username })).into_response(),
        None => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Not authenticated" }))).into_response(),
    }
}
