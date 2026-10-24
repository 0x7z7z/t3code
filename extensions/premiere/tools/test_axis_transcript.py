import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from axis_transcript import extract_script, map_clips, reconcile, write_atomic


def document(text):
    return {"words": [{"word": word, "start": i, "end": i + 0.8, "clip": 0} for i, word in enumerate(text.split())]}


class MappingTests(unittest.TestCase):
    def test_source_in_trim_multiple_placements_and_speed(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = {"sentences": [{"words": [{"word": "cut", "start": 1, "end": 2.3},
                {"word": "Goku", "start": 2.5, "end": 3.5}, {"word": "end", "start": 4, "end": 5},
                {"word": "untimed"}]}]}
            (base / "vo.json").write_text(json.dumps(source))
            clips = [{"transcript": "vo.json", "sequenceStart": 10, "sequenceEnd": 14, "sourceIn": 2, "sourceOut": 4},
                     {"transcript": "vo.json", "sequenceStart": 0, "sourceIn": 4, "sourceOut": 4.5}]
            result = map_clips({"requestId": "job", "projectId": "project", "sequenceId": "sequence", "clips": clips}, base)
            self.assertEqual([w["word"] for w in result["words"]], ["end", "cut", "Goku"])
            self.assertAlmostEqual(result["words"][0]["end"], .5)
            self.assertEqual(result["words"][-1]["start"], 11)
            self.assertEqual(result["words"][-1]["end"], 13)
            self.assertEqual(result["metadata"]["untimedWordsOmitted"], 2)

    def test_invalid_ranges_and_nonfinite_times(self):
        for value in (-1, float("nan"), float("inf"), True):
            with self.assertRaises(ValueError):
                map_clips({"clips": [{"sequenceStart": value, "sourceIn": 0, "sourceOut": 2}]})
        with self.assertRaises(ValueError):
            map_clips({"clips": []})


class ReconciliationTests(unittest.TestCase):
    def test_anime_name_and_preserved_timings(self):
        original = document("The mighty freezer fights against Goku today")
        result = reconcile(original, "The mighty Frieza fights against Goku today")
        self.assertEqual(result["words"][2]["word"], "Frieza")
        self.assertEqual([(w["start"], w["end"]) for w in original["words"]], [(w["start"], w["end"]) for w in result["words"]])
        self.assertEqual(result["metadata"]["reconciliation"]["changedWords"], 1)

    def test_split_merge_stay_inside_original_span(self):
        for heard, script, expected in [("We see supersaiyan fight for us today", "We see Super Saiyan fight for us today", ["Super", "Saiyan"]),
                                       ("We see ka meha fight for us today", "We see Kamehameha fight for us today", ["Kamehameha"])]:
            result = reconcile(document(heard), script)
            self.assertEqual([w["word"] for w in result["words"]][2:2+len(expected)], expected)
            self.assertEqual(result["words"][2]["start"], 2)
            end = 2.8 if len(expected) == 2 else 3.8
            self.assertAlmostEqual(result["words"][1+len(expected)]["end"], end)

    def test_same_word_count_substitutions_preserve_individual_times(self):
        original = document("Today mighty freezer veggie fight for us again")
        original["words"][2]["end"] = 2.6
        result = reconcile(original, "Today mighty Frieza Vegeta fight for us again")
        self.assertEqual([w["word"] for w in result["words"]][2:4], ["Frieza", "Vegeta"])
        self.assertEqual([(w["start"], w["end"]) for w in result["words"]], [(w["start"], w["end"]) for w in original["words"]])

    def test_adlibs_script_only_sections_and_unrelated_script(self):
        original = document("We see Goku honestly fight for us today")
        result = reconcile(original, "TITLE We see Goku fight for us today END")
        self.assertEqual(result["words"], original["words"])
        unrelated = reconcile(original, "A recipe with apples flour and cream")
        self.assertFalse(unrelated["metadata"]["scriptChecked"])
        self.assertEqual(unrelated["words"], original["words"])

    def test_never_retimes_across_clips_or_long_pauses(self):
        for boundary in ("clip", "gap"):
            original = document("We see super sayan fight for us today")
            if boundary == "clip":
                original["words"][3]["clip"] = 1
            else:
                original["words"][3]["start"] = 3.7
            result = reconcile(original, "We see SuperSaiyan fight for us today")
            self.assertEqual(result["words"], original["words"])

    def test_docx_text_markdown_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            script = base / "script.docx"
            with zipfile.ZipFile(script, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Goku</w:t></w:r><w:r><w:t> fights</w:t></w:r></w:p></w:body></w:document>')
            self.assertEqual(extract_script(script), "Goku fights")
            markdown = base / "script.md"
            markdown.write_text("# Title\n**Frieza (FREE-zuh)** fights.")
            self.assertIn("Frieza  fights.", extract_script(markdown))
            write_atomic(base / "nested/out.json", {"words": []})
            self.assertEqual(json.loads((base / "nested/out.json").read_text()), {"words": []})
            self.assertFalse((base / "nested/out.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
