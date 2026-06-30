use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct FileSnapshot {
    mtime_ms: u128,
    size: u64,
}

#[derive(Clone)]
struct MatchedSession {
    file: PathBuf,
    session_id: String,
    timestamp: Option<String>,
    timestamp_ms: Option<i64>,
    cwd: Option<String>,
    previous_size: u64,
}

struct QuotaTail {
    file: PathBuf,
    offset: u64,
    carry: String,
}

struct QuotaEvent {
    timestamp: Option<String>,
    primary: f64,
    secondary: f64,
    reached_type: Option<String>,
    reset_at: Option<String>,
    plan_type: Option<String>,
}

struct Supervisor {
    cwd: String,
    real_codex: String,
    child: Option<Child>,
    intentional_stop: bool,
    profile_at_start: Option<String>,
    before: HashMap<PathBuf, FileSnapshot>,
    start_ms: i64,
    matched_session: Option<MatchedSession>,
    tail: Option<QuotaTail>,
    failover_attempts: usize,
    current_args: Vec<String>,
    quota_handled: bool,
}

impl Supervisor {
    fn start_child(&mut self) -> Result<(), String> {
        self.intentional_stop = false;
        self.profile_at_start = active_profile()?;
        self.before = snapshot_session_files()?;
        self.start_ms = now_millis() as i64;
        self.matched_session = None;
        self.tail = None;
        self.quota_handled = false;
        let launch_args = supervisor_launch_args(&self.current_args)?;
        let child = Command::new(&self.real_codex)
            .args(&launch_args)
            .current_dir(&self.cwd)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .env("CDXX_MANAGED", "1")
            .spawn()
            .map_err(to_string)?;
        self.child = Some(child);
        Ok(())
    }

    fn stop_child(&mut self) -> Result<i32, String> {
        let Some(mut child) = self.child.take() else {
            return Ok(0);
        };
        self.intentional_stop = true;
        terminate_process(child.id());
        for _ in 0..50 {
            if let Some(status) = child.try_wait().map_err(to_string)? {
                return Ok(status.code().unwrap_or(1));
            }
            thread::sleep(Duration::from_millis(100));
        }
        kill_process(child.id());
        let status = child.wait().map_err(to_string)?;
        Ok(status.code().unwrap_or(1))
    }

    fn tick(&mut self) -> Result<(), String> {
        if self.matched_session.is_none() {
            if let Some(matched) = find_matching_session(&self.before, &self.cwd, self.start_ms)? {
                save_last_session(&matched)?;
                self.tail = Some(QuotaTail {
                    file: matched.file.clone(),
                    offset: matched.previous_size,
                    carry: String::new(),
                });
                self.matched_session = Some(matched);
            }
        }

        if self.quota_handled {
            return Ok(());
        }
        let Some(tail) = self.tail.as_mut() else {
            return Ok(());
        };
        let events = tail.read_added()?;
        for event in events {
            if !event.exhausted() {
                continue;
            }
            let Some(profile_name) = self.profile_at_start.clone() else {
                continue;
            };
            let Some(session_id) = self
                .matched_session
                .as_ref()
                .map(|session| session.session_id.clone())
            else {
                continue;
            };
            self.quota_handled = true;
            eprintln!("[cdxx] Profile '{}' reached quota.", profile_name);
            let action = supervisor_failover(&profile_name, &session_id, &event)?;
            if let Some(message) = action.get("message").and_then(Value::as_str) {
                eprintln!("{message}");
            }
            if action.get("kind").and_then(Value::as_str) == Some("switch_and_resume") {
                self.failover_attempts += 1;
                if self.failover_attempts > 10 {
                    eprintln!("[cdxx] Stopping after 10 quota failover attempts.");
                    continue;
                }
                let _ = self.stop_child();
                self.current_args = vec!["resume".to_string(), session_id];
                self.start_child()?;
            }
        }
        Ok(())
    }
}

impl QuotaTail {
    fn read_added(&mut self) -> Result<Vec<QuotaEvent>, String> {
        let metadata = match fs::metadata(&self.file) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(vec![]),
        };
        if metadata.len() < self.offset {
            self.offset = 0;
            self.carry.clear();
        }
        if metadata.len() == self.offset {
            return Ok(vec![]);
        }
        let mut file = fs::File::open(&self.file).map_err(to_string)?;
        file.seek(SeekFrom::Start(self.offset)).map_err(to_string)?;
        let mut content = Vec::new();
        file.read_to_end(&mut content).map_err(to_string)?;
        self.offset = metadata.len();
        if content.is_empty() {
            return Ok(vec![]);
        }
        let appended = String::from_utf8_lossy(&content).to_string();
        let mut text = String::new();
        text.push_str(&self.carry);
        text.push_str(&appended);
        let complete = text.ends_with('\n') || text.ends_with('\r');
        let mut lines: Vec<&str> = text.lines().collect();
        if !complete {
            self.carry = lines.pop().unwrap_or_default().to_string();
        } else {
            self.carry.clear();
        }
        Ok(lines.into_iter().filter_map(parse_quota_event).collect())
    }
}

