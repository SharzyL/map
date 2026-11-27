"""Tests of render.py: python3 -m unittest discover -s data_builder/api-doc"""

import importlib.util
import re
import unittest
from pathlib import Path

HERE = Path(__file__).parent
API = HERE.parent.parent / 'src/worker/api'
DOC = (API / 'doc.md').read_text(encoding='utf-8')
TYPES = (API / 'types.ts').read_text(encoding='utf-8')
spec = importlib.util.spec_from_file_location('render', HERE / 'render.py')
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

SAMPLE = '''# API v1

The JSON API, with **railway** data.

## Conventions

- `GET` only.

## Japan

### `GET /api/v1/norikae/stations/{code}/timetables`

```
GET /api/v1/norikae/stations?q=渋谷
```

```json
{
  "code": "22715",
  "lat": 35.65,
  "osm": ["N1"],
  "yomi": null
}
```

| Param | Values |
| ----- | ------ |
| `q`   | text   |

See [Japan](#japan) & <b>this</b>.
'''


class RenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = render.render(SAMPLE)

    def test_title_and_description(self):
        self.assertIn('<title>API v1</title>', self.page)
        self.assertIn('<meta name="description" content="The JSON API, with railway data.">', self.page)
        self.assertIn('<link rel="canonical" href="https://map.shz.al/api/v1/doc">', self.page)

    def test_headings_have_githubs_ids_and_an_anchor(self):
        self.assertIn('<h2 id="japan"><a class="header-anchor" href="#japan"', self.page)
        self.assertIn('id="get-apiv1norikaestationscodetimetables"', self.page)

    def test_table_of_contents(self):
        toc = re.search(r'<nav class="toc".*?</nav>', self.page, re.S).group(0)
        # h2s, the endpoint under its section, without GET, breaking after slashes
        self.assertEqual(re.findall(r'href="#([^"]+)"', toc),
                         ['conventions', 'japan', 'get-apiv1norikaestationscodetimetables'])
        self.assertIn('<ol><li><a href="#get-apiv1norikaestationscodetimetables">/<wbr>api/<wbr>v1/<wbr>', toc)
        self.assertNotIn('>GET ', toc)
        self.assertIn('class="page has-toc"', self.page)
        # Too few headings for one
        self.assertNotIn('<nav class="toc"', render.render('# T\n\n## One\n\ntext\n'))

    def test_code_blocks_have_a_gutter_and_colors(self):
        blocks = re.findall(r'<div class="code-block"><span class="line-number-rows" aria-hidden="true">((?:<span></span>)*)</span>',
                            self.page)
        self.assertEqual([b.count('<span></span>') for b in blocks], [1, 6])
        # JSON keys, strings, numbers and null in GitHub's colors
        for token in ('nt', 's2', 'mf', 'kc'):
            self.assertRegex(self.page, rf'<span class="{token}">')
        self.assertIn('.code-block .s, ', self.page)
        self.assertIn('渋谷', self.page)

    def test_json_with_comments_is_highlighted_as_json(self):
        page = render.render('```jsonc\n{\n  "a": 1, // one\n}\n```\n')
        self.assertIn('<span class="nt">"a"</span>', page)
        self.assertIn('<span class="c1">// one</span>', page)

    def test_code_blocks_are_marked_with_their_language(self):
        self.assertEqual(re.findall(r'<pre><code(?: class="([^"]+)")?>', self.page), ['', 'language-json'])
        # A fence the Markdown cannot render as code fails the page
        with self.assertRaises(ValueError):
            render.render('- item\n\n  ```ts\n  type A = 1;\n\n  type B = 2;\n  ```\n')

    def test_tables_and_raw_html(self):
        self.assertIn('<table>', self.page)
        self.assertIn('<a href="#japan">Japan</a> &amp; <b>this</b>', self.page)

    def test_same_markdown_same_page(self):
        self.assertEqual(render.render(SAMPLE), self.page)


class FillTypesTest(unittest.TestCase):
    TYPES = '''// The header, left out
// @doc one
// What one is
export interface One {
  a: number;
}

export type Two = One;
// @doc three
export interface Three {
  b: string; // export stays inside
}
'''

    def test_placeholders_become_typescript_blocks(self):
        doc = '# T\n\n<!-- types: three -->\n\ntext\n\n<!-- types: one -->\n'
        self.assertEqual(render.fill_types(doc, self.TYPES), (
            '# T\n\n```ts\nexport interface Three {\n  b: string; // export stays inside\n}\n```\n\ntext\n\n'
            '```ts\n// What one is\ninterface One {\n  a: number;\n}\n\ntype Two = One;\n```\n'
        ).replace('export interface Three', 'interface Three'))

    def test_every_placeholder_and_section_matches_one(self):
        with self.assertRaisesRegex(ValueError, r"unknown: \['four'\]"):
            render.fill_types('<!-- types: one -->\n<!-- types: three -->\n<!-- types: four -->\n', self.TYPES)
        with self.assertRaisesRegex(ValueError, r"unused: \['three'\]"):
            render.fill_types('<!-- types: one -->\n', self.TYPES)
        with self.assertRaisesRegex(ValueError, 'two type sections named one'):
            render.fill_types('<!-- types: one -->\n', self.TYPES + '// @doc one\n')

    def test_the_api_doc_uses_every_section(self):
        doc = render.fill_types(DOC, TYPES)
        self.assertNotIn('<!-- types:', doc)
        self.assertIn('```ts\ninterface RoutesResponse {', doc)
        self.assertNotRegex(doc, r'^export ', doc)


class DocTest(unittest.TestCase):
    """The API's own doc"""

    @classmethod
    def setUpClass(cls):
        cls.page = render.render(render.fill_types(DOC, TYPES))

    def test_every_json_block_is_highlighted_without_errors(self):
        blocks = re.findall(r'<div class="code-block">.*?</div>', self.page, re.S)
        json_blocks = [b for b in blocks if re.search(r'<code class="language-jsonc?">', b)]
        self.assertGreater(len(json_blocks), 10)
        for block in json_blocks:
            self.assertNotIn('class="err"', block)
            self.assertIn('<span class="nt">', block)

    def test_every_link_in_the_page_has_its_target(self):
        ids = set(re.findall(r'\bid="([^"]+)"', self.page))
        targets = set(re.findall(r'href="#([^"]+)"', self.page))
        self.assertTrue(targets)
        self.assertEqual(targets - ids, set())

    def test_every_endpoint_is_in_the_table_of_contents(self):
        toc = re.search(r'<nav class="toc".*?</nav>', self.page, re.S).group(0)
        endpoints = re.findall(r'^### `GET (/api/v1/[^`]+)`', DOC, re.M)
        self.assertGreater(len(endpoints), 10)
        for endpoint in endpoints:
            self.assertIn(endpoint.replace('/', '/<wbr>'), toc)


if __name__ == '__main__':
    unittest.main()
