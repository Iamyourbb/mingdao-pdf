import express from "express";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "20mb" }));

const REGION_RATIO = { x: 0.62, y: 0.96, w: 0.25, h: 0.04 };

const getHeaders = () => ({
  "Content-Type": "application/json",
  "HAP-Appkey": process.env.MINGDAO_APP_KEY,
  "HAP-Sign": process.env.MINGDAO_SIGN,
});

app.post("/extract", async (req, res) => {
  const { recordId, worksheetId } = req.body || {};
  if (!recordId || !worksheetId)
    return res.status(400).json({ error: "缺少参数" });

  try {
    // 1. 用 V3 API 获取记录
    const rowResp = await fetch(
      `https://api.mingdao.com/v3/app/worksheets/${worksheetId}/rows/${recordId}`,
      { headers: getHeaders() }
    );
    const rowData = await rowResp.json();
    if (!rowData.success) throw new Error(`获取记录失败: ${JSON.stringify(rowData)}`);

    // 2. 取附件URL
    const fileFieldData = rowData.data?.Atta;
    if (!fileFieldData || fileFieldData === "" || (Array.isArray(fileFieldData) && fileFieldData.length === 0))
      throw new Error("附件字段为空");

    const files = Array.isArray(fileFieldData) ? fileFieldData : JSON.parse(fileFieldData);
    const fileUrl = files[0]?.DownloadUrl || files[0]?.downloadUrl || files[0]?.original_file_full_path;
    if (!fileUrl) throw new Error(`无法获取附件URL: ${JSON.stringify(files[0])}`);

    // 3. 下载PDF
    const pdfResp = await fetch(fileUrl);
    if (!pdfResp.ok) throw new Error(`下载PDF失败: ${pdfResp.status}`);
    const arrayBuffer = await pdfResp.arrayBuffer();

    // 4. 提取区域文字
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

    // 5. 写回明道云
    const mdResp = await fetch(
      `https://api.mingdao.com/v3/app/worksheets/${worksheetId}/rows/${recordId}`,
      {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({
          fields: [{ id: process.env.TARGET_FIELD_ID, value: text }]
        }),
      }
    );
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