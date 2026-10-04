"""Static GUI contract checks; these do not claim browser/layout verification."""
import collections
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BASE = "ef88c643fe2332213d5ec81f6fa28d32a99f3ea6"


class Markup(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.ids = []
        self.references = []
        self.buttons = 0
        self.active = collections.Counter()
        self.nesting_errors = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        self.references.extend(attrs.get("aria-labelledby", "").split())
        if tag == "label" and "for" in attrs:
            self.references.append(attrs["for"])
        if tag in ("form", "label"):
            if self.active[tag]:
                self.nesting_errors.append(tag)
            self.active[tag] += 1
        if tag == "button":
            self.buttons += 1

    def handle_endtag(self, tag):
        if tag in ("form", "label"):
            self.active[tag] -= 1


class GuiContract(unittest.TestCase):
    def test_original_bindings_and_buttons_are_retained(self):
        for name in ("index.html", "chat-window.html"):
            with self.subTest(page=name):
                old = Markup(subprocess.check_output(
                    ["git", "show", f"{BASE}:{name}"], cwd=ROOT, text=True))
                new = Markup((ROOT / name).read_text())
                self.assertLessEqual(set(old.ids), set(new.ids))
                self.assertEqual(old.buttons, new.buttons)

    def test_unique_ids_and_resolvable_accessibility_references(self):
        for name in ("index.html", "chat-window.html"):
            with self.subTest(page=name):
                markup = Markup((ROOT / name).read_text())
                self.assertEqual(len(markup.ids), len(set(markup.ids)))
                self.assertLessEqual(set(markup.references), set(markup.ids))
                self.assertFalse(markup.nesting_errors)
                self.assertEqual(markup.active["form"], 0)
                self.assertEqual(markup.active["label"], 0)

    def test_css_braces_and_visibility_contract(self):
        css = (ROOT / "src/styles.css").read_text()
        lexical = re.sub(r"/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'", "", css, flags=re.S)
        depth = 0
        for char in lexical:
            depth += (char == "{") - (char == "}")
            self.assertGreaterEqual(depth, 0)
        self.assertEqual(depth, 0)
        self.assertRegex(css, r"\.hidden\s*\{[^}]*display:\s*none\s*!important")
        self.assertIn('#chat-panel.detached', css)
        self.assertIn('body[data-rust-window="main"] .chat-panel.collapsed .collapsible-body', css)
        self.assertIn('@media (max-width: 60rem)', css)
        self.assertIn('@media (max-width: 40rem)', css)
        self.assertIn('@media (prefers-reduced-motion: reduce)', css)

    def test_core_text_color_contrast(self):
        css = (ROOT / "src/styles.css").read_text()
        colors = dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;", css))
        def luminance(hex_color):
            rgb = [int(hex_color[i:i+2], 16)/255 for i in (1, 3, 5)]
            linear = [c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4 for c in rgb]
            return sum(a*b for a, b in zip(linear, (.2126, .7152, .0722)))
        for foreground, background in [("text-primary", "manuscript-bg"),
                                       ("text-secondary", "bg-secondary"),
                                       ("accent-text", "bg-secondary")]:
            values = sorted([luminance(colors[foreground]), luminance(colors[background])])
            self.assertGreaterEqual((values[1]+.05)/(values[0]+.05), 4.5)


if __name__ == "__main__":
    unittest.main()
