use std::collections::HashMap;
use std::path::{Path, PathBuf};

// Paths were canonicalized and checked by safe_source before reaching this code.
pub(super) struct Source<'a> {
    pub id: &'a str,
    pub agent: &'a str,
    pub path: PathBuf,
    pub is_dir: bool,
}

fn is_codex_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(".codex"))
}

fn is_scanned_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
        .is_some_and(|name| name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
}

// Mirror findCodexFiles: every .codex directory restricts traversal to its
// sessions and archived_sessions children. Other directories are recursive.
fn codex_contains(parent: &Path, child: &Path, child_is_dir: bool) -> bool {
    let Ok(relative) = child.strip_prefix(parent) else {
        return false;
    };
    if !child_is_dir && !is_scanned_file(child) {
        return false;
    }
    let mut current = parent.to_path_buf();
    for component in relative.components() {
        if is_codex_dir(&current) {
            let name = component.as_os_str();
            // The Node scanner joins these exact names. Windows resolves their
            // casing insensitively; on other platforms require an exact match.
            let allowed = if cfg!(windows) {
                name.to_str().is_some_and(|value| {
                    value.eq_ignore_ascii_case("sessions")
                        || value.eq_ignore_ascii_case("archived_sessions")
                })
            } else {
                name == "sessions" || name == "archived_sessions"
            };
            if !allowed {
                return false;
            }
        }
        current.push(component.as_os_str());
    }
    true
}

/// Identify fully covered sources, not events with similar contents.
pub(super) fn covered_sources<'a>(sources: &'a [Source<'a>]) -> HashMap<&'a str, &'a str> {
    let mut covered = HashMap::new();
    for child in sources {
        let covering = sources
            .iter()
            .filter(|parent| {
                if parent.agent != child.agent || parent.id == child.id {
                    return false;
                }
                if parent.path == child.path {
                    // Break ties deterministically so duplicate sources cannot
                    // cover one another and accidentally suppress every scan.
                    return parent.id < child.id;
                }
                parent.agent == "codex"
                    && parent.is_dir
                    && codex_contains(&parent.path, &child.path, child.is_dir)
            })
            .min_by(|a, b| {
                a.path
                    .components()
                    .count()
                    .cmp(&b.path.components().count())
                    .then_with(|| a.id.cmp(b.id))
            });
        if let Some(parent) = covering {
            covered.insert(child.id, parent.id);
        }
    }
    covered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source<'a>(id: &'a str, agent: &'a str, path: &str, is_dir: bool) -> Source<'a> {
        Source {
            id,
            agent,
            path: PathBuf::from(path),
            is_dir,
        }
    }

    #[test]
    fn repeated_and_overlapping_sources_are_covered_by_the_directory() {
        let sources = [
            source("file1", "codex", "root/sessions/a.jsonl", false),
            source("file2", "codex", "root/sessions/a.jsonl", false),
            source("nested", "codex", "root/sessions", true),
            source("folder", "codex", "root", true),
            source("other", "grok-build", "root/sessions/a.jsonl", false),
            source("separate", "codex", "other/a.jsonl", false),
        ];
        let coverage = covered_sources(&sources);
        assert_eq!(coverage.get("file1"), Some(&"folder"));
        assert_eq!(coverage.get("file2"), Some(&"folder"));
        assert_eq!(coverage.get("nested"), Some(&"folder"));
        assert!(!coverage.contains_key("folder"));
        assert!(!coverage.contains_key("other"));
        assert!(!coverage.contains_key("separate"));
    }

    #[test]
    fn duplicate_files_have_one_survivor() {
        let sources = [
            source("b", "grok-build", "logs/grok.jsonl", false),
            source("a", "grok-build", "logs/grok.jsonl", false),
        ];
        let coverage = covered_sources(&sources);
        assert_eq!(coverage.get("b"), Some(&"a"));
        assert!(!coverage.contains_key("a"));
    }

    #[test]
    fn respects_codex_traversal_and_file_extensions() {
        let sources = [
            source("root", "codex", "home", true),
            source("live", "codex", "home/.codex/sessions/a.jsonl", false),
            source(
                "archive",
                "codex",
                "home/.codex/archived_sessions/a.jsonl.zst",
                false,
            ),
            source("other", "codex", "home/.codex/other/a.jsonl", false),
            source("not_jsonl", "codex", "home/log.zst", false),
        ];
        let coverage = covered_sources(&sources);
        assert_eq!(coverage.get("live"), Some(&"root"));
        assert_eq!(coverage.get("archive"), Some(&"root"));
        assert!(!coverage.contains_key("other"));
        assert!(!coverage.contains_key("not_jsonl"));
    }
}
