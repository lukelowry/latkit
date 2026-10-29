---
'latkit': patch
---

Builds are reproducible, and the crates come out with the npm package again.

- Changed: the shaders link in the same order on every build, so a package rebuilt from a commit matches the one published from it. 0.4.0 reached npm only, since its release could not rebuild the same package to resume; this release publishes the crates too.
