// Business analysis deck: PPTX with real, editable chart objects (not screenshots), built from
// DB aggregates only — never a model-provided number. Four slides: sales trend, top items,
// stock health, GST collected.

import PptxGenJS from "pptxgenjs";
import { withClient } from "../db/pool.ts";
import { getSalesSeries, getStockHealth, getTopItems } from "../db/queries/reporting.ts";

const OUT_DIR = "/tmp";

export async function generateAnalysisDeck(periodDays = 7): Promise<string> {
  const { series, topItems, stockHealth } = await withClient(async (client) => ({
    series: await getSalesSeries(client, periodDays),
    topItems: await getTopItems(client, periodDays),
    stockHealth: await getStockHealth(client),
  }));

  const path = `${OUT_DIR}/analysis_${periodDays}d.pptx`;
  await render(path, periodDays, series, topItems, stockHealth);
  return path;
}

async function render(path: string, periodDays: number, series: any[], topItems: any[], stockHealth: any): Promise<void> {
  const pres = new PptxGenJS();
  pres.defineLayout({ name: "WIDE", width: 10, height: 7.5 });
  pres.layout = "WIDE";

  const addTitle = (slide: PptxGenJS.Slide, text: string) => {
    slide.addText(text, { x: 0.4, y: 0.25, w: 9.2, h: 0.7, fontSize: 28, bold: true });
  };

  // Slide 1: sales trend
  {
    const slide = pres.addSlide();
    addTitle(slide, `Sales Trend — Last ${periodDays} Days`);
    const labels = series.length > 0 ? series.map((r) => String(r.day)) : ["No sales yet"];
    const values = series.length > 0 ? series.map((r) => Number(r.total_sales)) : [0];
    slide.addChart(
      pres.ChartType.line,
      [{ name: "Total Sales (Rs)", labels, values }],
      { x: 0.6, y: 1.2, w: 8.8, h: 5.5 }
    );
  }

  // Slide 2: top items
  {
    const slide = pres.addSlide();
    addTitle(slide, "Top Selling Items");
    const labels = topItems.length > 0 ? topItems.map((r) => r.sku_name) : ["No sales yet"];
    const values = topItems.length > 0 ? topItems.map((r) => Number(r.revenue)) : [0];
    slide.addChart(
      pres.ChartType.bar,
      [{ name: "Revenue (Rs)", labels, values }],
      { x: 0.6, y: 1.2, w: 8.8, h: 5.5, barDir: "bar", showLegend: false }
    );
  }

  // Slide 3: stock health
  {
    const slide = pres.addSlide();
    addTitle(slide, "Stock Health");
    slide.addChart(
      pres.ChartType.pie,
      [
        {
          name: "Products",
          labels: ["Healthy", "Low Stock", "Out of Stock"],
          values: [Number(stockHealth.healthy) || 0, Number(stockHealth.low_stock) || 0, Number(stockHealth.out_of_stock) || 0],
        },
      ],
      { x: 1.8, y: 1.2, w: 6.4, h: 5.5, showLegend: true, legendPos: "r" }
    );
  }

  // Slide 4: GST collected (CGST vs SGST, stacked column)
  {
    const slide = pres.addSlide();
    addTitle(slide, "GST Collected (CGST vs SGST)");
    const labels = series.length > 0 ? series.map((r) => String(r.day)) : ["No sales yet"];
    const cgst = series.length > 0 ? series.map((r) => Number(r.total_cgst)) : [0];
    const sgst = series.length > 0 ? series.map((r) => Number(r.total_sgst)) : [0];
    slide.addChart(
      pres.ChartType.bar,
      [
        { name: "CGST", labels, values: cgst },
        { name: "SGST", labels, values: sgst },
      ],
      { x: 0.6, y: 1.2, w: 8.8, h: 5.5, barDir: "col", barGrouping: "stacked", showLegend: true, legendPos: "b" }
    );
  }

  await pres.writeFile({ fileName: path });
}
