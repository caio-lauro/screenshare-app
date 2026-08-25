// Evita janela de console extra no Windows em modo release. NÃO REMOVER.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Guarda o processo do sidecar (servidor Node empacotado) pra conseguir
// encerrá-lo quando o usuário realmente sair pelo menu da bandeja.
struct SidecarState(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let shell = app.shell();
            // Nota: aqui usamos só "server" (sem o prefixo "binaries/"), diferente do
            // que aparece em tauri.conf.json > externalBin e em capabilities/default.json,
            // que precisam do caminho completo "binaries/server". A API .sidecar() do lado
            // Rust espera só o nome do arquivo.
            let sidecar_command = shell
                .sidecar("server")
                .expect("falha ao criar o comando do sidecar — confira o nome em tauri.conf.json > bundle > externalBin");

            let (mut rx, child) = sidecar_command
                .spawn()
                .expect("falha ao iniciar o servidor sidecar");

            // Guarda o child no estado do app pra poder matar quando o app sair de vez.
            *app.state::<SidecarState>().0.lock().unwrap() = Some(child);

            // Repassa a saída do servidor Node pro console do app, útil pra depurar
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[servidor] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[servidor] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[servidor] erro: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[servidor] encerrado: {payload:?}");
                        }
                        _ => {}
                    }
                }
            });

            // ---------- Ícone de bandeja ----------
            // NOTA: essa é a parte mais nova/menos testada da configuração. Se o
            // cargo reclamar de alguma dessas chamadas (API pode ter mudado um
            // pouco entre versões do Tauri), me manda o erro exato de compilação
            // que a gente ajusta junto.
            let show_item = MenuItem::with_id(app, "show", "Mostrar janela", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "Sair (encerra a transmissão)",
                true,
                None::<&str>,
            )?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(child) = app.state::<SidecarState>().0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Clicar no X só esconde a janela — a transmissão continua rodando em
            // segundo plano (o sidecar não é afetado). Só encerra de verdade pelo
            // menu "Sair" da bandeja.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao rodar a aplicação Tauri");
}
