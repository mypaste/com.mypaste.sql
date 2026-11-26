# SQL Toolkit

MyPaste extension `com.mypaste.sql` (version `5.1.1`).

七种方言的 SQL 工作区，只在正文是 SQL 语句时出现：按 SQL Style Guide 美化（关键字大写、子句右对齐、可选目标行宽），编辑器高亮、语法问题列表与压缩都在页面内完成；解析不了的语句原样保留并标出位置，不执行 SQL、不联网；复制由宿主写入剪贴板。

同一个页面也是设置窗口里的 SQL 菜单页（`menus[]`）：没有条目时它开在编辑器上，粘贴或输入 SQL 即可开始，复制记成一条新记录。

This repository is an independent copy extracted from the former `mypaste-code-extensions` monorepo at commit `2af6675ab1473c9e38146ea0b6da68256a293440`. It contains only this extension's tracked source files. The published `.mypaste-plugin` archives and marketplace index live in [`mypaste-extensions-catalog`](https://github.com/mypaste/mypaste-extensions-catalog).

The manifest speaks MyPaste plugin protocol v3. Installation, capability mediation, and content-digest verification are performed by the MyPaste desktop host.

## Files

- `mypaste.plugin.json`: package identity and capability declaration.
- `run.sh`, `src/`, `panel.html`, or `run`: package implementation.

## Build

```bash
bun install
bun run build
```

The generated `preview.html` is intentionally ignored; edit `src/preview.html` and `src/main.ts` instead.

## Third-party

The page bundles [sqlriver](https://github.com/vinsidious/sqlriver) 2.0.0 (MIT,
Copyright (c) 2026 Casper Smith) for SQL parsing and layout. Its license text
sits in the head of `src/preview.html`, because the generated page is the whole
archive.

## License

MIT. See [LICENSE](LICENSE).
