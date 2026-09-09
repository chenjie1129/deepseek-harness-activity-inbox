use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env,
    io::{self, BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const PROTOCOL_VERSION: u8 = 1;
const DEFAULT_KEYCHAIN_SERVICE: &str = "com.deepseek-harness.activity-inbox.presence";
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_ACTIVITIES: usize = 10_000;

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub socket_path: PathBuf,
    pub keychain_service: String,
    pub keychain_account: String,
    pub harness_url: String,
}

impl RuntimeConfig {
    pub fn from_env() -> Result<Self, String> {
        let root = env::var_os("DSH_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
            .ok_or_else(|| "Unable to determine the user home directory.".to_string())?;
        let socket_path = env::var_os("DSH_PRESENCE_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("activity-inbox").join("presence-v1.sock"));
        let socket_path = absolute_path(&socket_path)?;
        let keychain_service = env::var("DSH_PRESENCE_KEYCHAIN_SERVICE")
            .unwrap_or_else(|_| DEFAULT_KEYCHAIN_SERVICE.to_string());
        let keychain_account = env::var("DSH_PRESENCE_KEYCHAIN_ACCOUNT")
            .unwrap_or_else(|_| keychain_account_for_socket(&socket_path));
        let harness_url =
            env::var("DSH_WEB_URL").unwrap_or_else(|_| "http://127.0.0.1:3080/".to_string());
        if !is_loopback_http_url(&harness_url) {
            return Err("DSH_WEB_URL must be an HTTP loopback URL.".to_string());
        }
        Ok(Self {
            socket_path,
            keychain_service,
            keychain_account,
            harness_url,
        })
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    env::current_dir()
        .map(|current| current.join(path))
        .map_err(|error| format!("Unable to resolve Presence socket path: {error}"))
}

fn is_loopback_http_url(value: &str) -> bool {
    value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
        || value.starts_with("http://[::1]:")
}

pub fn keychain_account_for_socket(socket_path: &Path) -> String {
    let digest = Sha256::digest(socket_path.to_string_lossy().as_bytes());
    format!("socket-{}", &format!("{digest:x}")[..32])
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPresenceState {
    Idle,
    Running,
    NeedsInput,
    Blocked,
    Failed,
    Ready,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PendingInteractionKind {
    Approval,
    PlanReview,
    Question,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityOutcome {
    Completed,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceActivity {
    pub session_id: String,
    pub state: AgentPresenceState,
    pub detail: String,
    pub updated_at: u64,
    pub source_seq: i64,
    pub followed: bool,
    pub reviewed: bool,
    pub archived: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_outcome: Option<ActivityOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_kind: Option<PendingInteractionKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPresenceSnapshot {
    pub version: u8,
    pub instance_id: String,
    pub revision: u64,
    pub generated_at: u64,
    pub ready: bool,
    pub backfill_failures: u64,
    pub activities: Vec<PresenceActivity>,
}

impl ActivityPresenceSnapshot {
    fn validate(&self) -> Result<(), String> {
        if self.version != PROTOCOL_VERSION {
            return Err("Unsupported Presence snapshot version.".to_string());
        }
        if self.instance_id.is_empty() || self.instance_id.len() > 128 {
            return Err("Presence instance id is invalid.".to_string());
        }
        if self.activities.len() > MAX_ACTIVITIES {
            return Err("Presence snapshot contains too many activities.".to_string());
        }
        let mut sessions = HashSet::with_capacity(self.activities.len());
        for activity in &self.activities {
            if activity.session_id.is_empty()
                || activity.session_id.len() > 256
                || activity.detail.len() > 500
                || activity.source_seq < -1
                || activity
                    .reason_code
                    .as_ref()
                    .is_some_and(|value| value.len() > 128)
                || !sessions.insert(&activity.session_id)
            {
                return Err("Presence snapshot contains invalid activity evidence.".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceCursor {
    pub instance_id: String,
    pub revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "presence/snapshot")]
    Snapshot {
        version: u8,
        snapshot: ActivityPresenceSnapshot,
    },
    #[serde(rename = "presence/unchanged")]
    Unchanged { version: u8, cursor: PresenceCursor },
    #[serde(rename = "presence/error")]
    Error {
        version: u8,
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionPhase {
    Connecting,
    Connected,
    Reconnecting,
    Offline,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeState {
    pub phase: ConnectionPhase,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub snapshot: Option<ActivityPresenceSnapshot>,
}

#[derive(Clone)]
pub struct DesktopRuntime {
    state: Arc<Mutex<DesktopRuntimeState>>,
    shutdown: Arc<AtomicBool>,
}

impl DesktopRuntime {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DesktopRuntimeState {
                phase: ConnectionPhase::Connecting,
                attempt: 0,
                last_error: None,
                snapshot: None,
            })),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn snapshot(&self) -> DesktopRuntimeState {
        self.state
            .lock()
            .expect("Presence state lock poisoned")
            .clone()
    }

    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Release);
    }

    fn update(
        &self,
        app: &AppHandle,
        phase: ConnectionPhase,
        attempt: u32,
        last_error: Option<String>,
        snapshot: Option<ActivityPresenceSnapshot>,
    ) {
        let next = DesktopRuntimeState {
            phase,
            attempt,
            last_error,
            snapshot,
        };
        *self.state.lock().expect("Presence state lock poisoned") = next.clone();
        let _ = app.emit("presence://state", next);
    }
}

fn read_keychain_token(config: &RuntimeConfig) -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            &config.keychain_account,
            "-s",
            &config.keychain_service,
            "-w",
        ])
        .output()
        .map_err(|_| "Unable to access macOS Keychain.".to_string())?;
    if !output.status.success() {
        return Err("Presence credential is unavailable in macOS Keychain.".to_string());
    }
    let token = String::from_utf8(output.stdout)
        .map_err(|_| "Presence Keychain credential is not UTF-8.".to_string())?
        .trim()
        .to_string();
    if !(32..=256).contains(&token.len()) {
        return Err("Presence Keychain credential has an invalid length.".to_string());
    }
    Ok(token)
}

fn write_client_message(stream: &mut UnixStream, value: serde_json::Value) -> Result<(), String> {
    let mut frame =
        serde_json::to_vec(&value).map_err(|_| "Unable to encode Presence request.".to_string())?;
    frame.push(b'\n');
    if frame.len() > 16 * 1024 {
        return Err("Presence request exceeds the frame limit.".to_string());
    }
    stream
        .write_all(&frame)
        .map_err(|error| format!("Unable to write Presence request: {error}"))
}

fn subscribe_message(cursor: Option<&PresenceCursor>) -> serde_json::Value {
    match cursor {
        Some(cursor) => serde_json::json!({
            "type": "presence/subscribe",
            "version": PROTOCOL_VERSION,
            "cursor": cursor,
        }),
        None => serde_json::json!({
            "type": "presence/subscribe",
            "version": PROTOCOL_VERSION,
        }),
    }
}

fn read_frame(reader: &mut BufReader<UnixStream>) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let available = match reader.fill_buf() {
            Ok(value) => value,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Presence frame ended without a newline.",
                ))
            };
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if frame.len() + consumed > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Presence frame exceeds 8 MiB.",
            ));
        }
        frame.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if frame.last() == Some(&b'\n') {
            frame.pop();
            return Ok(Some(frame));
        }
    }
}