impl QuotaEvent {
    fn exhausted(&self) -> bool {
        self.primary >= 100.0 || self.secondary >= 100.0 || self.reached_type.is_some()
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("cdxx-supervisor: {error}");
            std::process::exit(1);
        }
    }
}

fn run(args: Vec<String>) -> Result<i32, String> {
    if !is_interactive_codex(&args) {
        let real_codex = find_real_codex()?;
        let status = Command::new(real_codex)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(to_string)?;
        return Ok(status.code().unwrap_or(1));
    }

    ensure_directories()?;
    let real_codex = find_real_codex()?;
    let cwd = env::current_dir()
        .map_err(to_string)?
        .to_string_lossy()
        .to_string();
    let supervisor = Arc::new(Mutex::new(Supervisor {
        current_args: args.clone(),
        cwd,
        real_codex,
        child: None,
        intentional_stop: false,
        profile_at_start: None,
        before: HashMap::new(),
        start_ms: now_millis() as i64,
        matched_session: None,
        tail: None,
        failover_attempts: 0,
        quota_handled: false,
    }));

    supervisor.lock().map_err(to_string)?.start_child()?;
    start_signal_handler(supervisor.clone())?;

    loop {
        thread::sleep(Duration::from_millis(500));
        let mut guard = supervisor.lock().map_err(to_string)?;
        guard.tick()?;
        let exited = match guard.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(to_string)?
                .map(|status| status.code().unwrap_or(1)),
            None => None,
        };
        if let Some(code) = exited {
            guard.child = None;
            if guard.intentional_stop {
                return Ok(code);
            }
            let _ = find_matching_session(&guard.before, &guard.cwd, guard.start_ms).and_then(
                |matched| {
                    if let Some(session) = matched {
                        save_last_session(&session)?;
                    }
                    Ok(())
                },
            );
            return Ok(code);
        }
    }
}

fn start_signal_handler(supervisor: Arc<Mutex<Supervisor>>) -> Result<(), String> {
    let mut signals = Signals::new([SIGINT, SIGTERM]).map_err(to_string)?;
    thread::spawn(move || {
        if let Some(signal) = signals.forever().next() {
            if let Ok(mut guard) = supervisor.lock() {
                let _ = guard.stop_child();
            }
            std::process::exit(if signal == SIGINT { 130 } else { 143 });
        }
    });
    Ok(())
}

fn supervisor_launch_args(args: &[String]) -> Result<Vec<String>, String> {
    let payload = json!({ "args": args });
    let encoded = base64_encode(
        serde_json::to_string(&payload)
            .map_err(to_string)?
            .as_bytes(),
    );
    let output = if let Ok(cli_path) = env::var("CDXX_CLI_PATH") {
        let node_path = env::var("CDXX_NODE_PATH").unwrap_or_else(|_| "node".to_string());
        Command::new(node_path)
            .arg(cli_path)
            .arg("_supervisor-launch-args")
            .arg(encoded)
            .output()
            .map_err(to_string)?
    } else {
        Command::new("cdxx")
            .arg("_supervisor-launch-args")
            .arg(encoded)
            .output()
            .map_err(to_string)?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("launch args helper failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value = serde_json::from_str(stdout.trim()).map_err(to_string)?;
    let argv = value
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| "launch args helper did not return argv".to_string())?;
    Ok(argv
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

fn config_dir() -> PathBuf {
    if let Ok(value) = env::var("CDXX_CONFIG_DIR") {
        return PathBuf::from(value);
    }
    if let Ok(value) = env::var("CODEXX_CONFIG_DIR") {
        return PathBuf::from(value);
    }
    let home = PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string()));
    let current = home.join(".config").join("cdxx");
    let legacy = home.join(".config").join("codexx");
    if current.exists() || !legacy.exists() {
        current
    } else {
        legacy
    }
}

fn runtime_dir() -> PathBuf {
    config_dir().join("run")
}

fn state_path() -> PathBuf {
    config_dir().join("state.json")
}

fn codex_home() -> PathBuf {
    env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string())).join(".codex")
        })
}

