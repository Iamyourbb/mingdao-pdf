import express from "express";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "20mb" }));

const REGION_RATIO = { x: 0.68, y: 0.92, w: 0.20, h: 0.05 };
const TARGET_FIELD_ID = process.env.TARGET_FIELD_ID;
const MINGDAO_APP_KEY = process.env.MINGDAO_APP_KEY;
const MINGDAO_SIGN    = process.env.MINGDAO_SIGN;
const MINGDAO_API     = "https://api.mingdao.com/v2/open/worksheet/editRow";

app.post("/extract", async (req, res) => {
  const { recordId, worksheetId, fileUrl } = req.body || {};
  if (!recordId || !worksheetId || !fileUrl)
    return res.status(400).json({ error: "缺少参数" });

  try {
    const pdfResp = await fetch(fileUrl);
    if (!pdfResp.ok) throw new Error(`下载PDF失败: ${pdfResp.status}`);
    const arrayBuffer = await pdfResp.arrayBuffer();

    const pdf  = await getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const page = await pdf.getPage(1);
    const vp   = page.getViewport({ scale: 1 });

    const rx0 = REGION_RATIO.x * vp.width;
    const ry0 = REGION_RATIO.y * vp.height;
    const rx1 = (REGION_RATIO.x + REGION_RATIO.w) * vp.width;
    const ry1 = (REGION_RATIO.y + REGION_RATIO.h) * vp.height;

    const content = await page.getTextContent();
    const lines = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [,,,, tx, ty] = item.transform;
      const topY = vp.height - ty;
      if (tx >= rx0 && tx <= rx1 && topY >= ry0 && topY <= ry1)
        lines.push({ text: item.str, x: tx, y: topY });
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    const text = lines.map(l => l.text).join(" ").trim() || "（未识别到文字）";

    const mdResp = await fetch(MINGDAO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: MINGDAO_APP_KEY,
        sign: MINGDAO_SIGN,
        worksheetId,
        rowId: recordId,
        controls: [{ controlId: TARGET_FIELD_ID, value: text }],
      }),
    });
    const mdResult = await mdResp.json();
    if (!mdResult.success) throw new Error(`明道云写入失败: ${JSON.stringify(mdResult)}`);

    return res.json({ success: true, text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));