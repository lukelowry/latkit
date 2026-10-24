"""Sphinx configuration: Furo in latkit's own colors, MyST pages, and checked-in references."""

import json
from pathlib import Path

HERE = Path(__file__).parent
project = "latkit"
author = "Luke Lowery"
copyright = "2026, Luke Lowery"
release = json.loads((HERE.parent / "npm/package.json").read_text())["version"]

extensions = ["myst_parser", "sphinx_copybutton"]
exclude_patterns = ["_build", ".venv", "gallery"]
myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 3

copybutton_prompt_text = r"^\$ "
copybutton_prompt_is_regexp = True

# latkit's default themes, as `cargo test -p latkit --test schema` checks them.
THEMES = json.loads((HERE / "_static/theme.json").read_text())
# Text and rules, from ink to faint: the same in every latkit and companion page.
NEUTRAL = {
    "ink": ("#1b1f24", "#e6e9ed"),
    "secondary": ("#4a525c", "#b3bac3"),
    "muted": ("#6b737d", "#8a929c"),
    "border": ("#c4cad1", "#3a4048"),
    "rule": ("#e9ecef", "#23272c"),
}


def palette(name):
    """Furo colors: the brand is the theme's vertex color, pages its background, and panels the
    fill a diagram's groups take."""
    theme, dark = THEMES[name], name == "dark"
    n = {role: pair[dark] for role, pair in NEUTRAL.items()}
    brand, panel = theme["vertex"]["color"], theme["diagram"]["group"]
    return {
        "color-brand-primary": brand,
        "color-brand-content": brand,
        "color-brand-visited": brand,
        "color-foreground-primary": n["ink"],
        "color-foreground-secondary": n["secondary"],
        "color-foreground-muted": n["muted"],
        "color-foreground-border": n["border"],
        "color-background-primary": theme["background"],
        "color-background-secondary": panel,
        "color-background-border": n["rule"],
        "color-api-name": n["ink"],
        "color-api-pre-name": n["secondary"],
        "color-code-background": panel,
        "color-inline-code-background": panel,
        "color-selected": theme["focus"]["selected"],
    }


GITHUB = (
    '<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 0C3.58 0 0 '
    "3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53"
    "-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21"
    " 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08"
    "-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04"
    " 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29"
    ".25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42"
    '-3.58-8-8-8z"/></svg>'
)

html_theme = "furo"
html_title = "latkit"
pygments_style = "github-light"
pygments_dark_style = "github-dark"
html_static_path = ["_static"]
html_favicon = "_static/favicon.svg"
html_css_files = ["custom.css"]
html_theme_options = {
    "light_css_variables": palette("light"),
    "dark_css_variables": palette("dark"),
    "light_logo": "logo.svg",
    "dark_logo": "logo-dark.svg",
    "top_of_page_buttons": [],
    "footer_icons": [
        {"name": "GitHub", "url": "https://github.com/lukelowry/latkit", "html": GITHUB}
    ],
}
