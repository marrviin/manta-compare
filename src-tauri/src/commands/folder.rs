use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Default directories skipped while walking (heavy / VCS / build output),
/// used when the frontend passes no explicit ignore list. Matched by exact
/// directory name at any depth. The frontend's settings normally override this.
const DEFAULT_IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".DS_Store"];

/// Bytes read from each end when size-equal files are content-compared.
const CHUNK: usize = 64 * 1024;

/// Options controlling how a directory diff treats file content differences.
/// When both normalization flags are off, files are compared byte-for-byte
/// (fast path). When either is on, size-equal text files are re-checked after
/// per-line normalization so whitespace/case-only changes count as equal.
#[derive(Clone, Copy, Default)]
struct DiffOptions {
    ignore_whitespace: bool,
    ignore_case: bool,
}

#[derive(serde::Serialize)]
pub struct DirEntryDiff {
    /// Relative path from the compared root, forward-slash separated.
    pub path: String,
    /// "added" (only right) | "removed" (only left) | "modified" | "equal".
    pub status: String,
    /// True for entries that are directories (on whichever side they exist).
    pub is_dir: bool,
    /// File byte size on each side (None when absent or a directory).
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    /// Last-modified time on each side, epoch seconds (None when absent).
    pub left_mtime: Option<i64>,
    pub right_mtime: Option<i64>,
}

/// A file/dir found while walking one side: size (files only), dir flag, mtime.
struct Node {
    is_dir: bool,
    size: u64,
    /// Last-modified time in epoch seconds, if available.
    mtime: Option<i64>,
}

