use super::{safe_source, source_coverage::codex_contains};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

pub(super) const AUTO_CODEX: &str = "auto-codex";
pub(super) const AUTO_IDS: [&str; 3] = [AUTO_CODEX, "auto-grok-build", "auto-opencode"];
const CODEX_DIRS: [&str; 2] = ["sessions", "archived_sessions"];

pub(super) struct AutomaticSource {
    pub id: &'static str,
    pub agent: &'static str,
    pub path: PathBuf,
}

pub(super) fn discover() -> Vec<AutomaticSource> {
    candidates(super::super::user_home().ok().as_deref(), |name| {
        std::env::var_os(name)
    })
    .into_iter()
    .filter_map(|mut source| {
        if source.agent == "grok-build" {
            let sessions = source.path.join("sessions");
            source.path = if safe_source(&sessions, "grok-build").is_ok_and(|dir| dir.is_dir()) {
                sessions
            } else {
                source.path.join("logs").join("unified.jsonl")
            };
        }
        let path = safe_source(&source.path, source.agent).ok()?;
        let valid = if source.id == AUTO_CODEX {
            path.is_dir()
                && CODEX_DIRS.iter().any(|name| {
                    safe_source(&path.join(name), "codex").is_ok_and(|dir| dir.is_dir())
                })
        } else {
            path.is_file() || source.agent == "grok-build" && path.is_dir()
        };
        source.path = path;
        valid.then_some(source)
    })
    .collect()
}

fn candidates(home: Option<&Path>, env: impl Fn(&str) -> Option<OsString>) -> Vec<AutomaticSource> {
    let configured = |name| env(name).filter(|value| !value.to_string_lossy().trim().is_empty());
    let absolute = |value: OsString| {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            #[cfg(windows)]
            if !matches!(
                path.components().next(),
                Some(Component::Prefix(prefix)) if matches!(prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))
            ) {
                return None;
            }
            Some(path)
        } else if let Ok(relative) = path.strip_prefix("~") {
            home.map(|root| root.join(relative))
        } else {
            None
        }
    };
    let agent_home = |name, default: &str| match configured(name) {
        Some(path) => absolute(path),
        None => home.map(|home| home.join(default)),
    };
    let data = match configured("XDG_DATA_HOME") {
        Some(path) => absolute(path),
        None => home.map(|home| home.join(".local").join("share")),
    }
    .map(|root| root.join("opencode"));
    let opencode = match configured("OPENCODE_DB") {
        Some(path) if path == ":memory:" => None,
        Some(path) => {
            let relative = Path::new(&path);
            if relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            {
                data.map(|root| root.join(relative))
            } else {
                absolute(path)
            }
        }
        None => data.map(|root| root.join("opencode.db")),
    };
    [
        (AUTO_CODEX, "codex", agent_home("CODEX_HOME", ".codex")),
        (
            "auto-grok-build",
            "grok-build",
            agent_home("GROK_HOME", ".grok"),
        ),
        ("auto-opencode", "opencode", opencode),
    ]
    .into_iter()
    .filter_map(|(id, agent, path)| path.map(|path| AutomaticSource { id, agent, path }))
    .collect()
}

pub(super) fn covers(root: &Path, path: &Path, agent: &str, codex_home: bool) -> bool {
    if root == path {
        return true;
    }
    if !root.is_dir() {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if agent == "codex" {
        if codex_home
            && !relative.components().next().is_some_and(|child| {
                CODEX_DIRS
                    .iter()
                    .any(|name| child.as_os_str().eq_ignore_ascii_case(name))
            })
        {
            return false;
        }
        return codex_contains(root, path, path.is_dir());
    }
    agent == "grok-build"
        && (path.is_dir()
            || path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("updates.jsonl")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_history_locations_and_overrides_replace_them() {
        let home = std::env::temp_dir().join("usage-discovery-example");
        let defaults = candidates(Some(&home), |_| None);
        assert_eq!(defaults[0].path, home.join(".codex"));
        assert_eq!(defaults[1].path, home.join(".grok"));
        assert_eq!(
            defaults[2].path,
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db")
        );

        let custom = home.join("custom");
        let overridden = candidates(Some(&home), |name| match name {
            "CODEX_HOME" => Some(custom.clone().into_os_string()),
            "GROK_HOME" => Some("~/grok-history".into()),
            "XDG_DATA_HOME" => Some(custom.clone().into_os_string()),
            "OPENCODE_DB" => Some("preview.db".into()),
            _ => None,
        });
        assert_eq!(overridden[0].path, custom);
        assert_eq!(overridden[1].path, home.join("grok-history"));
        assert_eq!(
            overridden[2].path,
            custom.join("opencode").join("preview.db")
        );
        assert!(!candidates(Some(&home), |name| (name == "OPENCODE_DB")
            .then(|| ":memory:".into()))
        .iter()
        .any(|source| source.agent == "opencode"));
    }
}
