"""Tests of the tile layers' zoom filters: python3 -m unittest discover -s data_builder/tiles -p 'test_*.py'"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from layers import Zooms, layers  # noqa: E402


class ZoomsTest(unittest.TestCase):
    def test_range_ends_at_the_archives_last_zoom(self):
        zooms = Zooms(12)
        self.assertEqual(zooms.range(0, 7), ['all', ['>=', '$zoom', 0], ['<=', '$zoom', 7]])
        self.assertEqual(zooms.range(8), ['all', ['>=', '$zoom', 8], ['<=', '$zoom', 12]])
        self.assertEqual(zooms.range(10, 14), ['all', ['>=', '$zoom', 10], ['<=', '$zoom', 12]])
        self.assertIsNone(zooms.range(13))

    def test_overzoomed_layers_go_in_the_last_zoom(self):
        self.assertEqual(Zooms(15).overzoomed(17), ['all', ['>=', '$zoom', 15], ['<=', '$zoom', 15]])
        self.assertEqual(Zooms(18).overzoomed(17), ['all', ['>=', '$zoom', 17], ['<=', '$zoom', 18]])

    def test_feature_minzoom(self):
        self.assertEqual(
            Zooms(15).feature_minzoom(13),
            [
                'all',
                ['>=', '$zoom', 13],
                [
                    'any',
                    ['>=', '$zoom', 15],
                    ['all', ['==', '$zoom', 13], ['<=', 'minzoom', 13]],
                    ['all', ['==', '$zoom', 14], ['<=', 'minzoom', 14]],
                ],
            ],
        )

    def test_stations_past_each_zooms_threshold(self):
        self.assertEqual(
            Zooms(15).stations([7, 8]),
            [
                'any',
                ['all', ['==', '$zoom', 7], ['>', 'discr_iso', 3142.647]],
                ['all', ['==', '$zoom', 8], ['>', 'discr_iso', -2800.05]],
            ],
        )
        self.assertEqual(Zooms(7).stations([7, 8]), ['any', ['all', ['==', '$zoom', 7], ['>', 'discr_iso', 3142.647]]])
        self.assertIsNone(Zooms(6).stations([7, 8]))

    def test_railway_line_high_starts_at_the_last_zoom_at_most(self):
        line_filter = Zooms(10).railway_line_high()
        self.assertEqual(line_filter[1], ['all', ['>=', '$zoom', 7], ['<=', '$zoom', 10]])
        # from z12, then disused from z11, narrow gauge from z10, urban transit from z9
        starts = [line_filter[2][1]] + [clause[1] for clause in line_filter[2][3:6]]
        self.assertEqual(starts, [['>=', '$zoom', 10], ['>=', '$zoom', 10], ['>=', '$zoom', 10], ['>=', '$zoom', 9]])


class LayersTest(unittest.TestCase):
    def test_layers(self):
        for all_styles, count in ((False, 15), (True, 30)):
            archive = layers(15, all_styles)
            self.assertEqual(len(archive), count)
            self.assertEqual(len({layer.name for layer in archive}), count)
            for layer in archive:
                self.assertIsNotNone(layer.filter, layer.name)
                # a placeholder an f-string missed
                self.assertNotIn('{', layer.sql, layer.name)

    def test_layers_sharing_a_tile_layer_share_its_filter(self):
        filters = {}
        for layer in layers(15, all_styles=True):
            if layer.tile_layer:
                filters.setdefault(layer.tile_layer, []).append(layer.filter)
        self.assertEqual(list(filters), ['signals_signal_boxes'])
        first, second = filters['signals_signal_boxes']
        self.assertEqual(first, second)

    def test_layers_past_the_last_zoom_are_left_out(self):
        left_out = {layer.name for layer in layers(12) if layer.filter is None}
        self.assertEqual(
            left_out,
            {'standard_railway_platforms', 'standard_railway_grouped_stations', 'standard_railway_grouped_station_areas'},
        )


if __name__ == '__main__':
    unittest.main()
