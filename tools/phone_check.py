"""Phone-size check of the web app via the Chrome DevTools Protocol: true mobile
emulation (390x844, DPR 2, touch), which the desktop app's browser pane and plain
headless Chrome (minimum ~500 px window) cannot do. Screenshots + a report of
anything wider than the screen (phones zoom the whole page out when that happens).

  .venv/bin/python tools/phone_check.py http://localhost:5173/ /tmp/ph ["js step" ...]

Each JS step runs after the previous screenshot, then another screenshot is taken."""
import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333


async def main(url, out, steps):
    prof = tempfile.mkdtemp()
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={prof}",
                             "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
                             "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        async with websockets.connect(ws_url, max_size=50_000_000) as ws:
            n = 0

            async def cmd(method, **params):
                nonlocal n
                n += 1
                my = n
                await ws.send(json.dumps({"id": my, "method": method, "params": params}))
                while True:
                    m = json.loads(await ws.recv())
                    if m.get("id") == my:
                        return m.get("result", m)

            await cmd("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=2, mobile=True)
            await cmd("Emulation.setTouchEmulationEnabled", enabled=True)
            await cmd("Emulation.setUserAgentOverride", userAgent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")
            await cmd("Page.enable")
            await cmd("Page.navigate", url=url)
            await asyncio.sleep(7)

            async def shot(i):
                r = await cmd("Page.captureScreenshot", format="png")
                open(f"{out}-{i}.png", "wb").write(base64.b64decode(r["data"]))
                # Report anything wider than the viewport
                r = await cmd("Runtime.evaluate", returnByValue=True, expression="""(() => {
                  const W = innerWidth; const bad = [];
                  for (const el of document.querySelectorAll('body *')) {
                    const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') continue;
                    const r = el.getBoundingClientRect(); if (!r.width) continue;
                    if (r.right > W + 1 || r.left < -1) bad.push((el.id ? '#' + el.id : el.className.toString().split(' ')[0] || el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
                  }
                  return {W, scrollW: document.documentElement.scrollWidth, bad: [...new Set(bad)].slice(0, 15)};
                })()""")
                print(i, json.dumps(r["result"]["value"]))

            await shot(0)
            for i, js in enumerate(steps, 1):
                await cmd("Runtime.evaluate", expression=js, awaitPromise=True)
                await asyncio.sleep(1.5)
                await shot(i)
    finally:
        proc.terminate()


asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3:]))
