//! App de escritorio «todo en uno»: arranca el servidor de Millhiore WINK POS (compilado con Bun e
//! incluido en el instalador) y muestra la caja en una ventana. Los celulares y otras PC de la
//! red entran al mismo servidor por la IP de esta PC, como con `bun run start`.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// El servidor en marcha, para detenerlo al cerrar la app.
struct Server(Mutex<Option<CommandChild>>);

/// El 3000, salvo que MILLHIORE_PORT diga otro (p. ej. para probar junto a otro servidor).
fn preferred_port() -> u16 {
    std::env::var("MILLHIORE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000)
}

/// ¿Hay un servidor de Millhiore respondiendo en ese puerto?
fn is_millhiore(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.contains("\"configured\"")
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// El preferido si está libre (así los celulares siempre entran por el mismo puerto); si no, el
/// siguiente libre.
fn choose_port() -> Option<u16> {
    let first = preferred_port();
    (first..first.saturating_add(20)).find(|p| port_is_free(*p))
}

/// Ruta sin el prefijo `\\?\` que pone Windows a las rutas canónicas: con él no valen las barras
/// `/`, y las librerías del servidor arman rutas con `/`.
fn plain(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

fn log_line(path: &PathBuf, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line.trim_end());
    }
}

fn open_in_window(app: &AppHandle, port: u16) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("No se encontró la ventana principal")?;
    let url = Url::parse(&format!("http://localhost:{port}/")).map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())
}

/// Muestra el error en la pantalla de arranque (que lo lee de la dirección).
fn show_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(mut url) = window.url() {
            url.query_pairs_mut().clear().append_pair("error", message);
            let _ = window.navigate(url);
        }
    }
}

fn start_server(app: &AppHandle) -> Result<(), String> {
    // Ya hay uno (otra ventana, o el servidor instalado aparte): se usa ese.
    if is_millhiore(preferred_port()) {
        return open_in_window(app, preferred_port());
    }
    let port = choose_port().ok_or("No hay puertos libres para el servidor")?;

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let data_dir = app_data.join("data");
    let logs_dir = app_data.join("logs");
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    let log = logs_dir.join("servidor.log");

    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources");

    let (mut events, child) = app
        .shell()
        .sidecar("millhiore-server")
        .map_err(|e| e.to_string())?
        .env("PORT", port.to_string())
        .env("DATA_DIR", plain(&data_dir))
        .env("WEB_DIR", plain(&resources.join("web")))
        .env("MIGRATIONS_DIR", plain(&resources.join("drizzle")))
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el servidor: {e}"))?;
    app.state::<Server>().0.lock().unwrap().replace(child);

    // Lo que imprime el servidor queda en logs/servidor.log (para soporte).
    let log_for_events = log.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    log_line(&log_for_events, &String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Terminated(status) => log_line(
                    &log_for_events,
                    &format!("[app] el servidor terminó: {status:?}"),
                ),
                _ => {}
            }
        }
    });

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(90) {
        if is_millhiore(port) {
            return open_in_window(app, port);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "El servidor no respondió a tiempo. Revisa {}",
        log.to_string_lossy()
    ))
}

fn stop_server(app: &AppHandle) {
    if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Una sola instancia: abrir de nuevo el programa trae la ventana al frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(message) = start_server(&handle) {
                    show_error(&handle, &message);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Millhiore WINK POS")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}
