import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("CATALOGUE_UI_URL", "http://127.0.0.1:4173/")
CHROME = os.environ.get(
    "WEBMCP_CHROME",
    str(Path.home() / ".cache/webmcp-chrome/chrome/linux-154.0.8035.0/chrome-linux64/chrome-wrapper"),
)


class WatchModeBrowserJourney(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=CHROME, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 720})
        self.page = self.context.new_page()
        self.page.set_default_timeout(1_500)
        self.errors = []
        self.external = []
        self.page.on("console", lambda message: self.errors.append(message.text) if message.type == "error" else None)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.external.append(request.url) if not request.url.startswith(BASE_URL) else None)
        self.page.goto(BASE_URL)
        self.page.wait_for_load_state("networkidle")

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.external, [])
        self.context.close()

    def run_watch(self):
        self.page.locator("[data-watch-start]").click()
        self.page.wait_for_function("document.querySelector('[data-watch-state]').textContent === 'PASS'")

    def test_first_click_is_visible_honest_and_runs_actual_five_call_nine_row_composition(self):
        mount = self.page.get_by_test_id("watch-mode")
        self.assertTrue(mount.is_visible())
        self.assertIn("KEYLESS REPLAY · NOT A NATIVE AGENT", mount.inner_text())
        self.assertEqual(self.page.locator("[data-watch-step]").inner_text(), "0/5")
        self.assertEqual(self.page.locator("[data-watch-actual]").inner_text(), "No tool called yet.")
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), 0)
        self.assertEqual(self.page.get_by_test_id("state-version").inner_text(), "v0")
        self.run_watch()
        self.assertEqual(self.page.locator("[data-watch-step]").inner_text(), "5/5")
        self.assertIn('"outcome": "discarded"', self.page.locator("[data-watch-actual]").inner_text())
        cards = {
            card.get_attribute("data-metric-card"): card.locator("[data-metric-value]").inner_text()
            for card in self.page.locator("[data-metric-card]").all()
        }
        self.assertEqual(cards, {"dom": "30", "staged": "0", "written": "0", "refusal": "0", "undo": "0"})
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), 9)
        self.assertTrue(all("written:0" in self.page.get_by_test_id("ledger-row").nth(i).inner_text() for i in range(9)))
        self.assertEqual(self.page.get_by_test_id("state-version").inner_text(), "v0")
        self.assertEqual(self.page.get_by_test_id("undo-depth").inner_text(), "0")

    def test_existing_stage_is_reset_and_repeat_run_stays_zero_write(self):
        self.page.get_by_test_id("preview-changes").click()
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), 5)
        self.assertEqual(self.page.get_by_test_id("staged-count").inner_text(), "340")
        self.run_watch()
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), 14)
        self.assertEqual(self.page.get_by_test_id("staged-count").inner_text(), "0")
        self.assertEqual(self.page.get_by_test_id("written-count").inner_text(), "0")
        self.assertEqual(self.page.get_by_test_id("state-version").inner_text(), "v0")
        self.assertTrue(all(
            "written:0" in self.page.get_by_test_id("ledger-row").nth(i).inner_text()
            for i in range(14)
        ))


if __name__ == "__main__":
    unittest.main(verbosity=2)
