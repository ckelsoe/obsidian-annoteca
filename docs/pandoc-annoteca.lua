-- Pandoc Lua filter for Annoteca markers.
--
-- Behavior:
--   * `<!-- annoteca/index-entry: <term> -->` markers are converted to
--     LaTeX `\index{<term>}` commands so the document's printed index
--     populates from in-vault annotations (F-260).
--   * Every other `<!-- annoteca/<category>: ... -->` marker is stripped
--     so revision-time annotations do not surface in published output.
--
-- Usage:
--   pandoc --lua-filter=pandoc-annoteca.lua input.md -o output.tex
--
-- The filter operates on RawInline and RawBlock nodes (Pandoc represents
-- HTML comments as raw HTML), so it works with any output format. The
-- index-to-\index{} substitution only emits LaTeX in LaTeX-targeted
-- formats; other formats receive a plain-text fallback.

local ANNOTECA_RE = "^%s*<!%-%-%s*annoteca/([%a][%w%-]*)%s*:%s*(.-)%s*%-%->%s*$"

local function format_index_term(body)
  -- Strip any "— rest of body" tail emitted by the modal template.
  local dash = body:find(" %- %- ", 1, true) or body:find(" — ", 1, true)
  local head = dash and body:sub(1, dash - 1) or body
  head = head:gsub("^%s+", ""):gsub("%s+$", "")
  -- A `term > subterm` chain maps to LaTeX `\index{term!subterm}`.
  return (head:gsub(" > ", "!"))
end

local function rewrite_raw(node, ctor)
  if not (node.format == "html" or node.format == "html5" or node.format == "html4") then
    return nil
  end
  local category, body = string.match(node.text, ANNOTECA_RE)
  if not category then return nil end

  if category == "index-entry" then
    if FORMAT == "latex" or FORMAT == "beamer" then
      local term = format_index_term(body)
      return ctor("\\index{" .. term .. "}", "tex")
    else
      return ctor("", node.format)
    end
  end

  -- All other Annoteca markers are stripped from published output.
  return ctor("", node.format)
end

function RawInline(node)
  return rewrite_raw(node, pandoc.RawInline)
end

function RawBlock(node)
  return rewrite_raw(node, pandoc.RawBlock)
end
