mod presence;

use presence::{DesktopRuntime, DesktopRuntimeState, RuntimeConfig, spawn_presence_worker};
use serde::Serialize;
use std::{
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowSettings {
    always_on_top: bool,
    click_through: bool,
}

struct AppState {
    runtime: DesktopRuntime,
    config: RuntimeConfig,
    window: Arc<Mutex<WindowSettings>>,
    snap_armed: Arc<AtomicBool>,
    move_generation: Arc<AtomicU64>,
}

#[tauri::command]
fn get_runtime_state(state: State<'_, AppState>) -> DesktopRuntimeState {
    state.runtime.snapshot()
}

#[tauri::command]
fn get_window_settings(state: State<'_, AppState>) -> WindowSettings {
    state
        .window
        .lock()
        .expect("window settings lock poisoned")
        .clone()
}

fn apply_always_on_top(
    window: &WebviewWindow,
    state: &AppState,
    enabled: bool,
) -> Result<WindowSettings, String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| format!("Unable to update always-on-top: {error}"))?;
    let mut settings = state
        .window
        .lock()
        .map_err(|_| "Window settings are unavailable.")?;
    settings.always_on_top = enabled;
    let next = settings.clone();
    let _ = window.emit("window://settings", next.clone());
    Ok(next)
}

#[tauri::command]
fn set_always_on_top(
    window: WebviewWindow,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<WindowSettings, String> {
    apply_always_on_top(&window, &state, enabled)
}

fn apply_click_through(
    window: &WebviewWindow,
    state: &AppState,
    enabled: bool,
) -> Result<WindowSettings, String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| format!("Unable to update click-through: {error}"))?;
    let mut settings = state
        .window
        .lock()
        .map_err(|_| "Window settings are unavailable.")?;
    settings.click_through = enabled;
    let next = settings.clone();
    let _ = window.emit("window://settings", next.clone());
    Ok(next)
}

#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<WindowSettings, String> {
    apply_click_through(&window, &state, enabled)
}

#[tauri::command]
fn arm_snap(state: State<'_, AppState>) {
    state.snap_armed.store(true, Ordering::Release);
    let generation = state.move_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let snap_armed = state.snap_armed.clone();
    let current_generation = state.move_generation.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2));
        if current_generation.load(Ordering::Acquire) == generation {
            snap_armed.store(false, Ordering::Release);
        }
    });
}

fn snap_window_to_edge(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Unable to read the current display: {error}"))?
        .ok_or_else(|| "No display contains the Activity Pet window.".to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Unable to read the window position: {error}"))?;
    let window_size = window
        .outer_size()
        .map_err(|error| format!("Unable to read the window size: {error}"))?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let Some((x, y)) = nearest_edge_position(
        (position.x, position.y),
        (window_size.width, window_size.height),
        (monitor_position.x, monitor_position.y),
        (monitor_size.width, monitor_size.height),
        12,
        48,
    ) else {
        return Ok(());
    };
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("Unable to snap Activity Pet: {error}"))
}

fn nearest_edge_position(
    position: (i32, i32),
    window_size: (u32, u32),
    monitor_position: (i32, i32),
    monitor_size: (u32, u32),
    margin: i32,
    snap_distance: i32,
) -> Option<(i32, i32)> {
    let left = monitor_position.0.saturating_add(margin);
    let right = monitor_position
        .0
        .saturating_add(monitor_size.0 as i32)
        .saturating_sub(window_size.0 as i32)
        .saturating_sub(margin);
    let top = monitor_position.1.saturating_add(margin);
    let bottom = monitor_position
        .1
        .saturating_add(monitor_size.1 as i32)
        .saturating_sub(window_size.1 as i32)
        .saturating_sub(margin);
    let left_distance = position.0.saturating_sub(left).abs();
    let right_distance = right.saturating_sub(position.0).abs();
    let nearest_distance = left_distance.min(right_distance);
    if nearest_distance > snap_distance {
        return None;
    }
    let x = if left_distance <= right_distance {
        left
    } else {
        right
    };
    Some((x, position.1.clamp(top, bottom.max(top))))
}