fn reconnect_delay_ms(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1).min(6);
    (250_u64.saturating_mul(1_u64 << exponent)).min(10_000)
}

fn next_reconnect_attempt(previous: u32, was_connected: bool) -> u32 {
    if was_connected {
        1
    } else {
        previous.saturating_add(1)
    }
}

fn connect_once(
    app: &AppHandle,
    runtime: &DesktopRuntime,
    config: &RuntimeConfig,
    cursor: &mut Option<PresenceCursor>,
) -> Result<(), String> {
    let token = read_keychain_token(config)?;
    let mut stream = UnixStream::connect(&config.socket_path)
        .map_err(|error| format!("Unable to connect to Activity Host: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("Unable to configure Presence socket: {error}"))?;
    write_client_message(
        &mut stream,
        serde_json::json!({
            "type": "presence/auth",
            "version": PROTOCOL_VERSION,
            "token": token,
        }),
    )?;
    write_client_message(&mut stream, subscribe_message(cursor.as_ref()))?;
    drop(token);

    let mut reader = BufReader::new(stream);
    while !runtime.shutdown.load(Ordering::Acquire) {
        let frame = match read_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Err("Activity Host closed the Presence socket.".to_string()),
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(error) => return Err(format!("Unable to read Presence update: {error}")),
        };
        let message: ServerMessage = serde_json::from_slice(&frame)
            .map_err(|_| "Activity Host sent malformed Presence data.".to_string())?;
        match message {
            ServerMessage::Snapshot { version, snapshot } => {
                if version != PROTOCOL_VERSION {
                    return Err("Activity Host uses an unsupported protocol version.".to_string());
                }
                snapshot.validate()?;
                let should_accept = cursor.as_ref().is_none_or(|current| {
                    current.instance_id != snapshot.instance_id
                        || snapshot.revision > current.revision
                });
                if should_accept {
                    *cursor = Some(PresenceCursor {
                        instance_id: snapshot.instance_id.clone(),
                        revision: snapshot.revision,
                    });
                    runtime.update(app, ConnectionPhase::Connected, 0, None, Some(snapshot));
                }
            }
            ServerMessage::Unchanged {
                version,
                cursor: unchanged,
            } => {
                if version != PROTOCOL_VERSION || cursor.as_ref() != Some(&unchanged) {
                    return Err("Activity Host sent an invalid reconnect cursor.".to_string());
                }
                let current = runtime.snapshot();
                runtime.update(app, ConnectionPhase::Connected, 0, None, current.snapshot);
            }
            ServerMessage::Error {
                version,
                code,
                message,
            } => {
                if version != PROTOCOL_VERSION {
                    return Err("Activity Host uses an unsupported protocol version.".to_string());
                }
                return Err(format!(
                    "Activity Host rejected Presence connection ({code}): {}",
                    message.chars().take(160).collect::<String>()
                ));
            }
        }
    }
    Ok(())
}

pub fn spawn_presence_worker(app: AppHandle, runtime: DesktopRuntime, config: RuntimeConfig) {
    thread::spawn(move || {
        let mut cursor = None;
        let mut attempt = 0_u32;
        while !runtime.shutdown.load(Ordering::Acquire) {
            let current = runtime.snapshot();
            runtime.update(
                &app,
                if attempt == 0 {
                    ConnectionPhase::Connecting
                } else {
                    ConnectionPhase::Reconnecting
                },
                attempt,
                current.last_error,
                current.snapshot,
            );
            match connect_once(&app, &runtime, &config, &mut cursor) {
                Ok(()) => break,
                Err(error) => {
                    let current = runtime.snapshot();
                    attempt = next_reconnect_attempt(
                        attempt,
                        current.phase == ConnectionPhase::Connected,
                    );
                    runtime.update(
                        &app,
                        ConnectionPhase::Reconnecting,
                        attempt,
                        Some(error.chars().take(240).collect()),
                        current.snapshot,
                    );
                    let delay = reconnect_delay_ms(attempt);
                    let slices = delay.div_ceil(100);
                    for _ in 0..slices {
                        if runtime.shutdown.load(Ordering::Acquire) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        if runtime.shutdown.load(Ordering::Acquire) {
            let current = runtime.snapshot();
            runtime.update(
                &app,
                ConnectionPhase::Offline,
                current.attempt,
                current.last_error,
                current.snapshot,
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> ActivityPresenceSnapshot {
        ActivityPresenceSnapshot {
            version: 1,
            instance_id: "host-a".to_string(),
            revision: 4,
            generated_at: 1_000,
            ready: true,
            backfill_failures: 0,
            activities: vec![],
        }
    }

    #[test]
    fn derives_the_same_stable_keychain_account() {
        assert_eq!(
            keychain_account_for_socket(Path::new("/tmp/dsh/activity-inbox/presence-v1.sock")),
            "socket-57ec541a38c104f82f7732132916f09b"
        );
    }

    #[test]
    fn bounds_reconnect_backoff() {
        assert_eq!(reconnect_delay_ms(1), 250);
        assert_eq!(reconnect_delay_ms(2), 500);
        assert_eq!(reconnect_delay_ms(7), 10_000);
        assert_eq!(reconnect_delay_ms(100), 10_000);
        assert_eq!(next_reconnect_attempt(6, true), 1);
        assert_eq!(next_reconnect_attempt(6, false), 7);
    }

    #[test]
    fn rejects_duplicate_or_oversized_activity_evidence() {
        let mut duplicate = snapshot();
        let row = PresenceActivity {
            session_id: "task".to_string(),
            state: AgentPresenceState::Running,
            detail: "Running".to_string(),
            updated_at: 1,
            source_seq: 0,
            followed: false,
            reviewed: false,
            archived: false,
            running: true,
            terminal_outcome: None,
            snoozed_until: None,
            pending_kind: None,
            reason_code: None,
            created_at: None,
            parent_session_id: None,
            origin: None,
        };
        duplicate.activities = vec![row.clone(), row];
        assert!(duplicate.validate().is_err());

        let mut oversized = snapshot();
        oversized.instance_id = "x".repeat(129);
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn accepts_a_valid_snapshot_message() {
        let value = serde_json::json!({
            "type": "presence/snapshot",
            "version": 1,
            "snapshot": snapshot(),
        });
        let message: ServerMessage = serde_json::from_value(value).expect("valid message");
        match message {
            ServerMessage::Snapshot { snapshot, .. } => {
                assert!(snapshot.validate().is_ok());
            }
            _ => panic!("expected snapshot"),
        }
    }

    #[test]
    fn omits_the_cursor_on_first_subscribe() {
        let initial = subscribe_message(None);
        assert!(initial.get("cursor").is_none());

        let cursor = PresenceCursor {
            instance_id: "host-a".to_string(),
            revision: 4,
        };
        assert_eq!(
            subscribe_message(Some(&cursor))["cursor"]["revision"],
            serde_json::json!(4)
        );
    }
}
