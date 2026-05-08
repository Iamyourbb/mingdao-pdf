// api/extract.js
// Vercel 云函数 - 从明道云PDF右下角工序信息提取文字并回写

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// ============================================================
// 📌 配置区 - 只需改这里
// ============================================================

// 右下角工序信息区域（根据图纸标题栏位置估算）
// x=68% 开始，宽20%，y=92% 开始，高5%
const REGION_RATIO = { x: 0.68, y: 0.92, w: 0.20, h: 0.05 };

// 明道云字段 ID（在明道云字段设置 → 字段说明里查到 fieldId）
const TARGET_FIELD_ID = process.env.TARGET_FIELD_ID;

// 明道云 API
const MINGDAO_APP_KEY = process.env.MINGDAO_APP_KEY;
const MINGDAO_SIGN    = process.env.MINGDAO_SIGN;
const MINGDAO_API     = "https://api.mingdao.com/v2/open/worksheet/editRow";

// ============================================================

export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST" });

  const { recordId, worksheetId, fileUrl } = req.body || {};
  if (!recordId || !worksheetId || !fileUrl) {
    return res.status(400).json({ error: "缺少 recordId / worksheetId / fileUrl" });
  }

  try {
    // 1. 下载 PDF
    const pdfResp = await fetch(fileUrl);
    if (!pdfResp.ok) throw new Error(`下载PDF失败: ${pdfResp.status}`);
    const arrayBuffer = await pdfResp.arrayBuffer();

    // 2. 解析 PDF，提取右下角区域文字
    const pdf  = await getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const page = await pdf.getPage(1);
    const vp   = page.getViewport({ scale: 1 });

    // 把比例坐标转成 PDF 点坐标
    const rx0 = REGION_RATIO.x * vp.width;
    const ry0 = REGION_RATIO.y * vp.height;
    const rx1 = (REGION_RATIO.x + REGION_RATIO.w) * vp.width;
    const ry1 = (REGION_RATIO.y + REGION_RATIO.h) * vp.height;

    const content = await page.getTextContent();
    const lines = [];

    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [,, , , tx, ty] = item.transform; // tx=x坐标, ty=y坐标（从底部算）
      // PDF坐标系 y 从底部开始，换算成从顶部
      const topY = vp.height - ty;
      if (tx >= rx0 && tx <= rx1 && topY >= ry0 && topY <= ry1) {
        lines.push({ text: item.str, x: tx, y: topY });
      }
    }

    // 按 y 排序（从上到下），同行按 x 排序
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    const text = lines.map(l => l.text).join(" ").trim() || "（未识别到文字）";

    // 3. 写回明道云
    const mdResp = await fetch(MINGDAO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: MINGDAO_APP_KEY,
        sign:   MINGDAO_SIGN,
        worksheetId,
        rowId: recordId,
        controls: [{ controlId: TARGET_FIELD_ID, value: text }],
      }),
    });
    const mdResult = await mdResp.json();
    if (!mdResult.success) throw new Error(`明道云写入失败: ${JSON.stringify(mdResult)}`);

    return res.status(200).json({ success: true, text });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}