#[tauri::command]
fn open_harness(state: State<'_, AppState>) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg(&state.config.harness_url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open Harness: {error}"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<AppState>();
        let _ = apply_click_through(&window, &state, false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn center_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<AppState>();
        let _ = apply_click_through(&window, &state, false);
        let _ = window.center();
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Activity Pet", true, None::<&str>)?;
    let center = MenuItem::with_id(app, "center", "Center Activity Pet", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Harness", true, None::<&str>)?;
    let click_through = MenuItem::with_id(
        app,
        "click-through",
        "Toggle Click-through",
        true,
        None::<&str>,
    )?;
    let always_on_top = MenuItem::with_id(
        app,
        "always-on-top",
        "Toggle Always on Top",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Activity Pet", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &center,
            &open,
            &click_through,
            &always_on_top,
            &separator,
            &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("activity-pet")
        .tooltip("Activity Pet")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "center" => center_main_window(app),
            "open" => {
                let state = app.state::<AppState>();
                let _ = open_harness(state);
            }
            "click-through" => {
                if let Some(window) = app.get_webview_window("main") {
                    let state = app.state::<AppState>();
                    let enabled = state
                        .window
                        .lock()
                        .map(|settings| !settings.click_through)
                        .unwrap_or(false);
                    let _ = apply_click_through(&window, &state, enabled);
                    if !enabled {
                        let _ = window.show();
                    }
                }
            }
            "always-on-top" => {
                if let Some(window) = app.get_webview_window("main") {
                    let state = app.state::<AppState>();
                    let enabled = state
                        .window
                        .lock()
                        .map(|settings| !settings.always_on_top)
                        .unwrap_or(true);
                    let _ = apply_always_on_top(&window, &state, enabled);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .setup(|app| {
            let config = RuntimeConfig::from_env().map_err(io_error)?;
            let runtime = DesktopRuntime::new();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Activity Pet")
                .inner_size(260.0, 280.0)
                .min_inner_size(220.0, 220.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .center()
                .build()?;
            app.manage(AppState {
                runtime: runtime.clone(),
                config: config.clone(),
                window: Arc::new(Mutex::new(WindowSettings {
                    always_on_top: true,
                    click_through: false,
                })),
                snap_armed: Arc::new(AtomicBool::new(false)),
                move_generation: Arc::new(AtomicU64::new(0)),
            });
            build_tray(app.handle())?;
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(150));
                show_main_window(&app_handle);
            });
            spawn_presence_worker(app.handle().clone(), runtime, config);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Moved(_) => {
                let state = window.state::<AppState>();
                if !state.snap_armed.load(Ordering::Acquire) {
                    return;
                }
                let generation = state.move_generation.fetch_add(1, Ordering::AcqRel) + 1;
                let current_generation = state.move_generation.clone();
                let snap_armed = state.snap_armed.clone();
                let Some(window) = window.app_handle().get_webview_window(window.label()) else {
                    return;
                };
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(180));
                    if snap_armed.load(Ordering::Acquire)
                        && current_generation.load(Ordering::Acquire) == generation
                    {
                        snap_armed.store(false, Ordering::Release);
                        let _ = snap_window_to_edge(&window);
                    }
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_state,
            get_window_settings,
            set_always_on_top,
            set_click_through,
            arm_snap,
            open_harness,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Activity Pet")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<AppState>().runtime.stop();
                let _ = app.save_window_state(StateFlags::POSITION);
            }
        });
}

fn io_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

#[cfg(test)]
mod tests {
    use super::nearest_edge_position;

    #[test]
    fn only_snaps_near_a_monitor_edge_and_clamps_vertical_position() {
        assert_eq!(
            nearest_edge_position((300, 500), (260, 280), (0, 0), (1_920, 1_080), 12, 48),
            None
        );
        assert_eq!(
            nearest_edge_position((30, 500), (260, 280), (0, 0), (1_920, 1_080), 12, 48),
            Some((12, 500))
        );
        assert_eq!(
            nearest_edge_position((1_620, 2_000), (260, 280), (0, 0), (1_920, 1_080), 12, 48),
            Some((1_648, 788))
        );
    }
}
