//! Where what a document names lies: a URL or a path relative to the document's own.

/// `url` resolved against `base`, the URL or path of the document naming it: as it is when absolute
/// (a scheme, a `data:` URL, a drive or a root of a path), from `base`'s origin when it starts with
/// `/` and `base` is a URL, else in `base`'s directory. Against a URL it resolves as RFC 3986 says,
/// its host as written and a template's braces kept.
pub(crate) fn resolve(base: &str, url: &str) -> String {
    let drive = |s: &str| s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic();
    if drive(url) || url.starts_with('\\') || scheme(url).is_some() {
        return url.to_owned();
    }
    let Some(scheme) = scheme(base).filter(|_| !drive(base)) else {
        if url.starts_with('/') {
            return url.to_owned();
        }
        return match base.rfind(['/', '\\']) {
            Some(at) => format!("{}{url}", &base[..=at]),
            None => url.to_owned(),
        };
    };
    if let Some(rest) = url.strip_prefix("//") {
        return format!("{scheme}://{}", escaped(rest));
    }
    let after = &base[scheme.len() + 1..];
    let (origin, path) = match after.strip_prefix("//") {
        Some(rest) => {
            let (authority, path) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
            (format!("{scheme}://{authority}"), if path.is_empty() { "/" } else { path })
        }
        None => (format!("{scheme}:"), after),
    };
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let merged = if url.starts_with('/') {
        url.to_owned()
    } else {
        format!("{}{url}", &path[..path.rfind('/').map_or(0, |at| at + 1)])
    };
    format!("{origin}{}", escaped(&without_dots(&merged)))
}

/// The path a `file:` URL names, its escapes decoded, as URLs read it: backslashes are slashes, and a
/// drive where the host goes starts the path. `None` where it names another host's file or is no
/// file URL.
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub(crate) fn file_path(url: &str) -> Option<std::path::PathBuf> {
    let rest = url.strip_prefix("file:")?.replace('\\', "/");
    let drive = |s: &str| s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic();
    let path = match rest.strip_prefix("//") {
        Some(rest) if drive(rest) => rest,
        Some(rest) => {
            let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
                return None;
            }
            path
        }
        None => &rest,
    };
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let mut bytes = Vec::with_capacity(path.len());
    let mut at = 0;
    while at < path.len() {
        let byte = path.as_bytes()[at];
        if byte == b'%' {
            bytes.push(u8::from_str_radix(path.get(at + 1..at + 3)?, 16).ok()?);
            at += 3;
        } else {
            bytes.push(byte);
            at += 1;
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    // A drive's path: `/C:/data` is `C:/data`.
    let drive = path.as_bytes();
    if drive.len() >= 3 && drive[0] == b'/' && drive[1].is_ascii_alphabetic() && drive[2] == b':' {
        return Some(path[1..].into());
    }
    Some(path.into())
}

/// `url`'s scheme: two or more letters, digits, `+`, `-`, or `.` from a letter up to a `:`, so a
/// drive has none.
fn scheme(url: &str) -> Option<&str> {
    let scheme = &url[..url.find(':')?];
    (scheme.len() > 1
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)))
    .then_some(scheme)
}

/// `path` without its `.` and `..` segments, as RFC 3986 removes them; its query and fragment kept.
fn without_dots(path: &str) -> String {
    let (path, rest) = path.split_at(path.find(['?', '#']).unwrap_or(path.len()));
    let segments: Vec<&str> = path.split('/').collect();
    let mut kept: Vec<&str> = Vec::new();
    for (i, &segment) in segments.iter().enumerate() {
        match segment {
            "." => {}
            ".." => {
                if kept.len() > 1 {
                    kept.pop();
                }
            }
            segment => kept.push(segment),
        }
        // A last `.` or `..` names a directory.
        if i + 1 == segments.len() && matches!(segment, "." | "..") {
            kept.push("");
        }
    }
    format!("{}{rest}", kept.join("/"))
}

/// `text` with what a URL cannot hold as written percent-encoded: spaces, quotes, angle brackets,
/// backticks, controls, and every byte past ASCII. A template's braces stay.
fn escaped(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_graphic() && !b"\"<>`".contains(&byte) {
            out.push(byte as char);
        } else {
            out.extend(['%', char::from(HEX[usize::from(byte >> 4)]), char::from(HEX[usize::from(byte & 15)])]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn names_resolve_against_their_document() {
        assert_eq!(resolve("https://a.b/c/d.json", "t/{z}.pbf"), "https://a.b/c/t/{z}.pbf");
        assert_eq!(resolve("https://a.b/c/d.json", "t/%7Bz%7D/{z}.pbf"), "https://a.b/c/t/%7Bz%7D/{z}.pbf");
        assert_eq!(resolve("https://a.b/c/d.json", "/t.pbf"), "https://a.b/t.pbf");
        assert_eq!(resolve("https://a.b/c/d.json", "https://x/t.pbf"), "https://x/t.pbf");
        assert_eq!(resolve("https://x/data/grid.json", "v.f32"), "https://x/data/v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "v.f32"), "C:\\data\\v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "D:\\v.f32"), "D:\\v.f32");
        assert_eq!(resolve("/srv/grid.json", "/v.f32"), "/v.f32");
        assert_eq!(resolve("", "v.f32"), "v.f32");
        assert_eq!(resolve("https://a.b/c/d.json?q=/elsewhere/", "../v.f32"), "https://a.b/v.f32");
        assert_eq!(resolve("https://a.b/c/d.json", "//cdn.example/v.f32"), "https://cdn.example/v.f32");
        assert_eq!(resolve("file:///C:/data/grid.json", "a b.f32"), "file:///C:/data/a%20b.f32");
        assert_eq!(resolve("https://a.b", "t.pbf"), "https://a.b/t.pbf");
        assert_eq!(resolve("https://a.b/c/", "./d/../e.pbf?x=1"), "https://a.b/c/e.pbf?x=1");
        assert_eq!(resolve("data/grid.json", "data:application/json,{}"), "data:application/json,{}");
    }

    #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
    #[test]
    fn file_urls_name_their_paths() {
        use super::file_path;
        use std::path::PathBuf;
        assert_eq!(file_path("file:///C:/data/a%20b.f32"), Some(PathBuf::from("C:/data/a b.f32")));
        assert_eq!(file_path("file:///srv/grid.json"), Some(PathBuf::from("/srv/grid.json")));
        assert_eq!(file_path("file://localhost/srv/grid.json?x"), Some(PathBuf::from("/srv/grid.json")));
        assert_eq!(file_path("file://C:\\data\\grid.json"), Some(PathBuf::from("C:/data/grid.json")));
        assert_eq!(file_path("file://elsewhere/srv/grid.json"), None);
        assert_eq!(file_path("https://a.b/c"), None);
    }
}
