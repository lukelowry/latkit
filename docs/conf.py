project = "latkit"
author = "Luke Lowery"
copyright = "2026, Luke Lowery"

extensions = ["myst_parser", "sphinx_copybutton"]
source_suffix = {".md": "markdown"}
exclude_patterns = ["_build"]

html_theme = "furo"
html_title = "latkit"

myst_enable_extensions = ["colon_fence", "deflist"]
myst_heading_anchors = 3

copybutton_prompt_text = r"^\$ "
copybutton_prompt_is_regexp = True
