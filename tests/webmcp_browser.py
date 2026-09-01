import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("CATALOGUE_UI_URL", "http://127.0.0.1:4173/")
CHROME = os.environ.get(
    "WEBMCP_CHROME",
    str(Path.home() / ".cache/webmcp-chrome/chrome/linux-154.0.8035.0/chrome-linux64/chrome-wrapper"),
)

FAKE_MODEL_CONTEXT = r"""
window.__wmcpProbe = {calls: [], executionCount: 0};
Object.defineProperty(document, 'modelContext', {
  configurable: true,
  value: {
    async registerTool(descriptor, options) {
      window.__wmcpProbe.calls.push({descriptor, options});
    },
    async getTools() {
      return window.__wmcpProbe.calls.map(({descriptor}) => descriptor);
    },
    async executeTool(tool, jsonInput) {
      window.__wmcpProbe.executionCount += 1;
      return tool.execute(JSON.parse(jsonInput), {signal: new AbortController().signal});
    }
  }
});
"""


class WebMcpBrowserContract(unittest.TestCase):
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
        self.context.add_init_script(FAKE_MODEL_CONTEXT)
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

    def test_exact_four_real_descriptors_register_with_one_private_lifecycle(self):
        self.page.wait_for_function("window.__wmcpProbe.calls.length === 4")
        shape = self.page.evaluate(
            """() => ({
              names: window.__wmcpProbe.calls.map(x => x.descriptor.name),
              keys: window.__wmcpProbe.calls.map(x => Object.keys(x.descriptor)),
              readOnly: window.__wmcpProbe.calls.map(x => x.descriptor.annotations.readOnlyHint),
              sameSignal: window.__wmcpProbe.calls.every(x => x.options.signal === window.__wmcpProbe.calls[0].options.signal),
              signalIsAbort: window.__wmcpProbe.calls[0].options.signal instanceof AbortSignal,
              status: document.querySelector('[data-testid="webmcp-status"]').textContent,
              state: document.querySelector('[data-testid="webmcp-status"]').dataset.state
            })"""
        )
        self.assertEqual(shape["names"], [
            "catalogue_summary", "preview_supplier_policy",
            "inspect_staged_changes", "discard_staged_changes",
        ])
        self.assertEqual(shape["readOnly"], [True, False, True, False])
        self.assertTrue(shape["sameSignal"])
        self.assertTrue(shape["signalIsAbort"])
        self.assertTrue(all(keys == ["name", "description", "inputSchema", "annotations", "execute"] for keys in shape["keys"]))
        self.assertEqual(shape["status"], "WebMCP: 4 catalogue tools ready")
        self.assertEqual(shape["state"], "registered")

    def test_browser_api_shape_executes_actual_preview_and_updates_ui_and_ledger(self):
        self.page.wait_for_function("window.__wmcpProbe.calls.length === 4")
        result = self.page.evaluate(
            """async () => {
              const tools = await document.modelContext.getTools();
              const tool = tools.find(({name}) => name === 'preview_supplier_policy');
              return document.modelContext.executeTool(tool, JSON.stringify({
                supplier:'Fjord', cutoff:'2026-06-01', discountPct:15
              }));
            }"""
        )
        self.assertEqual(result["result"]["staged"], 340)
        self.assertEqual(result["result"]["written"], 0)
        self.assertEqual(result["snapshot"]["stagedCount"], 340)
        self.assertEqual(result["ledgerTail"]["written"], 0)
        self.assertEqual(self.page.get_by_test_id("diff-row").count(), 340)
        self.assertIn("340", self.page.get_by_test_id("staged-count").inner_text())
        self.assertEqual(self.page.get_by_test_id("written-count").inner_text(), "0")
        self.assertEqual(self.page.get_by_test_id("ledger-row").count(), 5)
        self.assertTrue(all(
            "written:0" in self.page.get_by_test_id("ledger-row").nth(index).inner_text()
            for index in range(5)
        ))
        self.assertEqual(self.page.evaluate("window.__wmcpProbe.executionCount"), 1)

    def test_keyless_surface_adds_only_frozen_actual_metrics_and_no_human_capability(self):
        self.page.wait_for_function("window.__wmcpProbe.calls.length === 4")
        shape = self.page.evaluate(
            """() => {
              const metrics = window.catalogueDemo.getWatchMetrics();
              return {
                demoFrozen: Object.isFrozen(window.catalogueDemo),
                keys: Object.keys(window.catalogueDemo),
                metrics,
                metricsFrozen: Object.isFrozen(metrics),
                names: window.__wmcpProbe.calls.map(x => x.descriptor.name)
              };
            }"""
        )
        self.assertTrue(shape["demoFrozen"])
        self.assertEqual(shape["keys"], ["runTool", "getWatchMetrics"])
        self.assertEqual(shape["metrics"], {"dom": 30, "staged": 0, "written": 0, "refusal": 0, "undo": 0})
        self.assertTrue(shape["metricsFrozen"])
        self.assertFalse(any(word in " ".join(shape["names"]) for word in ["apply", "commit", "approve", "release", "undo", "human"]))

    def test_stock_local_page_without_trial_surface_fails_closed_but_ui_works(self):
        clean_context = self.browser.new_context(viewport={"width": 1280, "height": 720})
        clean_page = clean_context.new_page()
        clean_page.set_default_timeout(1_500)
        clean_page.goto(BASE_URL)
        clean_page.wait_for_load_state("networkidle")
        self.assertEqual(clean_page.get_by_test_id("webmcp-status").get_attribute("data-state"), "unsupported")
        self.assertEqual(
            clean_page.get_by_test_id("webmcp-status").inner_text(),
            "WebMCP unavailable here · keyless demo still works",
        )
        self.assertEqual(clean_page.get_by_test_id("catalogue-body").locator("tr").count(), 30)
        clean_page.get_by_test_id("preview-changes").click()
        self.assertEqual(clean_page.get_by_test_id("diff-row").count(), 340)
        clean_context.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
