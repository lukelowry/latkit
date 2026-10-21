//! Where what a document names lies: a URL or a path relative to the document's own.

/// `url` resolved against `base`, the URL or path of the document naming it: as it is when absolute
/// (a scheme, a `data:` URL, a drive or a root of a path), from `base`'s origin when it starts with
/// `/` and `base` is a URL, else in `base`'s directory.
pub(crate) fn resolve(base: &str, url: &str) -> String {
    let drive = |s: &str| s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic();
    if drive(url) || url.starts_with('\\') {
        return url.to_owned();
    }
    if !drive(base)
        && let Ok(base) = url::Url::parse(base)
    {
        // Resolve templates before substitution, preserving the difference between literal braces
        // and percent-escaped braces. Choose a marker absent from both URLs to avoid collisions.
        let mut marker = "__latkit_template__".to_owned();
        while url.contains(&marker) || base.as_str().contains(&marker) {
            marker.push('_');
        }
        let (open, close) = (format!("{marker}open"), format!("{marker}close"));
        let template = url.replace('{', &open).replace('}', &close);
        if let Ok(resolved) = base.join(&template) {
            return resolved.as_str().replace(&open, "{").replace(&close, "}");
        }
    }
    if url::Url::parse(url).is_ok() || url.starts_with('/') {
        return url.to_owned();
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
    }
}
