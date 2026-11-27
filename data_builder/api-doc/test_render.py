"""Tests of render.py: python3 -m unittest discover -s data_builder/api-doc"""

import importlib.util
import re
import unittest
from pathlib import Path

HERE = Path(__file__).parent
DOC = HERE.parent.parent / 'public/api/v1/doc.md'
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

    def test_tables_and_raw_html(self):
        self.assertIn('<table>', self.page)
        self.assertIn('<a href="#japan">Japan</a> &amp; <b>this</b>', self.page)

    def test_same_markdown_same_page(self):
        self.assertEqual(render.render(SAMPLE), self.page)


class DocTest(unittest.TestCase):
    """The API's own doc"""

    @classmethod
    def setUpClass(cls):
        cls.page = render.render(DOC.read_text(encoding='utf-8'))

    def test_every_link_in_the_page_has_its_target(self):
        ids = set(re.findall(r'\bid="([^"]+)"', self.page))
        targets = set(re.findall(r'href="#([^"]+)"', self.page))
        self.assertTrue(targets)
        self.assertEqual(targets - ids, set())

    def test_every_endpoint_is_in_the_table_of_contents(self):
        toc = re.search(r'<nav class="toc".*?</nav>', self.page, re.S).group(0)
        endpoints = re.findall(r'^### `GET (/api/v1/[^`]+)`', DOC.read_text(encoding='utf-8'), re.M)
        self.assertGreater(len(endpoints), 10)
        for endpoint in endpoints:
            self.assertIn(endpoint.replace('/', '/<wbr>'), toc)


if __name__ == '__main__':
    unittest.main()