/// Extract a file's modified time as epoch seconds (None if unavailable).
fn mtime_secs(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Recursively collect every file and directory under `root` into `out`, keyed
/// by forward-slash relative path. Directory names in `ignored` are pruned.
fn walk(root: &Path, base: &Path, ignored: &[String], out: &mut BTreeMap<String, Node>) {
    let entries = match fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() && ignored.iter().any(|d| d == name.as_ref()) {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let meta = entry.metadata().ok();
        let mtime = meta.as_ref().and_then(mtime_secs);
        if file_type.is_dir() {
            out.insert(
                rel,
                Node {
                    is_dir: true,
                    size: 0,
                    mtime,
                },
            );
            walk(root, &path, ignored, out);
        } else if file_type.is_file() {
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            out.insert(
                rel,
                Node {
                    is_dir: false,
                    size,
                    mtime,
                },
            );
        }
    }
}

/// Byte-compare two files that share a size. Reads in chunks from both ends so a
/// difference near either boundary is caught quickly; returns true when equal.
fn files_equal(a: &Path, b: &Path, size: u64) -> bool {
    let (mut fa, mut fb) = match (fs::File::open(a), fs::File::open(b)) {
        (Ok(x), Ok(y)) => (x, y),
        _ => return false,
    };
    let mut buf_a = vec![0u8; CHUNK];
    let mut buf_b = vec![0u8; CHUNK];
    let mut offset = 0u64;
    while offset < size {
        let want = CHUNK.min((size - offset) as usize);
        if fa.read_exact(&mut buf_a[..want]).is_err() || fb.read_exact(&mut buf_b[..want]).is_err()
        {
            return false;
        }
        if buf_a[..want] != buf_b[..want] {
            return false;
        }
        offset += want as u64;
        // For large files also probe from the tail after the first chunk to
        // catch trailing edits without reading the whole body twice.
        if offset == CHUNK as u64 && size > (CHUNK as u64) * 2 {
            let tail = size - CHUNK as u64;
            if fa.seek(SeekFrom::Start(tail)).is_err() || fb.seek(SeekFrom::Start(tail)).is_err() {
                return false;
            }
            if fa.read_exact(&mut buf_a[..CHUNK]).is_err()
                || fb.read_exact(&mut buf_b[..CHUNK]).is_err()
            {
                return false;
            }
            if buf_a[..] != buf_b[..] {
                return false;
            }
            // Resume sequential scan right after the head chunk.
            if fa.seek(SeekFrom::Start(offset)).is_err()
                || fb.seek(SeekFrom::Start(offset)).is_err()
            {
                return false;
            }
        }
    }
    true
}

/// Normalize a line for whitespace/case-insensitive comparison: trim ends,
/// collapse internal runs of whitespace to a single space, optionally lowercase.
fn normalize_line(line: &str, opts: DiffOptions) -> String {
    let mut s = line.to_string();
    if opts.ignore_whitespace {
        s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    if opts.ignore_case {
        s = s.to_lowercase();
    }
    s
}

/// Compare two files as text after per-line normalization (used only when an
/// ignore flag is on and the byte compare already found them unequal). Reads
/// both fully; returns true when every normalized line matches. Non-UTF-8 or
/// unreadable files fall back to "not equal" (keep them flagged as modified).
fn files_equal_normalized(a: &Path, b: &Path, opts: DiffOptions) -> bool {
    let (ba, bb) = match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => (x, y),
        _ => return false,
    };
    let (ta, tb) = match (String::from_utf8(ba), String::from_utf8(bb)) {
        (Ok(x), Ok(y)) => (x, y),
        _ => return false, // binary / non-UTF-8: don't claim equal.
    };
    let mut la = ta.lines();
    let mut lb = tb.lines();
    loop {
        match (la.next(), lb.next()) {
            (Some(x), Some(y)) => {
                if normalize_line(x, opts) != normalize_line(y, opts) {
                    return false;
                }
            }
            (None, None) => return true,
            _ => return false, // different line counts.
        }
    }
}

/// Compare two directory trees and return a flat, path-sorted diff list.
///
/// Every relative path present on either side is emitted. Files present on one
/// side only are "removed"/"added"; files on both are "equal" or "modified"
/// (size mismatch, or byte content differs when sizes match). Directories are
/// emitted only when they exist on a single side (whole-tree add/remove); shared
/// intermediate directories are left for the frontend to synthesize from paths.
///
/// `ignore_dirs` overrides the built-in prune list (empty -> use defaults so an
/// older frontend still works). `ignore_whitespace`/`ignore_case` re-check
/// byte-unequal text files after per-line normalization.
#[tauri::command]
pub fn diff_dirs(
    left: String,
    right: String,
    ignore_dirs: Option<Vec<String>>,
    ignore_whitespace: Option<bool>,
    ignore_case: Option<bool>,
) -> Result<Vec<DirEntryDiff>, String> {
    let ignored: Vec<String> = match ignore_dirs {
        Some(v) if !v.is_empty() => v,
        _ => DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect(),
    };
    let opts = DiffOptions {
        ignore_whitespace: ignore_whitespace.unwrap_or(false),
        ignore_case: ignore_case.unwrap_or(false),
    };
    let left_root = Path::new(&left);
    let right_root = Path::new(&right);
    // Allow one side to be empty (""), meaning "not picked yet": every entry on
    // the other side is then reported as a pure add/remove so a single dropped
    // folder can render immediately before the other side is chosen.
    let has_left = !left.is_empty();
    let has_right = !right.is_empty();
    if has_left && !left_root.is_dir() {
        return Err(format!("Not a directory: {left}"));
    }
    if has_right && !right_root.is_dir() {
        return Err(format!("Not a directory: {right}"));
    }

    let mut left_map = BTreeMap::new();
    let mut right_map = BTreeMap::new();
    if has_left {
        walk(left_root, left_root, &ignored, &mut left_map);
    }
    if has_right {
        walk(right_root, right_root, &ignored, &mut right_map);
    }

    // Union of all relative paths, sorted (BTreeMap keys are already ordered).
    let mut paths: Vec<&String> = left_map.keys().collect();
    for k in right_map.keys() {
        if !left_map.contains_key(k) {
            paths.push(k);
        }
    }
    paths.sort();

    let mut out = Vec::with_capacity(paths.len());
    for rel in paths {
        let l = left_map.get(rel);
        let r = right_map.get(rel);
        // File size columns only apply to files; directories carry mtime only.
        let file_size = |n: &Node| if n.is_dir { None } else { Some(n.size) };
        match (l, r) {
            (Some(a), None) => out.push(DirEntryDiff {
                path: rel.clone(),
                status: "removed".into(),
                is_dir: a.is_dir,
                left_size: file_size(a),
                right_size: None,
                left_mtime: a.mtime,
                right_mtime: None,
            }),
            (None, Some(b)) => out.push(DirEntryDiff {
                path: rel.clone(),
                status: "added".into(),
                is_dir: b.is_dir,
                left_size: None,
                right_size: file_size(b),
                left_mtime: None,
                right_mtime: b.mtime,
            }),
            (Some(a), Some(b)) => {
                if a.is_dir || b.is_dir {
                    // Shared directory: emit as equal so it carries per-side
                    // mtime for the columns; color is still derived on the
                    // frontend from whether any descendant differs.
                    out.push(DirEntryDiff {
                        path: rel.clone(),
                        status: "equal".into(),
                        is_dir: true,
                        left_size: None,
                        right_size: None,
                        left_mtime: a.mtime,
                        right_mtime: b.mtime,
                    });
                    continue;
                }
                let lp = left_root.join(rel);
                let rp = right_root.join(rel);
                // Fast path: same size + byte-identical. Otherwise, when an
                // ignore flag is on, re-check as normalized text (whitespace/
                // case-only diffs then count as equal, even across sizes).
                let byte_equal = a.size == b.size && files_equal(&lp, &rp, a.size);
                let equal = byte_equal
                    || ((opts.ignore_whitespace || opts.ignore_case)
                        && files_equal_normalized(&lp, &rp, opts));
                out.push(DirEntryDiff {
                    path: rel.clone(),
                    status: if equal {
                        "equal".into()
                    } else {
                        "modified".into()
                    },
                    is_dir: false,
                    left_size: Some(a.size),
                    right_size: Some(b.size),
                    left_mtime: a.mtime,
                    right_mtime: b.mtime,
                });
            }
            (None, None) => {}
        }
    }
    Ok(out)
}

/// Recursively copy a directory tree from `src` to `dst`, creating `dst` and any
/// missing parents. Default-ignored directory names are skipped so copies stay
/// in step with what the diff walk reported. (Copy uses the built-in defaults
/// rather than the user list — copying is an explicit per-entry action where
/// pruning heavy build dirs is still the safe default.)
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if file_type.is_dir() && DEFAULT_IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy a file or directory from `src` to `dst`, overwriting an existing target.
///
/// Used by the folder-compare view to sync one side's entry onto the other:
/// `dst` is the mirrored absolute path on the opposite root. Parent directories
/// are created as needed; directories are copied recursively.
#[tauri::command]
pub fn copy_path(src: String, dst: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dst_path = Path::new(&dst);
    if !src_path.exists() {
        return Err(format!("Source does not exist: {src}"));
    }
    if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create {parent:?}: {e}"))?;
    }
    if src_path.is_dir() {
        copy_dir_all(src_path, dst_path).map_err(|e| format!("Failed to copy dir {src}: {e}"))?;
    } else {
        fs::copy(src_path, dst_path).map_err(|e| format!("Failed to copy {src}: {e}"))?;
    }
    Ok(())
}

