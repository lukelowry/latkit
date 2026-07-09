project = "Latkit"
author = "Luke Lowery"
copyright = "2026, Luke Lowery"

extensions = [
    "myst_parser",
    "sphinx_copybutton",
]

source_suffix = {
    ".md": "markdown",
}

exclude_patterns = [
    "_build",
    "Thumbs.db",
    ".DS_Store",
]

html_theme = "furo"
html_title = "Latkit"

myst_enable_extensions = [
    "colon_fence",
    "deflist",
    "substitution",
]
myst_heading_anchors = 3

copybutton_prompt_text = r"^\$ "
copybutton_prompt_is_regexp = True
