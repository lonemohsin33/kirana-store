import type { PoolClient } from "pg";

export async function getDailySummary(client: PoolClient, dateStr: string) {
  const { rows: headerRows } = await client.query(
    `SELECT
       COUNT(*) AS bill_count,
       COALESCE(SUM(grand_total), 0) AS total_sales,
       COALESCE(SUM(total_cgst), 0) AS total_cgst,
       COALESCE(SUM(total_sgst), 0) AS total_sgst
     FROM bills
     WHERE status = 'finalized' AND finalized_at::date = $1::date`,
    [dateStr]
  );
  const { rows: byPaymentMode } = await client.query(
    `SELECT payment_mode, COALESCE(SUM(grand_total), 0) AS total
     FROM bills
     WHERE status = 'finalized' AND finalized_at::date = $1::date
     GROUP BY payment_mode`,
    [dateStr]
  );
  const { rows: topItems } = await client.query(
    `SELECT p.sku_name, SUM(bli.qty) AS qty_sold, SUM(bli.line_total) AS revenue
     FROM bill_line_items bli
     JOIN bills b ON b.id = bli.bill_id
     JOIN products p ON p.id = bli.product_id
     WHERE b.status = 'finalized' AND b.finalized_at::date = $1::date
     GROUP BY p.sku_name
     ORDER BY revenue DESC
     LIMIT 10`,
    [dateStr]
  );
  const header = headerRows[0];
  return {
    date: dateStr,
    billCount: header.bill_count,
    totalSales: header.total_sales,
    totalCgst: header.total_cgst,
    totalSgst: header.total_sgst,
    byPaymentMode,
    topItems,
  };
}

export async function getSalesSeries(client: PoolClient, days: number) {
  const { rows } = await client.query(
    `SELECT finalized_at::date AS day,
            COALESCE(SUM(grand_total), 0) AS total_sales,
            COALESCE(SUM(total_cgst), 0) AS total_cgst,
            COALESCE(SUM(total_sgst), 0) AS total_sgst
     FROM bills
     WHERE status = 'finalized' AND finalized_at >= now() - make_interval(days => $1)
     GROUP BY day
     ORDER BY day`,
    [days]
  );
  return rows;
}

export async function getTopItems(client: PoolClient, days: number, limit = 8) {
  const { rows } = await client.query(
    `SELECT p.sku_name, SUM(bli.qty) AS qty_sold, SUM(bli.line_total) AS revenue
     FROM bill_line_items bli
     JOIN bills b ON b.id = bli.bill_id
     JOIN products p ON p.id = bli.product_id
     WHERE b.status = 'finalized' AND b.finalized_at >= now() - make_interval(days => $1)
     GROUP BY p.sku_name
     ORDER BY revenue DESC
     LIMIT $2`,
    [days, limit]
  );
  return rows;
}

export async function getStockHealth(client: PoolClient) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE stock_qty = 0) AS out_of_stock,
       COUNT(*) FILTER (WHERE stock_qty > 0 AND stock_qty <= reorder_level) AS low_stock,
       COUNT(*) FILTER (WHERE stock_qty > reorder_level) AS healthy
     FROM products
     WHERE is_active`
  );
  return rows[0];
}