/// Move a file or directory to the OS recycle bin / trash (not a permanent
/// delete). Used by the folder-compare context menu so a mistaken delete can be
/// recovered from the system trash.
#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    trash::delete(p).map_err(|e| format!("Failed to move to trash {path}: {e}"))
}

/// Classify a filesystem path so the UI can route a dropped item correctly:
/// `"dir"` for directories, `"file"` for files, `"missing"` when it doesn't exist.
#[tauri::command]
pub fn path_kind(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    match fs::metadata(p) {
        Ok(meta) if meta.is_dir() => Ok("dir".to_string()),
        Ok(_) => Ok("file".to_string()),
        Err(_) => Ok("missing".to_string()),
    }
}

/// Rename (move within the same filesystem) a file or directory. Used by the
/// folder-compare context menu's "rename" action; refuses to clobber a
/// different existing target. Case-only renames on case-insensitive filesystems
/// (macOS default) still pass: src and dst then canonicalize to the same file.
#[tauri::command]
pub fn rename_path(src: String, dst: String) -> Result<(), String> {
    let src_path = Path::new(&src);
    let dst_path = Path::new(&dst);
    if !src_path.exists() {
        return Err(format!("Source does not exist: {src}"));
    }
    if dst_path.exists() {
        let same = match (fs::canonicalize(src_path), fs::canonicalize(dst_path)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            return Err(format!("Target already exists: {dst}"));
        }
    }
    fs::rename(src_path, dst_path).map_err(|e| format!("Failed to rename {src}: {e}"))
}

