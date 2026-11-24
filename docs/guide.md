# Guide

```{toctree}
:maxdepth: 2

data
scenes
views
pictures-and-video
formats
deploying
in-rust
```

```{raw} html
<script>
  // Follow bookmarks from the original single-page guide.
  if (location.hash) {
    const links = document.querySelectorAll('.toctree-wrapper a');
    for (const link of links) {
      const page = new URL(link.href).pathname.split('/').pop();
      if (link.hash === location.hash || page === location.hash.slice(1) + '.html') {
        location.replace(link.href);
        break;
      }
    }
  }
</script>
```
