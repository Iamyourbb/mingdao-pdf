import express from "express";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "20mb" }));

const REGION_RATIO = { x: 0.68, y: 0.92, w: 0.20, h: 0.05 };
const TARGET_FIELD_ID = process.env.TARGET_FIELD_ID;
const FILE_FIELD_ID   = process.env.FILE_FIELD_ID;   // 图纸附件字段ID
const MINGDAO_APP_KEY = process.env.MINGDAO_APP_KEY;
const MINGDAO_SIGN    = process.env.MINGDAO_SIGN;
const MINGDAO_API     = "https://api.mingdao.com/v2/open/worksheet";

app.post("/extract", async (req, res) => {
  const { recordId, worksheetId } = req.body || {};
  if (!recordId || !worksheetId)
    return res.status(400).json({ error: "缺少参数" });

  try {
    // 1. 查询记录，获取附件URL
    const rowResp = await fetch(`${MINGDAO_API}/getRowByIdPost`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: MINGDAO_APP_KEY,
        sign: MINGDAO_SIGN,
        worksheetId,
        rowId: recordId,
      }),
    });
    const rowData = await rowResp.json();
    if (!rowData.success) throw new Error(`获取记录失败: ${JSON.stringify(rowData)}`);

    const fileField = rowData.data[FILE_FIELD_ID];
    if (!fileField || !fileField.length)
      throw new Error("附件字段为空");

    const files = typeof fileField === "string" ? JSON.parse(fileField) : fileField;
    const fileUrl = files[0]?.previewUrl || files[0]?.url || files[0]?.downloadUrl;
    if (!fileUrl) throw new Error("无法获取附件URL");

    // 2. 下载PDF
    const pdfResp = await fetch(fileUrl);
    if (!pdfResp.ok) throw new Error(`下载PDF失败: ${pdfResp.status}`);
    const arrayBuffer = await pdfResp.arrayBuffer();

    // 3. 提取区域文字
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

    // 4. 写回明道云
    const mdResp = await fetch(`${MINGDAO_API}/editRow`, {
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
    if (!mdResult.success) throw new Error(`写入失败: ${JSON.stringify(mdResult)}`);

    return res.json({ success: true, text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));