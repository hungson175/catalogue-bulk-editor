import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("CATALOGUE_UI_URL", "http://127.0.0.1:4173/")
CHROME = os.environ.get(
    "WEBMCP_CHROME",
    str(Path.home() / ".cache/webmcp-chrome/chrome/linux-154.0.8035.0/chrome-linux64/chrome-wrapper"),
)


class CatalogueUiJourney(unittest.TestCase):
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
        self.console_errors = []
        self.page_errors = []
        self.external_requests = []
        self.page.on(
            "console",
            lambda message: self.console_errors.append(message.text) if message.type == "error" else None,
        )
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.on(
            "request",
            lambda request: self.external_requests.append(request.url)
            if not request.url.startswith(BASE_URL)
            else None,
        )
        self.page.goto(BASE_URL)
        self.page.wait_for_load_state("networkidle")

    def tearDown(self):
        self.assertEqual(self.console_errors, [])
        self.assertEqual(self.page_errors, [])
        self.assertEqual(self.external_requests, [])
        self.context.close()

    def text(self, test_id):
        return self.page.get_by_test_id(test_id).inner_text()

    def counter_state(self):
        return {
            name: self.text(name)
            for name in ["state-version", "staged-count", "refusal-count", "undo-depth"]
        } | {"ledgerRows": self.page.get_by_test_id("ledger-row").count()}

    def test_first_click_and_real_30_row_paging(self):
        self.assertIn("14,000", self.text("total-records"))
        self.assertIn("30", self.text("dom-rows"))
        self.assertEqual(self.page.get_by_test_id("catalogue-body").locator("tr").count(), 30)
        self.assertIn("Fjord", self.page.get_by_test_id("task-input").input_value())
        self.assertIn("2026-06-01", self.page.get_by_test_id("task-input").input_value())
        first = self.page.get_by_test_id("catalogue-body").locator("tr").first.get_attribute("data-id")
        self.page.get_by_test_id("next-page").click()
        self.assertEqual(self.page.get_by_test_id("catalogue-body").locator("tr").count(), 30)
        second = self.page.get_by_test_id("catalogue-body").locator("tr").first.get_attribute("data-id")
        self.assertNotEqual(first, second)
        self.assertEqual(second, "record-00031")

    def test_unrig_creates_14000_real_rows_without_state_or_ledger_change(self):
        before = self.counter_state()
        toggle = self.page.get_by_test_id("unrig-toggle")
        self.assertTrue(toggle.is_visible())
        self.assertLess(toggle.bounding_box()["y"], 720)
        toggle.check()
        self.page.wait_for_function(
            "document.querySelectorAll('[data-testid=\"catalogue-body\"] tr').length === 14000"
        )
        self.assertEqual(self.page.get_by_test_id("catalogue-body").locator("tr").count(), 14_000)
        self.assertIn("14,000", self.text("dom-rows"))
        self.assertEqual(self.counter_state(), before)
        toggle.uncheck()
        self.page.wait_for_function(
            "document.querySelectorAll('[data-testid=\"catalogue-body\"] tr').length === 30"
        )
        self.assertEqual(self.counter_state(), before)
        self.assertIn("30", self.text("dom-rows"))

    def test_preview_refusal_native_apply_and_one_undo(self):
        first_row = self.page.get_by_test_id("catalogue-body").locator("tr").first
        self.assertIn("active", first_row.inner_text())
        self.page.get_by_test_id("preview-changes").click()
        self.page.wait_for_function(
            "document.querySelectorAll('[data-testid=\"diff-row\"]').length === 340"
        )
        self.assertEqual(self.page.get_by_test_id("diff-row").count(), 340)
        self.assertEqual(
            self.text("status"),
            "Preview staged 340 changes — 340 staged · 0 written. 170 discontinue, 170 discount. No records written.",
        )
        self.assertIn("340", self.text("staged-count"))
        self.assertIn("0", self.text("written-count"))
        first_diff = self.page.get_by_test_id("diff-row").first
        self.assertTrue(first_diff.get_attribute("data-id").startswith("record-"))
        self.assertIn("active", first_diff.inner_text())
        self.assertIn("discontinued", first_diff.inner_text())

        safety = self.page.get_by_test_id("prove-agent-cannot-apply")
        self.assertTrue(safety.is_enabled())
        safety.click()
        self.assertEqual(
            self.text("status"),
            "Refused: gesture_required — 0 written, 340 staged retained. Human gesture required.",
        )
        self.assertIn("1", self.text("refusal-count"))
        self.assertIn("340", self.text("staged-count"))

        self.page.get_by_test_id("apply-changes").click()
        self.assertEqual(
            self.text("status"),
            "Applied 340 records in 1 transaction (tx stage-0001) — 0 staged · 340 written. State v1, undo available.",
        )
        self.assertIn("0", self.text("staged-count"))
        self.assertIn("340", self.text("written-count"))
        self.assertIn("1", self.text("state-version"))
        self.assertIn("1", self.text("undo-depth"))
        self.assertIn("discontinued", first_row.inner_text())

        self.page.get_by_test_id("undo-transaction").click()
        self.assertEqual(
            self.text("status"),
            "Undone 340 records — state v2, 0 staged · 340 written, prices and status restored.",
        )
        self.assertIn("2", self.text("state-version"))
        self.assertIn("0", self.text("undo-depth"))
        self.assertIn("active", first_row.inner_text())

    def test_decline_is_whole_and_zero_write(self):
        self.page.get_by_test_id("preview-changes").click()
        self.page.wait_for_function(
            "document.querySelectorAll('[data-testid=\"diff-row\"]').length === 340"
        )
        self.page.get_by_test_id("decline-changes").click()
        self.assertEqual(self.text("status"), "Declined — 0 written, 340 discarded. 0 staged.")
        self.assertEqual(self.page.get_by_test_id("diff-row").count(), 0)
        self.assertIn("0", self.text("staged-count"))
        self.assertIn("0", self.text("written-count"))

    def test_cmd_k_is_four_registry_commands_and_keyboard_closes(self):
        trigger = self.page.get_by_test_id("command-trigger")
        trigger.click()
        dialog = self.page.get_by_test_id("command-palette")
        self.assertTrue(dialog.is_visible())
        items = self.page.get_by_test_id("command-item")
        self.assertEqual(items.count(), 4)
        names = [items.nth(index).get_attribute("data-command") for index in range(4)]
        self.assertEqual(
            names,
            [
                "catalogue_summary",
                "preview_supplier_policy",
                "inspect_staged_changes",
                "discard_staged_changes",
            ],
        )
        self.assertFalse(any(word in " ".join(names) for word in ["apply", "commit", "approve", "release"]))
        self.page.keyboard.press("Escape")
        self.assertFalse(dialog.is_visible())
        self.assertEqual(self.page.evaluate("document.activeElement.dataset.testid"), "command-trigger")
        self.page.keyboard.press("Control+k")
        self.assertTrue(dialog.is_visible())
        before = self.page.get_by_test_id("ledger-row").count()
        self.page.keyboard.press("Enter")
        self.assertFalse(dialog.is_visible())
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), before + 1)

    def test_keyless_callback_is_frozen_zero_write_registry_only(self):
        shape = self.page.evaluate(
            """() => ({
              frozen: Object.isFrozen(window.catalogueDemo),
              keys: Object.keys(window.catalogueDemo),
              before: document.querySelectorAll('[data-testid="ledger-row"]').length,
              response: window.catalogueDemo.runTool({name:'catalogue_summary', input:{}})
            })"""
        )
        self.assertTrue(shape["frozen"])
        self.assertEqual(shape["keys"], ["runTool", "getWatchMetrics"])
        metrics = self.page.evaluate("window.catalogueDemo.getWatchMetrics()")
        self.assertEqual(metrics, {"dom": 30, "staged": 0, "written": 0, "refusal": 0, "undo": 0})
        self.assertTrue(shape["response"]["result"]["ok"])
        frozen = self.page.evaluate(
            """() => {
              const x=window.catalogueDemo.runTool({name:'catalogue_summary',input:{}});
              return [Object.isFrozen(x),Object.isFrozen(x.result),Object.isFrozen(x.snapshot),Object.isFrozen(x.ledgerTail)];
            }"""
        )
        self.assertEqual(frozen, [True, True, True, True])
        ledger_before_unknown = self.page.get_by_test_id("ledger-row").count()
        for name in ["apply", "__proto__"]:
            with self.assertRaises(Exception):
                self.page.evaluate(
                    "name => window.catalogueDemo.runTool({name,input:{}})",
                    name,
                )
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), ledger_before_unknown)

        invalid = self.page.evaluate(
            """() => window.catalogueDemo.runTool({
              name:'preview_supplier_policy',
              input:{supplier:'',cutoff:'bad',discountPct:15}
            })"""
        )
        self.assertFalse(invalid["result"]["ok"])
        self.assertEqual(invalid["result"]["written"], 0)
        self.assertIn("invalid_input", self.text("status"))
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), ledger_before_unknown + 1)

        sequence = self.page.evaluate(
            """() => [
              ['catalogue_summary',{}],
              ['preview_supplier_policy',{supplier:'Fjord',cutoff:'2026-06-01',discountPct:15}],
              ['inspect_staged_changes',{offset:0,limit:30}],
              ['discard_staged_changes',{}]
            ].map(([name,input]) => window.catalogueDemo.runTool({name,input}).result.ok)"""
        )
        self.assertEqual(sequence, [True, True, True, True])

    def test_responsive_page_has_no_horizontal_document_overflow(self):
        self.page.screenshot(path="/tmp/entry-a-ui-1280.png", full_page=True)
        self.assertLessEqual(
            self.page.evaluate("document.documentElement.scrollWidth"),
            self.page.evaluate("window.innerWidth"),
        )
        mobile = self.browser.new_page(viewport={"width": 390, "height": 844})
        mobile.goto(BASE_URL)
        mobile.wait_for_load_state("networkidle")
        self.assertLessEqual(
            mobile.evaluate("document.documentElement.scrollWidth"), mobile.evaluate("window.innerWidth")
        )
        self.assertTrue(mobile.get_by_test_id("preview-changes").is_visible())
        self.assertTrue(mobile.get_by_test_id("unrig-toggle").is_visible())
        mobile.screenshot(path="/tmp/entry-a-ui-390.png", full_page=True)
        mobile.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