/// Create a single directory (its parent must already exist). Used by the
/// folder-compare context menu's "new folder" action.
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("Path already exists: {path}"));
    }
    fs::create_dir(p).map_err(|e| format!("Failed to create dir {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Per-test temp workspace under the OS temp dir; caller removes it when done.
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "manta-compare-test-{}-{}-{tag}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalize_line_applies_flags_independently() {
        let ws = DiffOptions { ignore_whitespace: true, ignore_case: false };
        assert_eq!(normalize_line("  a   b  ", ws), "a b");
        let cs = DiffOptions { ignore_whitespace: false, ignore_case: true };
        assert_eq!(normalize_line("Hello WORLD", cs), "hello world");
        let both = DiffOptions { ignore_whitespace: true, ignore_case: true };
        assert_eq!(normalize_line("  A   B ", both), "a b");
        // Flags off: the line passes through untouched.
        assert_eq!(normalize_line("  A  b ", DiffOptions::default()), "  A  b ");
    }

    #[test]
    fn walk_prunes_ignored_dirs_and_keys_by_forward_slash() {
        let root = temp_root("walk");
        fs::create_dir_all(root.join("sub/deep/node_modules")).unwrap();
        fs::create_dir_all(root.join("sub/deep/keep")).unwrap();
        fs::write(root.join("a.txt"), "abc").unwrap();
        fs::write(root.join("sub/deep/keep/b.txt"), "b").unwrap();
        fs::write(root.join("sub/deep/node_modules/x.txt"), "x").unwrap();

        let ignored = vec!["node_modules".to_string()];
        let mut out = BTreeMap::new();
        walk(&root, &root, &ignored, &mut out);

        let keys: Vec<&String> = out.keys().collect();
        assert!(keys.contains(&&"a.txt".to_string()));
        assert!(keys.contains(&&"sub/deep/keep/b.txt".to_string()));
        // Intermediate directories are recorded so unions see tree adds/removes.
        assert!(out.get("sub").unwrap().is_dir);
        assert!(out.get("sub/deep").unwrap().is_dir);
        // Ignored pruned at any depth; relative keys use forward slashes.
        assert!(!keys.iter().any(|k| k.contains("node_modules")));
        assert_eq!(out.get("a.txt").unwrap().size, 3);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn diff_dirs_reports_added_removed_modified_equal() {
        let l = temp_root("diff-l");
        let r = temp_root("diff-r");
        fs::create_dir_all(l.join("shared")).unwrap();
        fs::create_dir_all(r.join("shared")).unwrap();
        fs::write(l.join("shared/same.txt"), "same").unwrap();
        fs::write(r.join("shared/same.txt"), "same").unwrap();
        fs::write(l.join("mod.txt"), "one").unwrap();
        fs::write(r.join("mod.txt"), "two").unwrap();
        fs::write(l.join("gone.txt"), "x").unwrap();
        fs::write(r.join("new.txt"), "y").unwrap();

        let diffs = diff_dirs(
            l.to_string_lossy().into(),
            r.to_string_lossy().into(),
            None,
            None,
            None,
        )
        .unwrap();
        let get = |p: &str| diffs.iter().find(|d| d.path == p).unwrap();
        assert_eq!(get("mod.txt").status, "modified");
        assert_eq!(get("gone.txt").status, "removed");
        assert_eq!(get("new.txt").status, "added");
        assert_eq!(get("shared/same.txt").status, "equal");
        // Shared directories carry equal status + sizes nulled out.
        let shared = get("shared");
        assert!(shared.is_dir);
        assert_eq!(shared.status, "equal");
        assert_eq!(shared.left_size, None);
        assert_eq!(get("mod.txt").left_size, Some(3));

        fs::remove_dir_all(&l).unwrap();
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn diff_dirs_prunes_default_ignored_dirs_when_list_is_none_or_empty() {
        let l = temp_root("default-ignore-l");
        let r = temp_root("default-ignore-r");
        for root in [&l, &r] {
            fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
            fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
            fs::write(root.join("keep.txt"), "k").unwrap();
        }
        for ignore_dirs in [None, Some(Vec::new())] {
            let diffs = diff_dirs(
                l.to_string_lossy().into(),
                r.to_string_lossy().into(),
                ignore_dirs,
                None,
                None,
            )
            .unwrap();
            assert_eq!(diffs.len(), 1, "only keep.txt survives");
            assert_eq!(diffs[0].path, "keep.txt");
        }
        fs::remove_dir_all(&l).unwrap();
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn diff_dirs_ignore_flags_make_normalized_files_equal() {
        let l = temp_root("flags-l");
        let r = temp_root("flags-r");
        // Whitespace-only diff with different sizes: fast byte path says unequal.
        fs::write(l.join("ws.txt"), "a  b").unwrap();
        fs::write(r.join("ws.txt"), "a b").unwrap();
        // Case-only diff, same size: byte path says unequal too.
        fs::write(l.join("case.txt"), "Hello").unwrap();
        fs::write(r.join("case.txt"), "hello").unwrap();

        let left: String = l.to_string_lossy().into();
        let right: String = r.to_string_lossy().into();
        let without = diff_dirs(left.clone(), right.clone(), None, None, None).unwrap();
        assert!(without.iter().all(|d| d.status == "modified"));

        let ws =
            diff_dirs(left.clone(), right.clone(), None, Some(true), None).unwrap();
        let case = diff_dirs(left.clone(), right, None, None, Some(true)).unwrap();
        assert_eq!(ws.iter().find(|d| d.path == "ws.txt").unwrap().status, "equal");
        assert_eq!(case.iter().find(|d| d.path == "case.txt").unwrap().status, "equal");

        fs::remove_dir_all(&l).unwrap();
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn diff_dirs_empty_side_means_pure_add_remove_and_non_dir_errors() {
        let r = temp_root("one-side");
        fs::write(r.join("a.txt"), "a").unwrap();

        let diffs = diff_dirs(String::new(), r.to_string_lossy().into(), None, None, None).unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].status, "added");

        assert!(diff_dirs(r.join("a.txt").to_string_lossy().to_string(), "/definitely/not/a/dir".into(), None, None, None).is_err());

        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn path_kind_classifies_dir_file_missing() {
        let root = temp_root("path-kind");
        fs::write(root.join("f.txt"), "x").unwrap();
        assert_eq!(path_kind(root.to_string_lossy().into()).unwrap(), "dir");
        assert_eq!(path_kind(root.join("f.txt").to_string_lossy().into()).unwrap(), "file");
        assert_eq!(
            path_kind(root.join("nope.txt").to_string_lossy().into()).unwrap(),
            "missing"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_dir_and_rename_path_basics() {
        let root = temp_root("create-rename");
        // Parent must exist for the single-level create_dir.
        assert!(create_dir(root.join("sub/new").to_string_lossy().into()).is_err());
        fs::create_dir_all(root.join("sub")).unwrap();
        let sub = root.join("sub");
        create_dir(sub.join("new").to_string_lossy().into()).unwrap();
        assert!(sub.join("new").is_dir());
        // Creating over an existing path fails.
        assert!(create_dir(sub.join("new").to_string_lossy().into()).is_err());

        fs::write(sub.join("new/a.txt"), "x").unwrap();
        let a = sub.join("new/a.txt").to_string_lossy().to_string();
        let b = sub.join("new/b.txt").to_string_lossy().to_string();
        rename_path(a.clone(), b.clone()).unwrap();
        assert!(sub.join("new/b.txt").is_file());
        assert!(!sub.join("new/a.txt").exists());
        // Renaming onto a different existing target is refused.
        fs::write(sub.join("new/other.txt"), "y").unwrap();
        let other = sub.join("new/other.txt").to_string_lossy().to_string();
        assert!(rename_path(b.clone(), other).is_err());
        // Case-only rename still works (same file on case-insensitive fs; plain
        // rename on case-sensitive ones since the target doesn't exist).
        let b_upper = sub.join("new/B.txt").to_string_lossy().to_string();
        rename_path(b, b_upper).unwrap();
        assert!(sub.join("new/B.txt").is_file());
        // Missing source errors.
        assert!(rename_path(sub.join("new/gone.txt").to_string_lossy().into(), a).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
