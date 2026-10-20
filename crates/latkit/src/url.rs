//! Where what a document names lies: a URL or a path relative to the document's own.

/// `url` resolved against `base`, the URL or path of the document naming it: as it is when absolute
/// (a scheme, a `data:` URL, a drive or a root of a path), from `base`'s origin when it starts with
/// `/` and `base` is a URL, else in `base`'s directory.
pub(crate) fn resolve(base: &str, url: &str) -> String {
    let drive = url.as_bytes().get(1) == Some(&b':') && url.as_bytes()[0].is_ascii_alphabetic();
    if url.contains("://") || url.starts_with("data:") || url.starts_with('\\') || drive {
        return url.to_owned();
    }
    if let Some(rest) = url.strip_prefix('/') {
        let Some(scheme) = base.find("://") else { return url.to_owned() };
        let origin = base[scheme + 3..].find('/').map_or(base.len(), |k| scheme + 3 + k);
        return format!("{}/{rest}", &base[..origin]);
    }
    match base.rfind(['/', '\\']) {
        Some(at) => format!("{}{url}", &base[..=at]),
        None => url.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn names_resolve_against_their_document() {
        assert_eq!(resolve("https://a.b/c/d.json", "t/{z}.pbf"), "https://a.b/c/t/{z}.pbf");
        assert_eq!(resolve("https://a.b/c/d.json", "/t.pbf"), "https://a.b/t.pbf");
        assert_eq!(resolve("https://a.b/c/d.json", "https://x/t.pbf"), "https://x/t.pbf");
        assert_eq!(resolve("https://x/data/grid.json", "v.f32"), "https://x/data/v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "v.f32"), "C:\\data\\v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "D:\\v.f32"), "D:\\v.f32");
        assert_eq!(resolve("/srv/grid.json", "/v.f32"), "/v.f32");
        assert_eq!(resolve("", "v.f32"), "v.f32");
    }
}
