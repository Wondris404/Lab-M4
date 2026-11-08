use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const PAGE_SIZE: usize = 500;
pub(super) const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    status: String,
    snapshot_id: String,
    total_records: usize,
    records: Vec<Value>,
    warnings: Vec<String>,
}

impl Snapshot {
    pub fn from_sidecar(mut response: Value) -> Result<Self, String> {
        let result = response
            .get_mut("result")
            .ok_or("Usage sidecar could not read the source")?;
        let snapshot: Self =
            serde_json::from_value(result.take()).map_err(|_| "Invalid Usage snapshot")?;
        if snapshot.is_valid() {
            Ok(snapshot)
        } else {
            Err("Invalid Usage snapshot".into())
        }
    }

    fn is_valid(&self) -> bool {
        self.total_records == self.records.len()
            && matches!(self.status.as_str(), "ok" | "partial")
            && self.snapshot_id.len() == 64
            && self
                .snapshot_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
    }

    pub fn keeps_previous(&self, previous: &Self) -> bool {
        !previous.records.is_empty()
            && (self.records.is_empty()
                || (self.status == "partial" && self.records.len() < previous.records.len()))
    }

    pub fn page(&self, offset: usize, kept_previous: bool) -> Value {
        let end = offset.saturating_add(PAGE_SIZE).min(self.records.len());
        let records = self.records.get(offset..end).unwrap_or_default();
        let mut warnings = self.warnings.clone();
        if kept_previous {
            warnings.push(
                "Obnova vrátila menej dostupných údajov. Zobrazujem posledný uložený výsledok."
                    .into(),
            );
        }
        json!({ "version": 1, "result": {
            "status": if kept_previous { "partial" } else { &self.status },
            "snapshotId": self.snapshot_id, "totalRecords": self.total_records,
            "offset": offset, "records": records, "warnings": warnings,
        } })
    }
}

pub(super) fn path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid source identifier".into());
    }
    Ok(dir.join("snapshots").join(format!("{id}.json")))
}

pub(super) fn read(path: &Path) -> Result<Option<Snapshot>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Saved Usage unavailable".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return Err("Invalid saved Usage snapshot".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| "Saved Usage unavailable")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Invalid saved Usage snapshot".into());
    }
    let snapshot: Snapshot =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid saved Usage snapshot")?;
    snapshot
        .is_valid()
        .then_some(Some(snapshot))
        .ok_or_else(|| "Invalid saved Usage snapshot".into())
}

pub(super) fn write(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let parent = path.parent().ok_or("Saved Usage directory unavailable")?;
    let bytes = serde_json::to_vec(snapshot).map_err(|_| "Invalid Usage snapshot")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Usage snapshot is too large".into());
    }
    fs::create_dir_all(parent).map_err(|_| "Saved Usage directory unavailable")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_nanos();
    let temp = parent.join(format!("snapshot-{}-{stamp}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "Could not save Usage snapshot")?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    if written.and_then(|()| fs::rename(&temp, path)).is_err() {
        let _ = fs::remove_file(temp);
        return Err("Could not save Usage snapshot".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(count: usize, status: &str) -> Snapshot {
        Snapshot {
            status: status.into(),
            snapshot_id: "a".repeat(64),
            total_records: count,
            records: (0..count).map(|i| json!({ "input": i })).collect(),
            warnings: vec![],
        }
    }

    #[test]
    fn pages_a_saved_snapshot_without_the_original_source() {
        let folder = std::env::temp_dir().join(format!(
            "lab-m4-saved-{}-{:x}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = path(&folder, "auto-codex").unwrap();
        assert!(read(&path).unwrap().is_none());
        write(&path, &sample(501, "ok")).unwrap();
        let snapshot = read(&path).unwrap().unwrap();
        assert_eq!(
            snapshot.page(0, false)["result"]["records"]
                .as_array()
                .unwrap()
                .len(),
            500
        );
        assert_eq!(
            snapshot.page(500, false)["result"]["records"],
            json!([{ "input": 500 }])
        );
        assert!(sample(3, "partial").keeps_previous(&snapshot));
        assert!(sample(0, "ok").keeps_previous(&snapshot));
        assert!(!sample(502, "partial").keeps_previous(&snapshot));
        write(&path, &sample(502, "ok")).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().total_records, 502);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
        fs::remove_dir(folder).unwrap();
    }
}
