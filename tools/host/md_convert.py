#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 Markdown 转成 Word(.docx) 和/或 PDF。

写给「管理员私聊里的小鲸鱼」用的：这台电脑上没装 pandoc（GitHub 被墙，
winget 下不动），所以就地用 Python + Edge 拼一条能用的路：
  · .docx —— markdown 解析成 HTML，再按标签走一遍，用 python-docx 写
  · .pdf  —— markdown -> HTML（带中文字体样式）-> Edge 无头模式打印成 PDF

用法：
    python md_convert.py 输入.md
    python md_convert.py 输入.md --to docx
    python md_convert.py 输入.md --out-dir "<输出目录>" --name 原理图
"""

from __future__ import annotations

import argparse
import html as html_mod
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

# 说明：这里**不再**调用任何外部程序。曾经试过用 Edge 无头打印 HTML，
# 但这台机器上 Edge 被桥接/沙箱拉起来时要么卡死、要么 exit 21 不产文件，
# 所以 PDF 改由 reportlab 在进程内排版（见 write_pdf）。

CSS = """
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Microsoft YaHei", "微软雅黑", "SimSun", sans-serif;
       font-size: 11pt; line-height: 1.7; color: #1a1a1a; }
h1 { font-size: 20pt; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
h2 { font-size: 16pt; border-bottom: 1px solid #eee; padding-bottom: 4px; }
h3 { font-size: 13.5pt; }
h4, h5, h6 { font-size: 12pt; }
code { font-family: Consolas, "Courier New", monospace; background: #f5f5f5;
       padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
pre { background: #f7f7f7; border: 1px solid #e5e5e5; border-radius: 5px;
      padding: 10px 12px; overflow-x: auto; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d0d0d0; margin: 8px 0; padding: 2px 12px;
             color: #555; background: #fafafa; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 10pt; }
th, td { border: 1px solid #ccc; padding: 6px 9px; text-align: left; }
th { background: #f0f0f0; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #ddd; margin: 16px 0; }
"""


def render_html(md_text: str, title: str) -> str:
    import markdown  # noqa: PLC0415

    body = markdown.markdown(
        md_text,
        extensions=["extra", "tables", "fenced_code", "sane_lists", "toc"],
    )
    return (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<title>{html_mod.escape(title)}</title><style>{CSS}</style></head>"
        f"<body>{body}</body></html>"
    )


# --------------------------------------------------------------------------- #
# HTML -> docx
# --------------------------------------------------------------------------- #
class _DocxBuilder(HTMLParser):
    """把渲染出来的 HTML 走一遍，写进 python-docx。

    只用得到 markdown 库产出的那几种标签，所以这里刻意写得很窄 ——
    宁可漏掉冷门标签，也不要把结构猜错。
    """

    INLINE = {"strong": "bold", "b": "bold", "em": "italic", "i": "italic",
              "code": "code", "del": "strike"}

    def __init__(self, doc) -> None:
        super().__init__(convert_charrefs=True)
        self.doc = doc
        self.mode = "p"          # p / h1..h6 / li / pre / td / th / blockquote
        self.buffer: list[tuple[str, str]] = []
        self.list_stack: list[str] = []
        self.li_counter: list[int] = []
        self.table_rows: list[list[str]] = []
        self.row: list[str] = []
        self.in_table = False
        self.in_cell = False
        self.skip_depth = 0
        self.pre_depth = 0

    # -- helpers ------------------------------------------------------------ #
    def _flush(self) -> None:
        # 在 <td>/<th> 里不要抢着 flush —— 单元格的文字由 </td> 自己收，
        # 否则 <td><p>x</p></td> 会先被当成一个普通段落、再补一个空单元格。
        if self.in_cell:
            return
        text = "".join(t for _, t in self.buffer).strip("\n")
        styles = {s for _, s in self.buffer}
        self.buffer.clear()
        if not text and self.mode not in ("pre",):
            return
        doc = self.doc
        mode = self.mode
        if self.in_table:
            self.row.append(text)
            return
        if mode.startswith("h") and mode[1:].isdigit():
            doc.add_heading(text, level=int(mode[1]))
            return
        if mode == "li":
            style = "List Number" if self.list_stack and self.list_stack[-1] == "ol" else "List Bullet"
            para = doc.add_paragraph(style=style)
            self._runs(para, text, styles)
            return
        if mode == "pre":
            para = doc.add_paragraph()
            run = para.add_run(text)
            run.font.name = "Consolas"
            run.font.size = None
            return
        if mode == "blockquote":
            para = doc.add_paragraph()
            para.paragraph_format.left_indent = None
            self._runs(para, text, styles)
            return
        para = doc.add_paragraph()
        self._runs(para, text, styles)

    @staticmethod
    def _runs(para, text: str, styles: set[str]) -> None:
        run = para.add_run(text)
        if "bold" in styles:
            run.bold = True
        if "italic" in styles:
            run.italic = True
        if "code" in styles:
            run.font.name = "Consolas"
        if "strike" in styles:
            run.font.strike = True

    # -- parser hooks ------------------------------------------------------- #
    def handle_starttag(self, tag, attrs):
        # <head> 里的东西（title / style / script）不是正文，整段跳过 ——
        # 否则文档第一段会变成文件名、第二段变成 CSS。
        if tag in ("head", "title", "style", "script"):
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.INLINE:
            self.buffer.append((tag, self.INLINE[tag]))
            return
        if tag == "br":
            self.buffer.append(("br", ""))
            return
        if tag == "pre":
            self._flush()
            self.pre_depth += 1
            self.mode = "pre"
            return
        if tag in ("ul", "ol"):
            self._flush()
            self.list_stack.append(tag)
            self.li_counter.append(0)
            return
        if tag == "li":
            self._flush()
            if self.list_stack and self.list_stack[-1] == "ol":
                self.li_counter[-1] += 1
            self.mode = "li"
            return
        if tag == "table":
            self._flush()
            self.in_table = True
            self.table_rows = []
            return
        if tag == "tr":
            self.row = []
            return
        if tag in ("td", "th"):
            self.in_cell = True
            self.row_is_header = tag == "th"
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.mode = tag
            return
        if tag == "blockquote":
            self._flush()
            self.mode = "blockquote"
            return
        if tag in ("p", "div"):
            self._flush()
            if not self.in_table:
                self.mode = "p"
            return
        if tag == "hr":
            self._flush()
            self.doc.add_paragraph("─" * 30)
            return

    def handle_endtag(self, tag):
        if tag in ("head", "title", "style", "script"):
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        if tag in self.INLINE:
            for i in range(len(self.buffer) - 1, -1, -1):
                if self.buffer[i][1] == self.INLINE[tag]:
                    self.buffer.pop(i)
                    break
            return
        if tag == "pre":
            self.pre_depth = max(0, self.pre_depth - 1)
            self._flush()
            self.mode = "p"
            return
        if tag in ("ul", "ol"):
            self._flush()
            if self.list_stack:
                self.list_stack.pop()
                self.li_counter.pop()
            self.mode = "p"
            return
        if tag == "li":
            self._flush()
            self.mode = "p"
            return
        if tag in ("td", "th"):
            self.in_cell = False
            text = "".join(t for _, t in self.buffer).strip("\n")
            self.buffer.clear()
            self.row.append(text)
            self.mode = "p"
            return
        if tag == "tr":
            self.table_rows.append(self.row)
            self.row = []
            return
        if tag == "table":
            self._write_table()
            self.in_table = False
            self.mode = "p"
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "div"):
            self._flush()
            self.mode = "p"
            return

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.pre_depth and self.mode != "pre":
            self.mode = "pre"
        self.buffer.append(("text", data.replace("\u00a0", " ") if data else data))

    def _write_table(self) -> None:
        rows = [r for r in self.table_rows if r]
        if not rows:
            return
        width = max(len(r) for r in rows)
        table = self.doc.add_table(rows=0, cols=width)
        table.style = "Table Grid"
        for r in rows:
            cells = table.add_row().cells
            for i in range(width):
                cells[i].text = r[i] if i < len(r) else ""


def write_docx(html_text: str, out_path: Path) -> None:
    import docx  # noqa: PLC0415

    doc = docx.Document()
    style = doc.styles["Normal"]
    style.font.name = "微软雅黑"
    from docx.oxml.ns import qn  # noqa: PLC0415

    style.element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
    parser = _DocxBuilder(doc)
    parser.feed(html_text)
    parser._flush()
    doc.save(str(out_path))


# --------------------------------------------------------------------------- #
# HTML -> pdf（reportlab，不依赖任何外部程序）
# --------------------------------------------------------------------------- #
# 为什么不用 Edge 无头：这台机器上 Edge 被桥接/沙箱拉起来时要么卡住不退出，
# 要么 exit 21 一个字节都不产（实测三种参数组合全失败），根本没法当构件用。
# reportlab 是纯 Python，进程内出文件，最稳。
def _register_fonts() -> tuple[str, str, str]:
    """返回 (正文字体, 粗体名, 等宽字体名)。优先系统雅黑，退路是 reportlab 自带中文 CID 字体。"""
    from reportlab.pdfbase import pdfmetrics  # noqa: PLC0415
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont  # noqa: PLC0415
    from reportlab.pdfbase.ttfonts import TTFont  # noqa: PLC0415

    base, heavy, mono = "STSong-Light", "STSong-Light", "Courier"
    try:
        regular = r"C:\Windows\Fonts\msyh.ttc"
        bold_ttc = r"C:\Windows\Fonts\msyhbd.ttc"
        consolas = r"C:\Windows\Fonts\consola.ttf"
        if os.path.isfile(regular):
            pdfmetrics.registerFont(TTFont("YaHei", regular, subfontIndex=0))
            base = "YaHei"
        if os.path.isfile(bold_ttc):
            pdfmetrics.registerFont(TTFont("YaHei-Bold", bold_ttc, subfontIndex=0))
            heavy = "YaHei-Bold"
        elif base == "YaHei":
            heavy = "YaHei"
        if os.path.isfile(consolas):
            pdfmetrics.registerFont(TTFont("Mono", consolas))
            mono = "Mono"
    except Exception as exc:  # noqa: BLE001 —— 字体注册失败不能拦住出文档
        print(f"[!] 字体注册有点问题（继续用兜底字体）：{exc}", file=sys.stderr)
    if base == "STSong-Light":
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return base, heavy, mono


class _PdfBlocks(HTMLParser):
    """给 PDF 用的 HTML -> 块列表解析器（与走到 docx 的那份互相独立，互不牵连）。"""

    INLINE = {"strong": "bold", "b": "bold", "em": "italic", "i": "italic",
              "code": "code", "del": "strike", "s": "strike", "strike": "strike"}
    SKIP = {"head", "title", "style", "script"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict] = []
        self.buf: list[tuple[str, frozenset[str]]] = []
        self.styles: set[str] = set()
        self.kind = "p"
        self.lists: list[str] = []
        self.counter: list[int] = []
        self.skip = 0
        self.rows: list[list[list[tuple[str, frozenset[str]]]]] = []
        self.row: list[list[tuple[str, frozenset[str]]]] = []
        self.in_cell = False

    def _flush(self) -> None:
        if self.in_cell:
            return
        runs, self.buf = self.buf, []
        if not any(t.strip() for t, _ in runs):
            return
        self.blocks.append({
            "kind": self.kind, "runs": runs,
            "ordered": bool(self.lists and self.lists[-1] == "ol"),
            "level": max(0, len(self.lists) - 1),
            "number": self.counter[-1] if self.counter else 0,
        })

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
            return
        if self.skip:
            return
        if tag in self.INLINE:
            self.styles.add(self.INLINE[tag])
        elif tag == "br":
            self.buf.append(("\n", frozenset()))
        elif tag == "pre":
            self._flush()
            self.kind = "pre"
        elif tag in ("ul", "ol"):
            self._flush()
            self.lists.append(tag)
            self.counter.append(0)
        elif tag == "li":
            self._flush()
            if self.lists and self.lists[-1] == "ol":
                self.counter[-1] += 1
            self.kind = "li"
        elif tag == "table":
            self._flush()
            self.rows = []
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.in_cell = True
            self.buf = []
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.kind = tag
        elif tag == "blockquote":
            self._flush()
            self.kind = "quote"
        elif tag == "hr":
            self._flush()
            self.blocks.append({"kind": "hr", "runs": []})
        elif tag in ("p", "div") and self.kind not in ("li", "pre"):
            self._flush()

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in self.INLINE:
            self.styles.discard(self.INLINE[tag])
        elif tag == "pre":
            runs, self.buf = self.buf, []
            text = "".join(t for t, _ in runs).strip("\n")
            if text:
                self.blocks.append({"kind": "pre", "runs": [(text, frozenset())],
                                    "ordered": False, "level": 0, "number": 0})
            self.kind = "p"
        elif tag in ("ul", "ol"):
            self._flush()
            if self.lists:
                self.lists.pop()
                self.counter.pop()
            self.kind = "p"
        elif tag == "li":
            self._flush()
            self.kind = "p"
        elif tag in ("td", "th"):
            self.in_cell = False
            self.row.append([r for r in self.buf if r[0].strip()])
            self.buf = []
        elif tag == "tr":
            if any(self.row):
                self.rows.append(self.row)
            self.row = []
        elif tag == "table":
            if self.rows:
                self.blocks.append({"kind": "table", "rows": self.rows})
            self.rows = []
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "div"):
            self._flush()
            self.kind = "p"

    def handle_data(self, data):
        if self.skip or not data:
            return
        self.buf.append((data.replace("\u00a0", " "), frozenset(self.styles)))

    def finish(self) -> list[dict]:
        self._flush()
        return self.blocks


def _markup(runs, base: str, heavy: str, mono: str) -> str:
    """runs -> reportlab 的 Paragraph 标记（它认 <b>/<i>/<font>/<br/>）。"""
    out: list[str] = []
    for text, styles in runs:
        piece = html_mod.escape(text).replace("\n", "<br/>")
        if "code" in styles:
            piece = f'<font name="{mono if text.isascii() else base}" size="9">{piece}</font>'
        elif "bold" in styles:
            piece = f'<font name="{heavy}">{piece}</font>'
        if "italic" in styles:
            piece = f"<i>{piece}</i>"
        if "strike" in styles:
            piece = f"<strike>{piece}</strike>"
        out.append(piece)
    return "".join(out) or "&nbsp;"


def write_pdf(html_text: str, out_path: Path, title: str = "") -> None:
    """HTML -> PDF，全部在这个进程里用 reportlab 排出来。"""
    from reportlab.lib import colors  # noqa: PLC0415
    from reportlab.lib.pagesizes import A4  # noqa: PLC0415
    from reportlab.lib.styles import ParagraphStyle  # noqa: PLC0415
    from reportlab.lib.units import mm  # noqa: PLC0415
    from reportlab.platypus import (  # noqa: PLC0415
        HRFlowable, ListFlowable, ListItem, Paragraph, Preformatted,
        SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    parser = _PdfBlocks()
    parser.feed(html_text)
    blocks = parser.finish()

    base, heavy, mono = _register_fonts()
    body = ParagraphStyle("body", fontName=base, fontSize=10.5, leading=17, spaceAfter=6)
    quote = ParagraphStyle("quote", parent=body, leftIndent=14,
                           textColor=colors.HexColor("#444444"))
    code = ParagraphStyle("code", parent=body, fontName=mono, fontSize=9, leading=13,
                          leftIndent=10, backColor=colors.HexColor("#f6f6f6"),
                          borderPadding=5, spaceBefore=4, spaceAfter=8)
    heads = {}
    for level, (size, gap) in enumerate(
            [(20, 12), (15.5, 9), (13, 7), (11.5, 6), (11, 5), (10.5, 5)], start=1):
        heads[f"h{level}"] = ParagraphStyle(
            f"h{level}", parent=body, fontName=heavy, fontSize=size,
            leading=size * 1.5, spaceBefore=gap, spaceAfter=gap * 0.5,
            textColor=colors.HexColor("#111111"))

    story: list = []
    for block in blocks:
        kind = block["kind"]
        if kind == "hr":
            story += [Spacer(1, 4),
                      HRFlowable(width="100%", color=colors.HexColor("#cccccc")),
                      Spacer(1, 6)]
            continue
        if kind == "table":
            grid = [[Paragraph(_markup(cell, base, heavy, mono), body) for cell in row]
                    for row in block["rows"]]
            width = max(len(r) for r in grid)
            for row in grid:
                while len(row) < width:
                    row.append(Paragraph("", body))
            table = Table(grid, hAlign="LEFT", repeatRows=1)
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c8c8c8")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story += [table, Spacer(1, 8)]
            continue
        if kind == "pre":
            text = block["runs"][0][0]
            style = code if text.isascii() else ParagraphStyle(
                "code-cjk", parent=code, fontName=base)
            story.append(Preformatted(text, style))
            continue
        if kind.startswith("h") and kind[1:].isdigit():
            story.append(Paragraph(_markup(block["runs"], base, heavy, mono),
                                   heads.get(kind, heads["h6"])))
            continue
        if kind == "li":
            indent = 16 * (block["level"] + 1)
            item = Paragraph(_markup(block["runs"], base, heavy, mono),
                             ParagraphStyle("li", parent=body, spaceAfter=2))
            ordered = block["ordered"]
            story.append(ListFlowable(
                [ListItem(item, leftIndent=indent)],
                bulletType="1" if ordered else "bullet",
                start=block["number"] if ordered else None,
                leftIndent=indent, bulletFontName=base, bulletFontSize=10.5,
                spaceBefore=1, spaceAfter=3))
            continue
        story.append(Paragraph(_markup(block["runs"], base, heavy, mono),
                               quote if kind == "quote" else body))

    if not story:
        story.append(Paragraph("（空文档）", body))

    doc = SimpleDocTemplate(
        str(out_path), pagesize=A4, title=title or out_path.stem, author="小鲸鱼",
        leftMargin=18 * mm, rightMargin=16 * mm,
        topMargin=17 * mm, bottomMargin=16 * mm)
    doc.build(story)
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("reportlab 没能写出 PDF")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Markdown -> Word / PDF（无需 pandoc）")
    ap.add_argument("input", help="输入 .md 文件")
    ap.add_argument("--to", default="docx,pdf", help="要产出哪些：docx,pdf（默认都要）")
    ap.add_argument("--out-dir", default="", help="输出目录（默认与输入同目录）")
    ap.add_argument("--name", default="", help="输出主文件名（默认与输入同名）")
    args = ap.parse_args(argv)

    src = Path(args.input).expanduser().resolve()
    if not src.is_file():
        print(f"[x] 找不到输入文件：{src}", file=sys.stderr)
        return 2
    wanted = {x.strip().lower() for x in args.to.split(",") if x.strip()}
    bad = wanted - {"docx", "pdf"}
    if bad:
        print(f"[x] --to 只认 docx / pdf，不认识：{', '.join(sorted(bad))}", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    base = args.name or src.stem

    md_text = src.read_text(encoding="utf-8", errors="replace")
    html_text = render_html(md_text, base)

    made: list[str] = []
    if "docx" in wanted:
        target = out_dir / f"{base}.docx"
        write_docx(html_text, target)
        made.append(str(target))
    if "pdf" in wanted:
        target = out_dir / f"{base}.pdf"
        write_pdf(html_text, target, base)
        made.append(str(target))

    for path in made:
        size = Path(path).stat().st_size
        print(f"[ok] {path}  ({size:,} 字节)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
