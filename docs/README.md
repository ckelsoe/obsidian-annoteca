# Docs

Companion assets that ship alongside the plugin but are not bundled into `main.js`.

## `pandoc-annoteca.lua`

A Pandoc Lua filter that handles Annoteca markers at export time:

- `<!-- annoteca/index-entry: <term> -->` becomes a LaTeX `\index{<term>}` when the output format is `latex` or `beamer`. A `term > subterm` chain becomes `\index{term!subterm}`. In other output formats the marker is dropped.
- Every other Annoteca marker is stripped from published output, so revision-time annotations never leak into the rendered document.

### Usage

```bash
pandoc --lua-filter=pandoc-annoteca.lua input.md -o output.tex
```

Combine with your usual citation, bibliography, and template flags. The filter only touches `RawInline` and `RawBlock` nodes that match the canonical Annoteca regex; everything else passes through unchanged.
