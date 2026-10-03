use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tauri::Manager;
use taurio::BuilderExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Connection {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

fn default_connection() -> Connection {
    let port = std::env::var("AGENTGATE_PORT").unwrap_or_else(|_| "7878".into());
    Connection {
        url: format!("http://127.0.0.1:{port}"),
        token: None,
    }
}

#[tauri::command]
fn local_connection() -> Connection {
    default_connection()
}

fn require_local(connection: &Connection) -> Result<(), String> {
    let url = endpoint(connection, "/status")?;
    let own = endpoint(&default_connection(), "/status")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || url.port_or_known_default() != own.port_or_known_default()
    {
        return Err("Connect to this app's local daemon before managing its service or coding-tool settings".into());
    }
    Ok(())
}

fn endpoint(connection: &Connection, path: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(&connection.url).map_err(|_| "Enter a valid daemon URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use a daemon origin such as http://127.0.0.1:7878".into());
    }
    if !path.starts_with('/') || path.starts_with("//") || path.contains('#') || path.contains('\\')
    {
        return Err("Invalid API path".into());
    }
    let (pathname, query) = path
        .split_once('?')
        .map_or((path, None), |(p, q)| (p, Some(q)));
    if pathname
        .split('/')
        .any(|p| p == ".." || p == "." || p.to_lowercase().contains("%2e"))
    {
        return Err("Invalid API path".into());
    }
    url.set_path(&format!("/api{pathname}"));
    url.set_query(query);
    Ok(url)
}

async fn send(
    connection: &Connection,
    path: &str,
    method: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = endpoint(connection, path)?;
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported method".into()),
    };
    // Never forward the admin token to a redirect target.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    if let Some(token) = &connection.token {
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await.map_err(|_| {
        "Cannot reach the daemon. Start its service and check the connection address.".to_string()
    })?;
    let status = response.status();
    let result: Value = response.json().await.map_err(|_| {
        "The daemon did not return JSON. Check the address and Agentgate version.".to_string()
    })?;
    if !status.is_success() {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The daemon rejected the request")
            .into());
    }
    Ok(result)
}

#[tauri::command]
async fn api_request(
    connection: Connection,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    send(&connection, &path, &method, body).await
}

fn connection_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("connection.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_connection(app: tauri::AppHandle) -> Result<Connection, String> {
    let file = connection_file(&app)?;
    match tokio::fs::read(file).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Connection settings could not be read".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default_connection()),
        Err(e) => Err(e.to_string()),
    }
}

fn private_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

#[tauri::command]
fn save_connection(app: tauri::AppHandle, connection: Connection) -> Result<(), String> {
    endpoint(&connection, "/status")?;
    let file = connection_file(&app)?;
    std::fs::create_dir_all(file.parent().ok_or("Invalid config directory")?)
        .map_err(|e| e.to_string())?;
    private_write(
        &file,
        &serde_json::to_vec(&connection).map_err(|e| e.to_string())?,
    )
}

#[tauri::command]
async fn export_backup(connection: Connection, path: PathBuf, secrets: bool) -> Result<(), String> {
    let data = send(
        &connection,
        &format!("/backup?secrets={secrets}"),
        "GET",
        None,
    )
    .await?;
    private_write(
        &path,
        &serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
    )
}

#[tauri::command]
async fn import_backup(connection: Connection, path: PathBuf) -> Result<Value, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let data = serde_json::from_slice(&bytes)
        .map_err(|_| "Choose a valid Agentgate JSON backup".to_string())?;
    send(&connection, "/backup", "POST", Some(data)).await
}

fn config_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("AGENTGATE_HOME") {
        return Ok(PathBuf::from(dir));
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".config/agentgate"))
        .ok_or_else(|| "HOME is not set".into())
}

fn bundled_binary() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(executable
        .parent()
        .ok_or("App path is unavailable")?
        .join("agentgate"))
}

