#!/usr/bin/env python3
import asyncio
import contextlib
import http.server
import socketserver
import threading
import unittest
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path.home() / '.cache/webmcp-chrome/chrome/linux-154.0.8035.0/chrome-linux64/chrome-wrapper'

FAKE_MODEL_CONTEXT = r'''(() => {
  const tools=[];
  window.__wmcpCalls=[];
  Object.defineProperty(document,'modelContext',{configurable:true,value:{
    async registerTool(tool){ tools.push(tool); },
    async getTools(){ return [...tools].sort((a,b)=>a.name.localeCompare(b.name)); },
    async executeTool(tool,jsonInput){
      const input=JSON.parse(jsonInput);
      window.__wmcpCalls.push({name:tool.name,input});
      return JSON.stringify(await tool.execute(input,{}));
    },
  }});
})()'''

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

@contextlib.contextmanager
def server():
    handler=lambda *args, **kwargs: Quiet(*args,directory=ROOT,**kwargs)
    with socketserver.TCPServer(('127.0.0.1',0),handler) as httpd:
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{httpd.server_address[1]}'
        finally:
            httpd.shutdown(); thread.join(timeout=3)

class HeadToHeadBrowser(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack=contextlib.ExitStack()
        self.base=self.stack.enter_context(server())
        self.pw=await async_playwright().start()
        self.browser=await self.pw.chromium.launch(executable_path=str(CHROME),headless=True)
        self.context=await self.browser.new_context()
        await self.context.add_init_script(FAKE_MODEL_CONTEXT)
        self.page=await self.context.new_page()
        self.errors=[]
        self.page.on('console',lambda m:self.errors.append(f'console:{m.type}:{m.text}') if m.type=='error' else None)
        self.page.on('pageerror',lambda e:self.errors.append(f'page:{e}'))
        await self.page.goto(self.base,wait_until='networkidle')

    async def asyncTearDown(self):
        await self.context.close(); await self.browser.close(); await self.pw.stop(); self.stack.close()

    async def test_tuned_classical_arm_produces_live_counters_without_canonical_mutation(self):
        section=self.page.get_by_test_id('head-to-head')
        await self.expect_count(section,1)
        self.assertIn('tuned', (await section.inner_text()).lower())
        self.assertIn('not a native agent', (await section.inner_text()).lower())
        await self.page.get_by_test_id('run-classical').click()
        await self.page.wait_for_function("document.querySelector('[data-testid=classical-status]').textContent.includes('RUNNING')")
        await self.page.keyboard.type('human typing probe',delay=2)
        await self.page.wait_for_function("document.querySelector('[data-testid=classical-status]').textContent.includes('COMPLETE')",timeout=30000)
        self.assertEqual(await self.page.get_by_test_id('classical-reach').inner_text(),'30 → 14,000 (Unrig)')
        self.assertEqual(await self.page.get_by_test_id('classical-turns').inner_text(),'2 · Unrig + one snapshot')
        self.assertEqual(await self.page.get_by_test_id('classical-undo').inner_text(),'340')
        self.assertGreater(int(await self.page.get_by_test_id('classical-lost').inner_text()),0)
        self.assertGreater(float((await self.page.get_by_test_id('classical-time').inner_text()).removesuffix(' ms')),0)
        self.assertEqual(await self.page.get_by_test_id('staged-count').inner_text(),'0')
        self.assertEqual(await self.page.get_by_test_id('written-count').inner_text(),'0')
        self.assertEqual(await self.page.get_by_test_id('state-version').inner_text(),'v0')
        self.assertEqual(await self.page.get_by_test_id('undo-depth').inner_text(),'0')
        receipt=await self.page.evaluate('window.headToHead.getClassicalReceipt()')
        self.assertEqual(list(receipt),['mode','status','initialRows','reachableRows','turnsToFind','matched','statusEdits','priceEdits','completedEdits','undoDepth','elapsedMs','lostKeystrokes'])
        self.assertEqual((receipt['matched'],receipt['statusEdits'],receipt['priceEdits'],receipt['completedEdits'],receipt['undoDepth']),(340,170,170,340,340))

    async def test_real_browser_owned_WebMCP_arm_waits_for_actual_human_apply(self):
        notes=self.page.get_by_test_id('human-notes')
        await notes.focus()
        await self.page.get_by_test_id('run-webmcp').click()
        await notes.type('typing stays here',delay=2)
        await self.page.wait_for_function("document.querySelector('[data-testid=webmcp-arm-status]').textContent.includes('READY FOR HUMAN RELEASE')")
        self.assertEqual(await self.page.get_by_test_id('webmcp-reach').inner_text(),'14,000 page-owned records')
        self.assertEqual(await self.page.get_by_test_id('webmcp-turns').inner_text(),'2 · summary + preview')
        self.assertEqual(await self.page.get_by_test_id('webmcp-undo').inner_text(),'READY FOR HUMAN RELEASE')
        self.assertEqual(await self.page.get_by_test_id('webmcp-lost').inner_text(),'0')
        self.assertEqual(await self.page.get_by_test_id('staged-count').inner_text(),'340')
        calls=await self.page.evaluate('window.__wmcpCalls')
        self.assertEqual([x['name'] for x in calls],['catalogue_summary','preview_supplier_policy','inspect_staged_changes'])
        await self.page.get_by_test_id('apply-changes').click()
        await self.page.wait_for_function("document.querySelector('[data-testid=webmcp-arm-status]').textContent.includes('COMPLETE')")
        self.assertEqual(await self.page.get_by_test_id('webmcp-undo').inner_text(),'1 (after human Apply)')
        self.assertEqual(await self.page.get_by_test_id('state-version').inner_text(),'v1')
        receipt=await self.page.evaluate('window.headToHead.getWebMcpReceipt()')
        self.assertEqual(list(receipt),['mode','status','pageOwnedRecords','turnsToFind','matched','inspected','stageElapsedMs','undoDepth','lostKeystrokes','nativeAgent'])
        self.assertEqual(receipt['nativeAgent'],'UNPROVEN')
        self.assertEqual(receipt['undoDepth'],1)
        self.assertEqual(self.errors,[])

    async def expect_count(self,locator,count):
        self.assertEqual(await locator.count(),count)

if __name__=='__main__':
    unittest.main()
