//! Windows CNG SHA-256: https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcrypthash
//! NEOVERENÉ: replacing a verified file between verification and process launch is a race.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../usage-service/manifest.json"
));

#[cfg(windows)]
fn digest(bytes: &[u8]) -> Result<String, String> {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    type Handle = *mut c_void;
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptOpenAlgorithmProvider(
            handle: *mut Handle,
            algorithm: *const u16,
            implementation: *const u16,
            flags: u32,
        ) -> i32;
        fn BCryptHash(
            algorithm: Handle,
            secret: *mut u8,
            secret_len: u32,
            input: *mut u8,
            input_len: u32,
            output: *mut u8,
            output_len: u32,
        ) -> i32;
        fn BCryptCloseAlgorithmProvider(algorithm: Handle, flags: u32) -> i32;
    }
    let input_len = u32::try_from(bytes.len()).map_err(|_| "Sidecar artifact too large")?;
    let algorithm: Vec<u16> = "SHA256\0".encode_utf16().collect();
    let mut handle: Handle = null_mut();
    // SAFETY: pointers refer to valid buffers for the duration of each CNG call.
    let open = unsafe { BCryptOpenAlgorithmProvider(&mut handle, algorithm.as_ptr(), null(), 0) };
    if open != 0 {
        return Err("Hash provider unavailable".into());
    }
    let mut output = [0u8; 32];
    // BCryptHash does not modify its input buffer, according to the API contract.
    let status = unsafe {
        BCryptHash(
            handle,
            null_mut(),
            0,
            bytes.as_ptr() as *mut u8,
            input_len,
            output.as_mut_ptr(),
            output.len() as u32,
        )
    };
    // SAFETY: handle was created successfully and is no longer used afterward.
    let _ = unsafe { BCryptCloseAlgorithmProvider(handle, 0) };
    if status != 0 {
        return Err("Artifact hash failed".into());
    }
    Ok(output.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(not(windows))]
fn digest(_bytes: &[u8]) -> Result<String, String> {
    Err("Usage sidecar is supported on Windows only".into())
}

fn verify_dir(
    root: &Path,
    dir: &Path,
    expected: &mut HashMap<String, String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|_| "Sidecar artifacts unavailable")? {
        let entry = entry.map_err(|_| "Sidecar artifacts unavailable")?;
        let path: PathBuf = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "Sidecar artifacts unavailable")?;
        if meta.file_type().is_symlink() {
            return Err("Linked sidecar artifact denied".into());
        }
        if meta.is_dir() {
            verify_dir(root, &path, expected)?;
            continue;
        }
        if !meta.is_file() || meta.len() > 256 * 1024 * 1024 {
            return Err("Invalid sidecar artifact".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Invalid sidecar artifact")?;
        let key = relative
            .to_str()
            .ok_or("Invalid sidecar artifact")?
            .replace('\\', "/");
        if key == "manifest.json" {
            continue;
        }
        let hash = expected.remove(&key).ok_or("Unexpected sidecar artifact")?;
        let bytes = std::fs::read(&path).map_err(|_| "Sidecar artifact unavailable")?;
        if digest(&bytes)? != hash {
            return Err("Sidecar integrity check failed".into());
        }
    }
    Ok(())
}

pub fn verify(root: &Path) -> Result<(), String> {
    let root_metadata =
        std::fs::symlink_metadata(root).map_err(|_| "Sidecar artifacts unavailable")?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Invalid sidecar directory".into());
    }
    let mut expected: HashMap<String, String> =
        serde_json::from_str(MANIFEST).map_err(|_| "Sidecar manifest invalid")?;
    if !expected.contains_key("node.exe") || !expected.contains_key("main.cjs") {
        return Err("Sidecar manifest incomplete".into());
    }
    verify_dir(root, root, &mut expected)?;
    if !expected.is_empty() {
        return Err("Sidecar artifact missing".into());
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn staged_artifacts_match_embedded_manifest() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../usage-service");
        super::verify(&root).unwrap();
    }

    #[test]
    fn sha256_matches_known_synthetic_vector() {
        assert_eq!(
            super::digest(b"abc").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn rejects_modified_synthetic_artifact() {
        let root = std::env::current_dir()
            .unwrap()
            .join(format!(".lab-m4-integrity-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let artifact = root.join("synthetic.txt");
        std::fs::write(&artifact, b"abc").unwrap();
        let mut expected = std::collections::HashMap::from([(
            "synthetic.txt".to_owned(),
            super::digest(b"abc").unwrap(),
        )]);
        assert!(super::verify_dir(&root, &root, &mut expected).is_ok());
        std::fs::write(&artifact, b"changed").unwrap();
        let mut expected = std::collections::HashMap::from([(
            "synthetic.txt".to_owned(),
            super::digest(b"abc").unwrap(),
        )]);
        assert!(super::verify_dir(&root, &root, &mut expected).is_err());
        std::fs::remove_file(artifact).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