fn install_binary() -> Result<PathBuf, String> {
    let source = bundled_binary()?;
    let dir = config_home()?.join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("agentgate");
    let temp = dir.join(format!("agentgate-{}.tmp", std::process::id()));
    std::fs::copy(source, &temp)
        .map_err(|e| format!("Bundled daemon could not be installed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(temp, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

async fn run_cli(binary: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut paths = vec![config_home()?.join("bin")];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.extend([
            home.join(".local/bin"),
            home.join(".bun/bin"),
            home.join(".cargo/bin"),
        ]);
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(binary)
            .args(args)
            .env(
                "PATH",
                std::env::join_paths(paths).map_err(|e| e.to_string())?,
            )
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "The command timed out; check Agentgate service logs".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
async fn local_action(action: String, connection: Connection) -> Result<String, String> {
    require_local(&connection)?;
    let args: &[&str] = match action.as_str() {
        "install" => &["service", "install"],
        "start" => &["service", "start"],
        "stop" => &["service", "stop"],
        "setup" => &["setup"],
        "primary-on" => &["setup", "--primary"],
        "primary-off" => &["setup", "--primary", "off"],
        "mcp-on" => &["setup", "--mcp"],
        "mcp-off" => &["setup", "--mcp", "off"],
        "admin-token" => &["admin-token"],
        _ => return Err("Unknown local action".into()),
    };
    // Services and generated MCP shims point outside the app bundle, so quitting or
    // removing the control app leaves Agentgate running and its CLI usable.
    let binary = install_binary()?;
    if action == "install" {
        run_cli(&binary, &["init"]).await?;
    }
    run_cli(&binary, args).await
}

/// An app update replaces the bundled daemon but not the copy the service runs.
/// When the service runs that copy and it differs, install the new one and restart.
async fn refresh_daemon() -> Result<(), String> {
    let installed = config_home()?.join("bin/agentgate");
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
    let plist = home.join("Library/LaunchAgents/dev.agentgate.plist");
    let Ok(service) = tokio::fs::read_to_string(plist).await else {
        return Ok(());
    };
    if !service.contains(&*installed.to_string_lossy()) {
        return Ok(());
    }
    let bundled = tokio::fs::read(bundled_binary()?)
        .await
        .map_err(|e| e.to_string())?;
    if tokio::fs::read(&installed).await.ok().as_ref() == Some(&bundled) {
        return Ok(());
    }
    run_cli(&install_binary()?, &["service", "install"])
        .await
        .map(drop)
}

pub fn run() {
    tauri::Builder::default()
        .shared_plugins()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            api_request,
            load_connection,
            local_connection,
            save_connection,
            local_action,
            export_backup,
            import_backup
        ])
        .setup(|app| {
            // Debug builds would push a dev daemon into the real service.
            if !cfg!(debug_assertions) {
                tauri::async_runtime::spawn(async {
                    if let Err(e) = refresh_daemon().await {
                        eprintln!("Could not refresh the Agentgate service: {e}");
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = taurio::apply_window_appearance(&window) {
                    eprintln!("{e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Agentgate");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_controls_require_the_configured_local_daemon() {
        let local = default_connection();
        assert!(require_local(&local).is_ok());
        assert!(require_local(&Connection {
            url: local.url.replace("127.0.0.1", "localhost"),
            token: None,
        })
        .is_ok());
        let mut wrong_port = endpoint(&local, "/status").unwrap();
        wrong_port.set_path("/");
        wrong_port
            .set_port(Some(if wrong_port.port() == Some(7879) {
                7880
            } else {
                7879
            }))
            .unwrap();
        assert!(require_local(&Connection {
            url: wrong_port.to_string(),
            token: None
        })
        .is_err());
        assert!(require_local(&Connection {
            url: "http://server.tailnet.ts.net:7878".into(),
            token: None
        })
        .is_err());
    }

    #[test]
    fn bridge_keeps_requests_in_the_control_api() {
        let connection = Connection {
            url: "http://127.0.0.1:7878".into(),
            token: None,
        };
        assert_eq!(
            endpoint(&connection, "/projects/tools?id=owner%2Frepo")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:7878/api/projects/tools?id=owner%2Frepo"
        );
        for path in [
            "//evil.test",
            "/../peer",
            "/%2e%2e/peer",
            "/status#fragment",
            "/status\\oops",
        ] {
            assert!(endpoint(&connection, path).is_err());
        }
        for url in [
            "file:///etc/passwd",
            "http://user:secret@host",
            "http://localhost/api",
            "http://localhost?token=x",
        ] {
            assert!(endpoint(
                &Connection {
                    url: url.into(),
                    token: None
                },
                "/status"
            )
            .is_err());
        }
    }

    #[test]
    fn private_files_are_atomically_replaced() {
        let dir =
            std::env::temp_dir().join(format!("agentgate-native-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("backup.json");
        private_write(&file, b"first").unwrap();
        private_write(&file, b"second").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
