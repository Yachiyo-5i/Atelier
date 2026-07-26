// Atelier desktop shell: spawns the bundled Node backend (pkg sidecar) on a
// loopback ephemeral port with a per-launch auth token, then points the
// webview at it. All product logic lives in the backend + web frontend.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Backend(Mutex<Option<CommandChild>>);

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
                                    let win = WebviewWindowBuilder::new(
                                        &handle2,
                                        "main",
                                        WebviewUrl::External(url.parse().unwrap()),
                                    )
                                    .title("Atelier")
                                    .inner_size(1280.0, 860.0)
                                    .min_inner_size(760.0, 560.0)
                                    .build();
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
