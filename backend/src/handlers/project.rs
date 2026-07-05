use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};
use crate::{error::Result, state::AppState};

#[derive(Deserialize)]
pub struct OpenBody {
    pub path: String,
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
pub struct CreateAutoBody {
    pub name: String,
}

#[derive(Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
}

fn read_project_name(dir: &Path) -> String {
    let proj_file = dir.join("project.json");
    if let Ok(data) = fs::read_to_string(&proj_file) {
        if let Ok(json) = serde_json::from_str::<Value>(&data) {
            if let Some(name) = json.get("name").and_then(|n| n.as_str()) {
                return name.to_string();
            }
        }
    }
    dir.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn init_project_dirs(path: &Path, name: &str) -> anyhow::Result<ProjectInfo> {
    let dirs = [
        "wiki/concepts", "wiki/entities", "wiki/sources",
        "wiki/queries", "wiki/synthesis", "wiki/media",
        "raw/sources", ".llm-wiki/lancedb",
    ];
    for d in &dirs {
        fs::create_dir_all(path.join(d))?;
    }
    let proj_file = path.join("project.json");
    if !proj_file.exists() {
        fs::write(
            &proj_file,
            serde_json::to_string_pretty(&json!({ "name": name, "version": "1.0" }))?,
        )?;
    }
    Ok(ProjectInfo {
        name: name.to_string(),
        path: path.to_string_lossy().replace('\\', "/"),
    })
}

pub async fn list_projects(State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    let data_root = &state.data_root;
    if !data_root.is_dir() {
        return Ok(Json(json!([])));
    }
    let mut projects = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(data_root)?
        .flatten()
        .filter(|e| e.metadata().map(|m| m.is_dir()).unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = read_project_name(&entry.path());
        projects.push(json!({
            "name": name,
            "path": entry.path().to_string_lossy().replace('\\', "/"),
        }));
    }
    Ok(Json(json!(projects)))
}

pub async fn open_project(Json(body): Json<OpenBody>) -> Result<Json<Value>> {
    let p = Path::new(&body.path);
    if !p.is_dir() {
        return Err(anyhow::anyhow!("Directory not found: '{}'", body.path).into());
    }
    let name = read_project_name(p);
    Ok(Json(json!({
        "name": name,
        "path": body.path.replace('\\', "/"),
    })))
}

pub async fn create_project(Json(body): Json<CreateBody>) -> Result<Json<Value>> {
    let path = Path::new(&body.path);
    fs::create_dir_all(path)?;
    let info = init_project_dirs(path, &body.name)?;
    Ok(Json(serde_json::to_value(info)?))
}

pub async fn create_project_auto(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateAutoBody>,
) -> Result<Json<Value>> {
    let safe = body.name.trim().replace(' ', "-");
    if safe.is_empty() {
        return Err(anyhow::anyhow!("Project name is required").into());
    }
    let path = state.data_root.join(&safe);
    fs::create_dir_all(&path)?;
    let info = init_project_dirs(&path, body.name.trim())?;
    Ok(Json(serde_json::to_value(info)?))
}
