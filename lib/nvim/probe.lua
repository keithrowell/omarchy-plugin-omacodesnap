-- OmaCodeSnap's Neovim probe: runs *inside* the target Neovim instance (via
-- `nvim --server <addr> --remote-expr`, see `lib/nvim-rpc.mjs`), asking
-- Neovim itself for its current visual selection and the exact colours it
-- is already rendering for it — `vim.treesitter.get_captures_at_pos()` for
-- the capture and `nvim_get_hl()` for the capture's resolved colour, the
-- same two calls Neovim's own highlighter uses. Nothing here re-implements
-- highlighting: this is a read-only query, never edits the buffer.
--
-- `_A` is the single JSON-decodable argument `lib/nvim-rpc.mjs` passes via
-- `luaeval(source, arg)` — currently unused (the probe always reports the
-- current visual selection, decided entirely from Neovim's own state) but
-- kept for a future request shape.
--
-- Returns a JSON string (`vim.fn.json_encode`), decoded by `lib/nvim-rpc.mjs`:
-- `{ hasSelection, filetype, filename, colorscheme, editorForeground,
--   startLine, endLine, lines: [[{text,color,bold,italic}]] }`.
-- `hasSelection: false` means no other field but `filetype`/`colorscheme`
-- is meaningful — the caller falls back to the Wayland primary selection.
-- Only the *code's own* colours come from here — the frame chrome/backdrop
-- stays Omarchy-theme-driven for every editor (docs/DEVELOPING.md), so this never
-- reports a background colour.

local function hex(n)
  if n == nil then return nil end
  return string.format("#%06x", n)
end

local function hl_style(name)
  local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  if not ok then return nil end
  return { fg = hex(hl.fg), bold = hl.bold == true, italic = hl.italic == true }
end

-- Smallest-range-wins, mirroring `lib/highlight/zed.mjs`'s precedence rule:
-- `get_captures_at_pos` returns every active capture at a position,
-- outermost first, so the *last* one is the most specific.
local function style_at(row, col)
  local ok, captures = pcall(vim.treesitter.get_captures_at_pos, 0, row, col)
  if not ok or #captures == 0 then return hl_style("Normal") or { fg = nil, bold = false, italic = false } end
  local capture = captures[#captures].capture
  return hl_style("@" .. capture) or hl_style("Normal") or { fg = nil, bold = false, italic = false }
end

-- One line's text sliced to `[fromCol, toCol]` (0-based, end-exclusive; `nil` = full line), spans merged like every other OmaCodeSnap highlighter.
local function line_spans(row, fromCol, toCol)
  local line = vim.api.nvim_buf_get_lines(0, row, row + 1, false)[1] or ""
  local from = fromCol or 0
  local to = toCol or #line
  local spans = {}
  for col = from, to - 1 do
    local ch = line:sub(col + 1, col + 1)
    -- `to` can land one past the line's last character — e.g. `v$` in
    -- charwise visual mode reports `getpos('.')`'s column as `#line + 1`
    -- (confirmed live: a selection ending on a short last line) — and
    -- `string.sub` past the end of the string returns "" rather than
    -- erroring. Skip it rather than recording a colour for a character
    -- that isn't there: an empty-text span next to real content on the
    -- same line fails the renderer's own invariant (empty text is only
    -- ever valid as a line's *sole* span).
    if ch ~= "" then
      local style = style_at(row, col)
      local last = spans[#spans]
      if last and last.color == style.fg and last.bold == style.bold and last.italic == style.italic then
        last.text = last.text .. ch
      else
        table.insert(spans, { text = ch, color = style.fg, bold = style.bold, italic = style.italic })
      end
    end
  end
  if #spans == 0 then
    table.insert(spans, { text = "", color = (hl_style("Normal") or {}).fg, bold = false, italic = false })
  end
  return spans
end

local function selection_range()
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then return nil end

  local anchor = vim.fn.getpos("v")
  local cursor = vim.fn.getpos(".")
  local a_line, a_col = anchor[2], anchor[3]
  local c_line, c_col = cursor[2], cursor[3]

  local start_line, start_col, end_line, end_col
  if a_line < c_line or (a_line == c_line and a_col <= c_col) then
    start_line, start_col, end_line, end_col = a_line, a_col, c_line, c_col
  else
    start_line, start_col, end_line, end_col = c_line, c_col, a_line, a_col
  end

  return { mode = mode, startLine = start_line, startCol = start_col, endLine = end_line, endCol = end_col }
end

local function main()
  local result = {
    filetype = vim.bo.filetype,
    colorscheme = vim.g.colors_name,
    -- `:t` (tail) — every other adapter's title shows a bare filename or a
    -- short project-relative path (Zed), never a full filesystem path; `:p`
    -- was a leftover from an earlier draft, and produced an absolute path
    -- long enough to need eliding in the frame's title bar.
    filename = vim.fn.expand("%:t"),
  }
  result.editorForeground = (hl_style("Normal") or {}).fg

  local sel = selection_range()
  if not sel then
    result.hasSelection = false
    return vim.fn.json_encode(result)
  end

  result.hasSelection = true
  result.startLine = sel.startLine
  result.endLine = sel.endLine

  local lines = {}
  for line = sel.startLine, sel.endLine do
    local row = line - 1 -- 0-based for the API
    if sel.mode == "V" then
      table.insert(lines, line_spans(row, nil, nil))
    elseif sel.mode == "v" then
      local from = (line == sel.startLine) and (sel.startCol - 1) or nil
      -- `endCol` is the cursor's own (inclusive) column; +1 makes the slice end-exclusive.
      local to = (line == sel.endLine) and sel.endCol or nil
      table.insert(lines, line_spans(row, from, to))
    else
      -- Block-wise (Ctrl-V): approximated as the same column range on
      -- every line, which is exact for a rectangular selection with no
      -- multi-byte characters before it — good enough for a code snippet,
      -- not attempting `virtualedit`/multi-byte column correction.
      local lo = math.min(sel.startCol, sel.endCol) - 1
      local hi = math.max(sel.startCol, sel.endCol)
      table.insert(lines, line_spans(row, lo, hi))
    end
  end
  result.lines = lines

  return vim.fn.json_encode(result)
end

return main()
