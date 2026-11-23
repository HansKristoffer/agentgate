use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{OnceLock, RwLock},
    time::Duration,
};
use tauri::Manager;
use taurio::BuilderExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Connection {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

struct ActiveConnection(RwLock<Connection>);

impl ActiveConnection {
    fn new() -> Self {
        Self(RwLock::new(default_connection()))
    }
    fn get(&self) -> Connection {
        self.0
            .read()
            .map(|c| c.clone())
            .unwrap_or_else(|_| default_connection())
    }
    fn set(&self, next: Connection) {
        if let Ok(mut guard) = self.0.write() {
            *guard = next;
        }
    }
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

/// One client for the app's lifetime, so polls and long-polls reuse their TCP and TLS connections.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // Never forward the admin token to a redirect target.
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// `/changes` holds the request open for up to `wait` seconds (25 when absent), so it gets that plus 10;
/// everything else gets 120 seconds.
fn request_timeout(url: &reqwest::Url) -> Duration {
    if url.path() != "/api/changes" {
        return Duration::from_secs(120);
    }
    let wait = url
        .query_pairs()
        .find(|(key, _)| key == "wait")
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(25);
    Duration::from_secs(wait.saturating_add(10))
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
    let timeout = request_timeout(&url);
    let mut req = client()?.request(method, url).timeout(timeout);
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
    state: tauri::State<'_, ActiveConnection>,
    connection: Connection,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    state.set(connection.clone());
    send(&connection, &path, &method, body).await
}

fn connection_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // `bun run dev` shares the installed app's config dir; keep its saved connection separate.
    let name = if std::env::var("AGENTGATE_DEV").as_deref() == Ok("1") {
        "connection.dev.json"
    } else {
        "connection.json"
    };
    app.path()
        .app_config_dir()
        .map(|p| p.join(name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, ActiveConnection>,
) -> Result<Connection, String> {
    let file = connection_file(&app)?;
    let loaded = match tokio::fs::read(file).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Connection settings could not be read".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default_connection()),
        Err(e) => Err(e.to_string()),
    }?;
    state.set(loaded.clone());
    Ok(loaded)
}

fn private_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // The mode is set at creation, so the secrets are never readable by other users, even briefly.
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
fn save_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, ActiveConnection>,
    connection: Connection,
) -> Result<(), String> {
    endpoint(&connection, "/status")?;
    let file = connection_file(&app)?;
    std::fs::create_dir_all(file.parent().ok_or("Invalid config directory")?)
        .map_err(|e| e.to_string())?;
    private_write(
        &file,
        &serde_json::to_vec(&connection).map_err(|e| e.to_string())?,
    )?;
    state.set(connection);
    Ok(())
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
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Choose a valid Agentgate JSON backup".to_string())?;
    if serde_json::to_vec(&data).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("This backup exceeds the app's 16 MiB restore limit. Use agentgate import <backup-file> on the daemon's machine.".into());
    }
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
    // A GUI app starts with a minimal PATH, so the CLI's usual install locations are added
    // in front of the inherited one.
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
    let path = std::env::join_paths(paths).map_err(|e| e.to_string())?;

    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .env("PATH", path)
        .stdin(std::process::Stdio::null())
        // Dropping the command on timeout kills the child instead of leaving it running.
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
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

fn decode_hex_node(host: &str) -> Result<String, String> {
    let hex = host
        .strip_prefix("n-")
        .ok_or_else(|| "Invalid factory machine host".to_string())?;
    let (pairs, rem) = hex.as_bytes().as_chunks::<2>();
    if pairs.is_empty() || !rem.is_empty() {
        return Err("Invalid factory machine host".into());
    }
    let mut bytes = Vec::with_capacity(pairs.len());
    for chunk in pairs {
        let pair = std::str::from_utf8(chunk).map_err(|_| "Invalid factory machine host")?;
        let b = u8::from_str_radix(pair, 16).map_err(|_| "Invalid factory machine host")?;
        bytes.push(b);
    }
    String::from_utf8(bytes).map_err(|_| "Invalid factory machine name".into())
}

fn percent_encode_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(*byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(&mut out, "%{byte:02X}");
        }
    }
    out
}

fn factory_error_response(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    let body = serde_json::json!({ "error": message }).to_string();
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(body.into_bytes())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

async fn proxy_factory_uri(
    connection: Connection,
    method: tauri::http::Method,
    uri: tauri::http::Uri,
    content_type: Option<String>,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    let host = match uri.host() {
        Some(h) => h,
        None => return factory_error_response(400, "Missing factory machine"),
    };
    let node = match decode_hex_node(host) {
        Ok(n) => n,
        Err(e) => return factory_error_response(400, &e),
    };
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let clean_path = if path_and_query.starts_with('/') {
        path_and_query.to_string()
    } else {
        format!("/{path_and_query}")
    };
    let daemon_path = format!(
        "/factory-proxy/{}{clean_path}",
        percent_encode_segment(&node)
    );
    let url = match endpoint(&connection, &daemon_path) {
        Ok(u) => u,
        Err(e) => return factory_error_response(400, &e),
    };
    let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return factory_error_response(405, "Unsupported method"),
    };
    let timeout = if url.path().ends_with("/api/changes") {
        Duration::from_secs(45)
    } else {
        Duration::from_secs(35)
    };
    let client = match client() {
        Ok(c) => c,
        Err(e) => return factory_error_response(500, &e),
    };
    let mut req = client.request(req_method, url).timeout(timeout);
    if let Some(token) = &connection.token {
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
    }
    if let Some(ct) = content_type {
        req = req.header("content-type", ct);
    }
    if !body.is_empty() {
        req = req.body(body);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(_) => {
            return factory_error_response(
                503,
                "Cannot reach the Agentgate daemon while loading Factory.",
            )
        }
    };
    let status = response.status().as_u16();
    let res_ct = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let res_csp = response
        .headers()
        .get("content-security-policy")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => return factory_error_response(502, "Factory response failed while reading body."),
    };
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("cache-control", "no-store");
    if let Some(ct) = res_ct {
        builder = builder.header("content-type", ct);
    }
    if let Some(csp) = res_csp {
        builder = builder.header("content-security-policy", csp);
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| factory_error_response(500, "Could not build Factory response"))
}

pub fn run() {
    tauri::Builder::default()
        .manage(ActiveConnection::new())
        .shared_plugins()
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol("factory", |ctx, req, responder| {
            let connection = ctx.app_handle().state::<ActiveConnection>().get();
            let method = req.method().clone();
            let uri = req.uri().clone();
            let content_type = req
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let body = req.into_body();
            tauri::async_runtime::spawn(async move {
                let res = proxy_factory_uri(connection, method, uri, content_type, body).await;
                responder.respond(res);
            });
        })
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

    #[test]
    fn hex_node_decoding_handles_utf8_and_rejects_bad_hosts() {
        assert_eq!(decode_hex_node("n-6d6163626f6f6b").unwrap(), "macbook");
        assert_eq!(
            decode_hex_node("n-4d6163426f6f6b2050726f").unwrap(),
            "MacBook Pro"
        );
        assert!(decode_hex_node("macbook").is_err());
        assert!(decode_hex_node("n-").is_err());
        assert!(decode_hex_node("n-zz").is_err());
        assert_eq!(percent_encode_segment("MacBook Pro"), "MacBook%20Pro");
    }
}