fn sessions_dir() -> PathBuf {
    codex_home().join("sessions")
}

fn ensure_directories() -> Result<(), String> {
    for directory in [config_dir(), runtime_dir()] {
        fs::create_dir_all(&directory).map_err(to_string)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

fn load_state() -> Result<Value, String> {
    match fs::read_to_string(state_path()) {
        Ok(content) => serde_json::from_str(&content).map_err(to_string),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "version": 1, "profiles": [], "settings": { "autoswitch": false } }))
        }
        Err(error) => Err(to_string(error)),
    }
}

fn save_state(state: &Value) -> Result<(), String> {
    ensure_directories()?;
    write_json_file(&state_path(), state)
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        std::process::id(),
    ));
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(to_string)?;
    file.write_all(
        serde_json::to_string_pretty(value)
            .map_err(to_string)?
            .as_bytes(),
    )
    .map_err(to_string)?;
    file.write_all(b"\n").map_err(to_string)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(to_string)?;
    fs::rename(&temporary, path).map_err(to_string)?;
    Ok(())
}

fn active_profile() -> Result<Option<String>, String> {
    Ok(load_state()?
        .get("activeProfile")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn save_last_session(session: &MatchedSession) -> Result<(), String> {
    let mut state = load_state()?;
    let payload = json!({
        "sessionId": session.session_id,
        "file": session.file.to_string_lossy(),
        "timestamp": session.timestamp,
        "cwd": session.cwd,
        "matchedAt": now_iso(),
    });
    state["lastSession"] = payload.clone();
    let active_name = state
        .get("activeProfile")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(active_name) = active_name {
        if let Some(profiles) = state.get_mut("profiles").and_then(Value::as_array_mut) {
            if let Some(profile) = profiles.iter_mut().find(|profile| {
                profile.get("name").and_then(Value::as_str) == Some(active_name.as_str())
            }) {
                profile["lastSession"] = payload;
            }
        }
    }
    save_state(&state)
}

fn find_real_codex() -> Result<String, String> {
    if let Ok(path) = env::var("CDXX_REAL_CODEX") {
        if is_executable(Path::new(&path)) {
            return Ok(path);
        }
    }
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    if let Ok(path) = env::var("PATH") {
        for directory in path.split(':') {
            candidates.push(PathBuf::from(directory).join("codex"));
        }
    }
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if !seen.insert(key.clone()) || !is_executable(&candidate) {
            continue;
        }
        return Ok(key);
    }
    Err("The real codex executable was not found. Set CDXX_REAL_CODEX.".to_string())
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn is_interactive_codex(args: &[String]) -> bool {
    let command = args.iter().find(|arg| !arg.starts_with('-'));
    let Some(command) = command else {
        return true;
    };
    !matches!(
        command.as_str(),
        "exec"
            | "e"
            | "review"
            | "login"
            | "logout"
            | "mcp"
            | "plugin"
            | "doctor"
            | "completion"
            | "update"
    )
}

fn snapshot_session_files() -> Result<HashMap<PathBuf, FileSnapshot>, String> {
    let mut snapshot = HashMap::new();
    for file in walk_jsonl(&sessions_dir())? {
        if let Ok(metadata) = fs::metadata(&file) {
            snapshot.insert(
                file,
                FileSnapshot {
                    mtime_ms: modified_ms(&metadata),
                    size: metadata.len(),
                },
            );
        }
    }
    Ok(snapshot)
}

fn walk_jsonl(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
    Ok(files)
}

fn find_matching_session(
    before: &HashMap<PathBuf, FileSnapshot>,
    cwd: &str,
    start_ms: i64,
) -> Result<Option<MatchedSession>, String> {
    let mut candidates = Vec::new();
    for file in walk_jsonl(&sessions_dir())? {
        let Ok(metadata) = fs::metadata(&file) else {
            continue;
        };
        let previous = before.get(&file);
        let mtime_ms = modified_ms(&metadata);
        let is_new = previous.is_none();
        let is_modified = previous
            .map(|entry| mtime_ms > entry.mtime_ms + 1)
            .unwrap_or(false);
        if !is_new && !is_modified {
            continue;
        }
        let Some(mut meta) = read_session_meta(&file)? else {
            continue;
        };
        if meta.cwd.as_deref() != Some(cwd) {
            continue;
        }
        let event_ms = meta.timestamp_ms.unwrap_or(mtime_ms as i64);
        if event_ms < start_ms - 5000 {
            continue;
        }
        meta.previous_size = previous.map(|entry| entry.size).unwrap_or(0);
        let score = (event_ms - start_ms).abs() as u128 * 10
            + if mtime_ms > start_ms as u128 {
                mtime_ms - start_ms as u128
            } else {
                start_ms as u128 - mtime_ms
            };
        candidates.push((score, meta));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(candidates.into_iter().map(|(_, meta)| meta).next())
}

fn read_session_meta(file: &Path) -> Result<Option<MatchedSession>, String> {
    let content = fs::read_to_string(file).unwrap_or_default();
    let Some(line) = content.lines().next() else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ok(None);
    };
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return Ok(None);
    }
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if let Some(originator) = payload.get("originator").and_then(Value::as_str) {
        if originator != "codex-tui" {
            return Ok(None);
        }
    }
    let session_id = payload
        .get("session_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let timestamp = payload
        .get("timestamp")
        .or_else(|| value.get("timestamp"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Some(MatchedSession {
        file: file.to_path_buf(),
        session_id,
        timestamp_ms: timestamp.as_deref().and_then(parse_iso_ms),
        timestamp,
        cwd: payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        previous_size: 0,
    }))
}

fn parse_quota_event(line: &str) -> Option<QuotaEvent> {
    if !line.contains("\"token_count\"") || !line.contains("\"rate_limits\"") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg")
        || value.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
    {
        return None;
    }
    let rate_limits = value.pointer("/payload/rate_limits")?;
    let primary = rate_limits
        .pointer("/primary/used_percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let secondary = rate_limits
        .pointer("/secondary/used_percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let reached_type = rate_limits
        .get("rate_limit_reached_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(QuotaEvent {
        timestamp: value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary,
        secondary,
        reached_type,
        reset_at: pick_reset(rate_limits),
        plan_type: rate_limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn pick_reset(rate_limits: &Value) -> Option<String> {
    let primary_used = rate_limits
        .pointer("/primary/used_percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let secondary_used = rate_limits
        .pointer("/secondary/used_percent")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let primary_reset = rate_limits
        .pointer("/primary/resets_at")
        .and_then(Value::as_f64);
    let secondary_reset = rate_limits
        .pointer("/secondary/resets_at")
        .and_then(Value::as_f64);
    if primary_used >= 100.0 {
        return primary_reset.and_then(epoch_seconds_to_iso);
    }
    if secondary_used >= 100.0 {
        return secondary_reset.and_then(epoch_seconds_to_iso);
    }
    primary_reset
        .or(secondary_reset)
        .and_then(epoch_seconds_to_iso)
}

fn supervisor_failover(
    profile_name: &str,
    session_id: &str,
    event: &QuotaEvent,
) -> Result<Value, String> {
    let payload = json!({
        "profileName": profile_name,
        "sessionId": session_id,
        "timestamp": event.timestamp,
        "primary": event.primary,
        "secondary": event.secondary,
        "reachedType": event.reached_type,
        "resetAt": event.reset_at,
        "planType": event.plan_type,
    });
    let encoded = base64_encode(
        serde_json::to_string(&payload)
            .map_err(to_string)?
            .as_bytes(),
    );
    let output = if let Ok(cli_path) = env::var("CDXX_CLI_PATH") {
        let node_path = env::var("CDXX_NODE_PATH").unwrap_or_else(|_| "node".to_string());
        Command::new(node_path)
            .arg(cli_path)
            .arg("_supervisor-failover")
            .arg(encoded)
            .output()
            .map_err(to_string)?
    } else {
        Command::new("cdxx")
            .arg("_supervisor-failover")
            .arg(encoded)
            .output()
            .map_err(to_string)?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[cdxx] failover command failed: {}", stderr.trim());
        return Ok(json!({
            "kind": "stop_retrying",
            "reason": "policy_helper_failed",
            "message": "[cdxx] Quota failover policy helper failed; failover stopped."
        }));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(to_string)
}

fn terminate_process(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

fn kill_process(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status();
}

fn modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|datetime| datetime.timestamp_millis())
}

fn epoch_seconds_to_iso(value: f64) -> Option<String> {
    let seconds = value.trunc() as i64;
    let nanos = ((value.fract()) * 1_000_000_000.0).round() as u32;
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        let b0 = input[index];
        let b1 = if index + 1 < input.len() {
            input[index + 1]
        } else {
            0
        };
        let b2 = if index + 2 < input.len() {
            input[index + 2]
        } else {
            0
        };
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if index + 1 < input.len() {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if index + 2 < input.len() {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
        index += 3;
    }
    output
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
