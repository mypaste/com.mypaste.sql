# SQL Toolkit

MyPaste extension `com.mypaste.sql` (version `4.2.0`).

七种方言的 SQL 工作区：语法高亮、括号与子句顺序诊断、美化与压缩都在页面内完成，不执行 SQL、不联网；方言、关键字大小写与缩进随页面切换，长行默认自动换行，复制由宿主写入剪贴板。

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

## License

MIT. See [LICENSE](LICENSE).
