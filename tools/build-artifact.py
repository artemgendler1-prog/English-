#!/usr/bin/env python3
"""Собирает урок в один HTML-файл для публикации артефактом.

Зачем: курс рассчитан на локальный сервер (python3 -m http.server), но с
телефона его не поднять. Артефакт — это один файл без внешних ресурсов,
поэтому CSS и движок инлайнятся, а ссылки на соседние файлы курса и
скачивание файла (в песочнице артефакта оно не работает) вырезаются.

    python3 tools/build-artifact.py lessons/0001-placement-test.html out.html
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def build(lesson_path: pathlib.Path) -> str:
    src = lesson_path.read_text(encoding="utf-8")
    css = (ROOT / "assets" / "course.css").read_text(encoding="utf-8")
    engine = (ROOT / "assets" / "engine.js").read_text(encoding="utf-8")

    title_match = re.search(r"<title>(.*?)</title>", src, re.S)
    title = title_match.group(1).strip() if title_match else lesson_path.stem

    body = src.split("<body>", 1)[1].rsplit("</body>", 1)[0]
    body = body.replace(
        '<script src="../assets/engine.js"></script>',
        "<script>\n" + engine + "\n</script>",
    )

    # Скачивание файла: песочница артефакта блокирует любые загрузки,
    # так что кнопка и её обработчик были бы мёртвыми.
    body = body.replace(
        "'<button class=\"btn\" id=\"dl\" type=\"button\">Скачать файлом</button>' +\n", ""
    )
    body = re.sub(
        r"\n\s*document\.getElementById\('dl'\)\.addEventListener\(.*?\n\s*\}\);\n",
        "\n",
        body,
        flags=re.S,
    )

    # Ссылки на соседние файлы курса: в артефакте их нет.
    body = re.sub(r"'<a class=\"btn\" href=\"\.\./[^']*</a>' \+\n\s*", "", body)
    body = re.sub(
        r"\n\s*h\.push\('<nav class=\"lesson-nav\">'.*?'</nav>'\);\n",
        "\n",
        body,
        flags=re.S,
    )

    return f"<title>{title}</title>\n<style>\n{css}\n</style>\n{body}"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1

    out = build(pathlib.Path(sys.argv[1]))
    pathlib.Path(sys.argv[2]).write_text(out, encoding="utf-8")

    leftovers = [
        marker
        for marker in ("<!doctype", "<link", "script src=", "href=\"../", "id=\"dl\"")
        if marker in out.lower()
    ]
    if leftovers:
        print("осталось лишнее:", leftovers)
        return 1

    print(f"{sys.argv[2]}: {len(out)} байт")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
