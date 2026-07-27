// Atelier desktop shell: spawns the bundled Node backend (pkg sidecar) on a
// loopback ephemeral port with a per-launch auth token, then points the
// webview at it. All product logic lives in the backend + web frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Backend(Mutex<Option<CommandChild>>);

/// Window controls for the frameless custom titlebar.
/// The webview runs on a remote (loopback) origin, so these are wired to the
/// `desktop` capability instead of relying on injected JS globals.
#[tauri::command]
fn window_control(win: WebviewWindow, action: &str) {
    match action {
        "minimize" => {
            let _ = win.minimize();
        }
        "toggle-maximize" => {
            // Rust API has maximize/unmaximize only — flip on current state.
            if win.is_maximized().unwrap_or(false) {
                let _ = win.unmaximize();
            } else {
                let _ = win.maximize();
            }
        }
        "close" => {
            win.close().unwrap_or_else(|err| {
                eprintln!("failed to close window: {err}");
                win.app_handle().exit(0);
            });
        }
        _ => {}
    }
}

/// Titlebar layout helper: on macOS the traffic lights overlay the page header,
/// so the frontend shifts its content right (only needed in the desktop shell).
#[tauri::command]
fn desktop_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch → focus the existing window instead.
            if let Some(win) = app.webview_windows().values().next() {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .manage(Backend(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![window_control, desktop_platform])
        .setup(|app| {
            let token = uuid::Uuid::new_v4().simple().to_string();
            let data_home = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_home)?;

            let sidecar = app
                .shell()
                .sidecar("atelier")?
                .env("ATELIER_HOME", data_home.to_string_lossy().to_string())
                .env("ATELIER_TOKEN", token.clone())
                .env("HOST", "127.0.0.1")
                .env("PORT", "0");

            let (mut rx, child) = sidecar.spawn()?;
            *app.state::<Backend>().0.lock().unwrap() = Some(child);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut opened = false;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let line = String::from_utf8_lossy(&bytes);
                            print!("[backend] {line}");
                            if opened {
                                continue;
                            }
                            let port = line
                                .trim()
                                .strip_prefix("ATELIER_READY port=")
                                .and_then(|p| p.trim().parse::<u16>().ok());
                            if let Some(port) = port {
                                opened = true;
                                let url = format!("http://127.0.0.1:{port}/?token={token}");
                                let handle2 = handle.clone();
                                let _ = handle.run_on_main_thread(move || {
                                    let builder = WebviewWindowBuilder::new(
                                        &handle2,
                                        "main",
                                        WebviewUrl::External(url.parse().unwrap()),
                                    )
                                    .title("Atelier")
                                    .inner_size(1280.0, 860.0)
                                    .min_inner_size(760.0, 560.0);
                                    #[cfg(target_os = "macos")]
                                    let builder = builder
                                        .decorations(true)
                                        .hidden_title(true)
                                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                                    #[cfg(not(target_os = "macos"))]
                                    let builder = builder.decorations(false);
                                    let win = builder.build();
                                    if let Err(err) = win {
                                        eprintln!("failed to open window: {err}");
                                        handle2.exit(1);
                                    }
                                });
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("[backend] {}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[backend] spawn error: {err}");
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[backend] exited with {:?}", status.code);
                            if !opened {
                                // Backend died before serving anything — nothing to show.
                                handle.exit(1);
                            }
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
