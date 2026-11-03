---
'latkit': patch
---

Where depth varies, lines and markers no longer draw dark outlines where they cross, or stripes where they overlap.

- Fixed: a pixel that a line or marker covers only in part blends over what lies behind it, not over the background. Since 0.5.1, lines thinner than three device pixels hid what lay behind the pixels they partly covered, which drew dark outlines where lines crossed and stripes where they overlapped.
- Changed: where depth varies, the opaque pixels of every mark draw first and keep their depth, and every other pixel then blends over them in mark order. A line or marker too thin to cover a pixel fully no longer hides what lies behind it, but it still draws over every opaque mark behind it, whatever the order of the marks. Faces and areas also lie under every pixel that blends.
